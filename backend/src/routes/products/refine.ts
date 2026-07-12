/**
 * Products router (5/9): NL refine — cross-product refine, per-product
 * refine proposal, and apply.
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { refineProduct, refineProductCross } from '../../ai/AIService';
import { reqDb } from '../../db/reqDb';
import type {
  ProductSummary,
  RefineChange,
} from '../../ai/prompts/refineProductPrompt';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/products/refine — Cross-product refine (AI picks the target product)
// ---------------------------------------------------------------------------

router.post('/refine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { instruction } = req.body as { instruction: string };
    if (!instruction?.trim()) {
      res.status(400).json({ ok: false, error: 'instruction is required' });
      return;
    }

    const allProducts = await db('data_products').orderBy('name');
    if (allProducts.length === 0) {
      res.status(400).json({ ok: false, error: 'No data products exist yet.' });
      return;
    }

    const productIds = allProducts.map((p: { id: number }) => p.id);
    const allSchemas = await db('star_schemas').whereIn('data_product_id', productIds);
    const schemasByProduct = new Map<number, number[]>();
    for (const s of allSchemas) {
      const arr = schemasByProduct.get(s.data_product_id) ?? [];
      arr.push(s.id);
      schemasByProduct.set(s.data_product_id, arr);
    }

    const allSchemaIds = allSchemas.map((s: { id: number }) => s.id);
    const allTables = allSchemaIds.length
      ? await db('product_tables')
          .whereIn('star_schema_id', allSchemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];
    const tablesBySchema = new Map<number, typeof allTables>();
    for (const t of allTables) {
      const arr = tablesBySchema.get(t.star_schema_id) ?? [];
      arr.push(t);
      tablesBySchema.set(t.star_schema_id, arr);
    }

    const allTableIds = allTables.map((t: { id: number }) => t.id);
    const allColumns = allTableIds.length
      ? await db('product_columns')
          .whereIn('product_table_id', allTableIds)
          .andWhere((qb: any) => qb.where('is_technical', false).orWhereNull('is_technical'))
          .orderBy(['sort_order', 'id'])
      : [];
    const colsByTable = new Map<number, typeof allColumns>();
    for (const c of allColumns) {
      const arr = colsByTable.get(c.product_table_id) ?? [];
      arr.push(c);
      colsByTable.set(c.product_table_id, arr);
    }

    const allKpis = await db('product_kpis').whereIn('data_product_id', productIds).orderBy('name');
    const kpisByProduct = new Map<number, typeof allKpis>();
    for (const k of allKpis) {
      const arr = kpisByProduct.get(k.data_product_id) ?? [];
      arr.push(k);
      kpisByProduct.set(k.data_product_id, arr);
    }

    const summaries: ProductSummary[] = allProducts.map((product: any) => {
      const schemaIds = schemasByProduct.get(product.id) ?? [];
      const tables = schemaIds.flatMap((sid: number) => tablesBySchema.get(sid) ?? []);
      const kpis = kpisByProduct.get(product.id) ?? [];

      return {
        id:          product.id,
        name:        product.name,
        description: product.description ?? null,
        tables: tables.map((t: any) => ({
          id:          t.id,
          table_name:  t.table_name,
          table_role:  t.table_role ?? null,
          description: t.description ?? null,
          columns: (colsByTable.get(t.id) ?? []).map((c: any) => ({
            id:           c.id,
            column_name:  c.column_name,
            display_name: c.display_name ?? null,
            description:  c.description ?? null,
            data_type:    c.data_type ?? null,
            column_role:  c.column_role ?? null,
          })),
        })),
        kpis: kpis.map((k: any) => ({
          id:                  k.id,
          name:                k.name,
          description:         k.description ?? null,
          formula_plain_text:  k.formula_plain_text ?? null,
          formula_sql:         k.formula_sql ?? null,
        })),
      };
    });

    const proposal = await refineProductCross(summaries, instruction.trim());
    res.json({ ok: true, data: proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/refine — Propose metadata changes from NL instruction
// ---------------------------------------------------------------------------

router.post('/:id/refine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    const { instruction } = req.body as { instruction: string };
    if (!instruction?.trim()) {
      res.status(400).json({ ok: false, error: 'instruction is required' });
      return;
    }

    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await db('star_schemas').where({ data_product_id: productId });
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const tables = schemaIds.length
      ? await db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await db('product_columns')
          .whereIn('product_table_id', tableIds)
          // Refine prompts must not see technical columns.
          .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
          .orderBy(['sort_order', 'id'])
      : [];
    const kpis = await db('product_kpis')
      .where({ data_product_id: productId })
      .orderBy('name');

    const colsByTable = new Map<number, typeof columns>();
    for (const c of columns) {
      const arr = colsByTable.get(c.product_table_id) ?? [];
      arr.push(c);
      colsByTable.set(c.product_table_id, arr);
    }

    const summary: ProductSummary = {
      id:          product.id,
      name:        product.name,
      description: product.description ?? null,
      tables: tables.map((t: any) => ({
        id:          t.id,
        table_name:  t.table_name,
        table_role:  t.table_role ?? null,
        description: t.description ?? null,
        columns: (colsByTable.get(t.id) ?? []).map((c: any) => ({
          id:           c.id,
          column_name:  c.column_name,
          display_name: c.display_name ?? null,
          description:  c.description ?? null,
          data_type:    c.data_type ?? null,
          column_role:  c.column_role ?? null,
        })),
      })),
      kpis: kpis.map((k: any) => ({
        id:                  k.id,
        name:                k.name,
        description:         k.description ?? null,
        formula_plain_text:  k.formula_plain_text ?? null,
        formula_sql:         k.formula_sql ?? null,
      })),
    };

    const proposal = await refineProduct(summary, instruction.trim());
    res.json({ ok: true, data: proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/refine/apply — Apply a proposal's changes
// Body: { changes: RefineChange[] }
// Returns: { applied: number, skipped: Array<{ change, reason }>, notes: string[] }
// ---------------------------------------------------------------------------

router.post('/:id/refine/apply', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    const { changes } = req.body as { changes: RefineChange[] };
    if (!Array.isArray(changes)) {
      res.status(400).json({ ok: false, error: 'changes[] is required' });
      return;
    }

    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const now = new Date().toISOString();
    let applied = 0;
    const skipped: Array<{ change: RefineChange; reason: string }> = [];
    const notes: string[] = [];

    for (const change of changes) {
      try {
        switch (change.op) {
          case 'update_table_description': {
            const n = await db('product_tables')
              .where({ id: change.table_id })
              .update({ description: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'Table not found' });
            break;
          }
          case 'update_column_description': {
            const n = await db('product_columns')
              .where({ id: change.column_id })
              .update({ description: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'Column not found' });
            break;
          }
          case 'update_column_display_name': {
            const n = await db('product_columns')
              .where({ id: change.column_id })
              .update({ display_name: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'Column not found' });
            break;
          }
          case 'update_kpi_description': {
            const n = await db('product_kpis')
              .where({ id: change.kpi_id, data_product_id: productId })
              .update({ description: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'KPI not found' });
            break;
          }
          case 'update_kpi_formula': {
            const n = await db('product_kpis')
              .where({ id: change.kpi_id, data_product_id: productId })
              .update({ formula_sql: change.new_value, ai_draft: false, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'KPI not found' });
            break;
          }
          case 'update_kpi_plain_text': {
            const n = await db('product_kpis')
              .where({ id: change.kpi_id, data_product_id: productId })
              .update({ formula_plain_text: change.new_value, updated_at: now });
            if (n > 0) applied++;
            else skipped.push({ change, reason: 'KPI not found' });
            break;
          }
          case 'add_kpi': {
            await db('product_kpis').insert({
              data_product_id:    productId,
              name:               change.name,
              description:        change.description,
              formula_plain_text: change.formula_plain_text,
              formula_sql:        change.formula_sql,
              ai_draft:           false,
            });
            applied++;
            break;
          }
          case 'note': {
            notes.push(change.message);
            break;
          }
          default: {
            skipped.push({ change, reason: 'Unknown op' });
          }
        }
      } catch (e) {
        skipped.push({ change, reason: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    res.json({ ok: true, data: { applied, skipped, notes } as { applied: number; skipped: typeof skipped; notes: string[] } });
  } catch (err) { next(err); }
});


export default router;
