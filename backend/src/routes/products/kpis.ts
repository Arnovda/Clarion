/**
 * Products router (6/9): product KPIs (ai-draft, list, create, update,
 * delete) + AI-generated starter questions.
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { createProductKpiSchema, updateProductKpiSchema } from '../../middleware/schemas';
// tenantQuery removed — AI repair loops eliminated; deterministic auto-fix lives in transformationRunner
import { tenantQuery } from '../../services/tenantQuery';
import { reqDb } from '../../db/reqDb';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/products/:id/kpis/ai-draft — AI-assist for a KPI formula
//
// Body: { name: string; description?: string }
// Returns: { formulaSql, formulaPlainText, primaryTable, confidence, notes }
//
// The user types a name (and optionally a plain-English description) and
// gets a draft SQL formula grounded in this product's actual schema. They
// then review the draft, tweak if needed, and click Save to commit. Save
// is a separate request; this endpoint never persists. Trust-but-verify.
// ---------------------------------------------------------------------------

router.post('/:id/kpis/ai-draft', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    const { name, description } = req.body as { name: string; description?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'KPI name is required' });
      return;
    }

    const tenantId = req.user?.tenantId;
    const ctx = await tenantQuery(tenantId, async (trx) => {
      const product = await trx('data_products').where({ id: productId }).first();
      if (!product) return null;

      // Pull tables + columns + existing KPI names. Single transaction so
      // RLS context is consistent for every read.
      const tables = await trx('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where('ss.data_product_id', productId)
        .select('pt.id', 'pt.table_name', 'pt.table_role');

      const tableIds = tables.map((t) => Number(t.id));
      const columns = tableIds.length > 0
        ? await trx('product_columns')
            .whereIn('product_table_id', tableIds)
            .orderBy(['product_table_id', 'sort_order'])
            .select('product_table_id', 'column_name', 'data_type', 'column_role', 'description')
        : [];

      const existingKpis = await trx('product_kpis')
        .where({ data_product_id: productId })
        .pluck('name');

      const colsByTable = new Map<number, typeof columns>();
      for (const c of columns) {
        const list = colsByTable.get(Number(c.product_table_id)) ?? [];
        list.push(c);
        colsByTable.set(Number(c.product_table_id), list);
      }

      return {
        product,
        tables: tables.map((t) => ({
          tableName: t.table_name as string,
          tableRole: t.table_role as string,
          columns: (colsByTable.get(Number(t.id)) ?? []).map((c) => ({
            columnName: c.column_name as string,
            dataType:   c.data_type as string,
            columnRole: (c.column_role as string | null) ?? null,
            description: (c.description as string | null) ?? null,
          })),
        })),
        existingKpiNames: existingKpis,
      };
    });

    if (!ctx) {
      res.status(404).json({ ok: false, error: 'Product not found' });
      return;
    }
    if (ctx.tables.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'This product has no tables yet — design the schema first, then come back to add KPIs.',
      });
      return;
    }

    const { draftKpiFormula } = await import('../../ai/AIService');
    const result = await draftKpiFormula(
      {
        productName: ctx.product.name,
        productDescription: ctx.product.description ?? null,
        tables: ctx.tables,
        existingKpiNames: ctx.existingKpiNames as string[],
      },
      name.trim(),
      description ?? null,
    );

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/kpis — List KPIs
// ---------------------------------------------------------------------------

router.get('/:id/kpis', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const kpis = await tenantQuery(tenantId, (trx) =>
      trx('product_kpis').where({ data_product_id: req.params.id }).orderBy('name'),
    );
    res.json({ ok: true, data: kpis });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/starters — AI-generated starter questions
//
// Feeds the catalog preview's "Try asking" chips. Cached per (tenant,
// product) for 24h so opening the same preview many times in a row
// costs ~0 in tokens. Returns { starters: [] } if there's nothing to
// anchor on (no KPIs, no facts) — frontend falls back to its
// template-from-dimension-tables generator in that case.
// ---------------------------------------------------------------------------
router.get('/:id/starters', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const productId = Number(req.params.id);
    if (!tenantId || !Number.isFinite(productId)) {
      res.status(400).json({ ok: false, error: 'Invalid request' });
      return;
    }
    const { getProductStarters } = await import('../../services/queryStartersService');
    const result = await getProductStarters(tenantId, productId);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/kpis — Create a KPI
// Role widened to admin+analyst — analysts curate KPIs alongside admins
// (matches the role gating on /semantic confirms).
// ---------------------------------------------------------------------------

router.post('/:id/kpis', requireAuth, requireRole('admin', 'analyst'), validate(createProductKpiSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, description, formulaPlainText, formulaSql, ownerName, questionText } = req.body as {
      name: string; description?: string; formulaPlainText?: string;
      formulaSql?: string; ownerName?: string; questionText?: string;
    };

    const tenantId = req.user?.tenantId;
    const id = await tenantQuery(tenantId, async (trx) => {
      const [row] = await trx('product_kpis')
        .insert({
          data_product_id:    Number(req.params.id),
          name:               name.trim(),
          description:        description ?? null,
          formula_plain_text: formulaPlainText ?? null,
          formula_sql:        formulaSql ?? null,
          owner_name:         ownerName ?? null,
          question_text:      questionText ?? null,
          ai_draft:           false,
        })
        .returning('id');
      return typeof row === 'object' ? (row as { id: number }).id : (row as number);
    });
    res.json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/kpis/:kpiId — Update a KPI
// ---------------------------------------------------------------------------

router.put('/kpis/:kpiId', requireAuth, requireRole('admin', 'analyst'), validate(updateProductKpiSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const allowed = ['name', 'description', 'formula_plain_text', 'formula_sql', 'owner_name', 'question_text', 'ai_draft'];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const tenantId = req.user?.tenantId;
    await tenantQuery(tenantId, (trx) =>
      trx('product_kpis').where({ id: req.params.kpiId }).update(updates),
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/products/kpis/:kpiId — Delete a KPI
// ---------------------------------------------------------------------------

router.delete('/kpis/:kpiId', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    await tenantQuery(tenantId, (trx) =>
      trx('product_kpis').where({ id: req.params.kpiId }).delete(),
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});


export default router;
