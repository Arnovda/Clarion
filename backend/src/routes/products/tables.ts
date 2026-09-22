/**
 * Products router (4/9): product-table + product-column routes — single-table
 * run, metadata patch, add table, SQL edit, approve, checks, refresh-history,
 * column update. (PATCH /tables/:tableId/load-mode is NOT here — it sits in
 * build.ts to preserve the original registration order.)
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { Database } from 'duckdb-async';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  updateProductTableSchema,
  updateProductTableSqlSchema,
  previewProductTableSqlSchema,
  proposeProductTableSqlSchema,
} from '../../middleware/schemas';
import { syncProductToNeo4j } from '../../services/productGraphSync';
import { reqDb } from '../../db/reqDb';
import { syncDeployCell } from '../../services/refineService';
import { proposeTransformationEdit } from '../../ai/AIService';
import { UnsafeSqlError } from '../../utils/sqlGuard';
import {
  prepareDeclaredSql,
  sanitizeSqlError,
  openDeclarationSession,
  compileDeclaredSql,
  previewDeclaredSql,
  describeSessionSchemas,
} from '../../services/tableDeclaration';
import { log } from './shared';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/products/tables/:tableId/run — Run a single table transformation
// ---------------------------------------------------------------------------

// admin+analyst since 2026-09-22: the catalog's declaration editor offers
// "Rebuild now" after a save, and the role table grants analysts the rebuild
// of a subject. One table is a smaller act than the whole subject.
router.post('/tables/:tableId/run', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const table = await db('product_tables').where({ id: req.params.tableId }).first();
    if (!table) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    if (!table.transformation_sql) {
      res.status(400).json({ ok: false, error: 'No transformation SQL defined' });
      return;
    }

    const schema = await db('star_schemas').where({ id: table.star_schema_id }).first();
    const product = await db('data_products').where({ id: schema.data_product_id }).first();

    const { runProductTransformation } = await import('../../services/transformationRunner');

    const result = (await runProductTransformation(product, [table], req.user?.tenantId))[0] ?? null;

    // Sync updated row counts / status to Neo4j
    syncProductToNeo4j(product.id, req.user!.tenantId).catch(() => {}); // non-db — Neo4j graph sync, not a request-trx Knex query

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/products/tables/:tableId — Update product table metadata
// (currently: description, display_name)
// ---------------------------------------------------------------------------

router.patch('/tables/:tableId', requireAuth, requireRole('admin', 'analyst'), validate(updateProductTableSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const allowed = ['description', 'display_name', 'plain_summary'];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    await db('product_tables').where({ id: req.params.tableId }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/tables — Add a new table to a product
// ---------------------------------------------------------------------------

router.post('/:id/tables', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    const product = await db('data_products').where({ id: productId }).first();
    if (!product) { res.status(404).json({ ok: false, error: 'Product not found' }); return; }

    const { tableName, tableRole, description } = req.body as {
      tableName?: string; tableRole?: string; description?: string;
    };
    if (!tableName?.trim()) {
      res.status(400).json({ ok: false, error: 'tableName is required' });
      return;
    }

    // Find the product's star_schema (auto-create if missing)
    let schema = await db('star_schemas').where({ data_product_id: productId }).first();
    if (!schema) {
      [schema] = await db('star_schemas').insert({
        data_product_id: productId,
        name: `${product.name} Schema`,
      }).returning('*');
    }

    // Determine dag_order: dimensions before facts
    const role = tableRole || 'custom';
    const dagOrder = (role === 'fact') ? 1 : 0;

    // Check for duplicate table name within this product
    const existing = await db('product_tables')
      .where({ star_schema_id: schema.id, table_name: tableName.trim() })
      .first();
    if (existing) {
      res.status(400).json({ ok: false, error: `Table "${tableName}" already exists in this product` });
      return;
    }

    const [table] = await db('product_tables').insert({
      star_schema_id: schema.id,
      table_name: tableName.trim(),
      table_role: role,
      description: description?.trim() || null,
      dag_order: dagOrder,
      transformation_status: 'draft',
      ai_draft: false,
    }).returning('*');

    // Create one empty SQL cell
    const [cell] = await db('product_table_cells').insert({
      product_table_id: table.id,
      cell_type: 'sql',
      source: '',
      position: 0,
      is_deploy_cell: true,
    }).returning('*');

    res.json({ ok: true, data: { ...table, cells: [cell] } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The DECLARATION — one editor, one store, one verb.
//
//   GET  /tables/:tableId/declaration    what the catalog's SQL editor shows
//   PUT  /tables/:tableId/sql            Save: guard → compile → store once
//   POST /tables/:tableId/sql/preview    the first rows of a draft
//   POST /tables/:tableId/sql/propose    the assistant's proposed change
//
// Before 2026-09-22 `PUT /sql` wrote `transformation_sql` unvalidated, flipped
// the table to `draft` (so it VANISHED from Ask AI, which filters on
// `success`), and left the notebook's deploy cell untouched — so the next
// Deploy copied the old cell back over the edit. Three defects, one route.
// Now: the SQL is guarded and compiled before anything is stored, a table
// that was serving keeps serving (the screen shows "changed since the last
// build" from `declared_at` > `last_run_at`), and the deploy cell is synced
// so no later Deploy can revert the declaration.
// ---------------------------------------------------------------------------

interface DeclarationRow {
  id: number;
  table_name: string;
  display_name: string | null;
  table_role: string | null;
  transformation_sql: string | null;
  transformation_status: string | null;
  last_run_at: string | null;
  last_run_error: string | null;
  row_count: number | null;
  degraded_reason: string | null;
  declared_by: string | null;
  declared_at: string | null;
  updated_at: string | null;
  source_product_table_id: number | null;
  is_shared_dimension: boolean | null;
  product_id: number;
  product_name: string;
  connection_id: number | null;
}

/** The table, with its product, under an EXPLICIT tenant filter (the reqDb pool-race rule). */
async function loadDeclarationRow(req: Request, tableId: number): Promise<DeclarationRow | null> {
  const db = reqDb(req);
  const row = await db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .where('pt.id', tableId)
    .andWhere('pt.tenant_id', req.user!.tenantId)
    .first(
      'pt.id', 'pt.table_name', 'pt.display_name', 'pt.table_role',
      'pt.transformation_sql', 'pt.transformation_status', 'pt.last_run_at', 'pt.last_run_error',
      'pt.row_count', 'pt.degraded_reason', 'pt.declared_by', 'pt.declared_at', 'pt.updated_at',
      'pt.source_product_table_id', 'pt.is_shared_dimension',
      'dp.id as product_id', 'dp.name as product_name', 'dp.connection_id',
    );
  return (row as DeclarationRow | undefined) ?? null;
}

/** Where a shared dimension is really built — a stub points at its owner. */
async function loadSharedFrom(req: Request, ownerTableId: number) {
  const db = reqDb(req);
  const owner = await db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'ss.data_product_id', 'dp.id')
    .where('pt.id', ownerTableId)
    .andWhere('pt.tenant_id', req.user!.tenantId)
    .first('pt.id as table_id', 'dp.id as product_id', 'dp.name as product_name');
  return owner
    ? { tableId: Number(owner.table_id), productId: Number(owner.product_id), productName: String(owner.product_name) }
    : null;
}

function tableIdParam(req: Request, res: Response): number | null {
  const id = Number(req.params.tableId);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ ok: false, error: 'invalid tableId' });
    return null;
  }
  return id;
}

router.get('/tables/:tableId/declaration', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tableId = tableIdParam(req, res);
    if (tableId == null) return;
    const row = await loadDeclarationRow(req, tableId);
    if (!row) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }

    const sharedFrom = row.source_product_table_id ? await loadSharedFrom(req, Number(row.source_product_table_id)) : null;
    const db = reqDb(req);
    const columns = await db('product_columns')
      .where({ product_table_id: tableId })
      .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
      .orderBy(['sort_order', 'id'])
      .select('id', 'column_name', 'display_name', 'data_type', 'column_role', 'description');

    res.json({
      ok: true,
      data: {
        id: row.id,
        table_name: row.table_name,
        display_name: row.display_name,
        table_role: row.table_role,
        transformation_sql: row.transformation_sql,
        transformation_status: row.transformation_status,
        last_run_at: row.last_run_at,
        last_run_error: row.last_run_error,
        row_count: row.row_count,
        degraded_reason: row.degraded_reason,
        declared_by: row.declared_by,
        declared_at: row.declared_at,
        // Changed since the last build: the stored SQL is newer than what
        // the warehouse holds. Read off two timestamps, never a status flip.
        pending_rebuild: !!row.declared_at && (!row.last_run_at || new Date(row.declared_at) > new Date(row.last_run_at)),
        product: { id: row.product_id, name: row.product_name, connection_id: row.connection_id },
        shared_from: sharedFrom,
        columns,
      },
    });
  } catch (err) { next(err); }
});

router.put('/tables/:tableId/sql', requireAuth, requireRole('admin', 'analyst'), validate(updateProductTableSqlSchema), async (req: Request, res: Response, next: NextFunction) => {
  let session: Database | null = null;
  try {
    const tableId = tableIdParam(req, res);
    if (tableId == null) return;
    const { sql } = req.body as { sql: string };

    // 1. Guard, before anything is read or written.
    let inner: string;
    try {
      inner = prepareDeclaredSql(sql);
    } catch (err) {
      if (err instanceof UnsafeSqlError) { res.status(400).json({ ok: false, error: err.message }); return; }
      throw err;
    }

    const row = await loadDeclarationRow(req, tableId);
    if (!row) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    if (row.source_product_table_id) {
      const owner = await loadSharedFrom(req, Number(row.source_product_table_id));
      res.status(400).json({
        ok: false,
        error: owner
          ? `This table is shared from ${owner.productName} — change it there.`
          : 'This table is shared from another subject — change it there.',
      });
      return;
    }
    if (!row.connection_id) {
      res.status(400).json({ ok: false, error: 'This subject has no source connection to compile against.' });
      return;
    }

    // 2. Compile in a real session for the product's connection.
    let columns;
    try {
      session = await openDeclarationSession(reqDb(req), req.user!.tenantId, Number(row.connection_id));
      columns = await compileDeclaredSql(session, inner);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'The SQL did not compile';
      res.status(400).json({ ok: false, error: sanitizeSqlError(msg), compiled: false });
      return;
    }

    // 3. Store ONCE, and keep the deploy cell in step so Deploy cannot revert it.
    const db = reqDb(req);
    const now = new Date().toISOString();
    const declaredBy = (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? null;
    const keepsServing = row.transformation_status === 'success';
    await db('product_tables').where({ id: tableId }).update({
      transformation_sql: inner,
      // A table that was serving keeps serving; the rebuild is shown, not forced.
      transformation_status: keepsServing ? 'success' : 'draft',
      declared_by: declaredBy,
      declared_at: now,
      updated_at: now,
    });
    await syncDeployCell(db, tableId, inner);

    log.info({ tableId, table: row.table_name, declaredBy, columns: columns.length }, 'declaration saved');
    res.json({
      ok: true,
      data: { columns, declared_by: declaredBy, declared_at: now, pending_rebuild: true, keeps_serving: keepsServing },
    });
  } catch (err) { next(err); }
  finally {
    if (session) try { await session.close(); } catch { /* ignore */ }
  }
});

router.post('/tables/:tableId/sql/preview', requireAuth, requireRole('admin', 'analyst'), validate(previewProductTableSqlSchema), async (req: Request, res: Response, next: NextFunction) => {
  let session: Database | null = null;
  try {
    const tableId = tableIdParam(req, res);
    if (tableId == null) return;
    const { sql } = req.body as { sql: string };
    let inner: string;
    try {
      inner = prepareDeclaredSql(sql);
    } catch (err) {
      if (err instanceof UnsafeSqlError) { res.status(400).json({ ok: false, error: err.message }); return; }
      throw err;
    }
    const row = await loadDeclarationRow(req, tableId);
    if (!row) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    if (!row.connection_id) {
      res.status(400).json({ ok: false, error: 'This subject has no source connection to run against.' });
      return;
    }
    try {
      session = await openDeclarationSession(reqDb(req), req.user!.tenantId, Number(row.connection_id));
      const preview = await previewDeclaredSql(session, inner, 12);
      res.json({ ok: true, data: { ...preview, rowCount: preview.rows.length } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Preview failed';
      res.status(400).json({ ok: false, error: sanitizeSqlError(msg) });
    }
  } catch (err) { next(err); }
  finally {
    if (session) try { await session.close(); } catch { /* ignore */ }
  }
});

router.post('/tables/:tableId/sql/propose', requireAuth, requireRole('admin', 'analyst'), validate(proposeProductTableSqlSchema), async (req: Request, res: Response, next: NextFunction) => {
  let session: Database | null = null;
  try {
    const tableId = tableIdParam(req, res);
    if (tableId == null) return;
    const { instruction, sql: draft } = req.body as { instruction: string; sql?: string };
    const row = await loadDeclarationRow(req, tableId);
    if (!row) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    if (row.source_product_table_id) {
      const owner = await loadSharedFrom(req, Number(row.source_product_table_id));
      res.status(400).json({
        ok: false,
        error: owner
          ? `This table is shared from ${owner.productName} — change it there.`
          : 'This table is shared from another subject — change it there.',
      });
      return;
    }
    if (!row.connection_id) {
      res.status(400).json({ ok: false, error: 'This subject has no source connection to compile against.' });
      return;
    }
    const base = (draft?.trim() || row.transformation_sql || '').trim().replace(/;\s*$/, '');

    session = await openDeclarationSession(reqDb(req), req.user!.tenantId, Number(row.connection_id));
    const availableSchemas = await describeSessionSchemas(session);
    const proposal = await proposeTransformationEdit({
      tableName: row.table_name,
      tableRole: row.table_role ?? 'table',
      currentSql: base,
      instruction: instruction.trim(),
      availableSchemas,
    });

    // The model declined (returned the original) — say so, propose nothing.
    if (proposal.sql.trim().replace(/;\s*$/, '') === base) {
      res.json({ ok: true, data: { proposed: false, summary: proposal.summary || 'No change was needed.' } });
      return;
    }

    // Fresh model output carries the same trust as first-pass generation:
    // none. Guard it, then compile it, before anyone sees a diff.
    let inner: string;
    try {
      inner = prepareDeclaredSql(proposal.sql);
    } catch (err) {
      if (err instanceof UnsafeSqlError) {
        log.warn({ tableId, reason: err.message }, 'assistant proposal refused by the guard');
        res.json({ ok: true, data: { proposed: false, summary: 'The proposed change was refused: it tried to read outside your data.' } });
        return;
      }
      throw err;
    }
    try {
      const columns = await compileDeclaredSql(session, inner);
      res.json({ ok: true, data: { proposed: true, sql: inner, summary: proposal.summary, compiled: true, columns } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'The proposal did not compile';
      res.json({ ok: true, data: { proposed: true, sql: inner, summary: proposal.summary, compiled: false, error: sanitizeSqlError(msg) } });
    }
  } catch (err) { next(err); }
  finally {
    if (session) try { await session.close(); } catch { /* ignore */ }
  }
});


// ---------------------------------------------------------------------------
// GET /api/products/tables/:tableId/checks — Get quality check results
// ---------------------------------------------------------------------------

router.get('/tables/:tableId/checks', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const checks = await db('transformation_checks')
      .where({ product_table_id: req.params.tableId })
      .orderBy('check_type');
    res.json({ ok: true, data: checks });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/tables/:tableId/refresh-history — Per-table refresh history
//
// Powers the per-table change-evolution mini chart on /products/[id]. Returns
// the most recent N refresh rows (default 30, max 200) ordered by
// refresh_started_at DESC. RLS isolates by tenant.
// ---------------------------------------------------------------------------

router.get('/tables/:tableId/refresh-history', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tableId = Number(req.params.tableId);
    if (!Number.isFinite(tableId)) {
      res.status(400).json({ ok: false, error: 'invalid tableId' });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 30, 1),
      200,
    );

    const tenantId = req.user?.tenantId;
    if (tenantId) {
      }

    const rows = await db('product_table_refresh_history')
      .where({ product_table_id: tableId })
      .orderBy('refresh_started_at', 'desc')
      .limit(limit)
      .select(
        'id',
        'refresh_started_at',
        'refresh_completed_at',
        'status',
        'rows_unchanged',
        'rows_updated',
        'rows_inserted',
        'rows_deleted',
        'rows_total',
        'error_message',
        'storage_format',
      );

    // Return chronological order (oldest → newest) for direct charting.
    res.json({ ok: true, data: rows.reverse() });
  } catch (err) { next(err); }
});


export default router;
