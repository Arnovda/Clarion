/**
 * Products router (9/9): product-table notebook cells (list/add/update/
 * delete/execute/reorder/generate) + deploy / deploy-all.
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { syncProductToNeo4j } from '../../services/productGraphSync';
import { listSourceTables, listProductTablesByConnection } from '../../services/tableCatalog';
import { Database } from 'duckdb-async';
import { reqDb } from '../../db/reqDb';
import { buildConnectionWarehouseSession } from '../../services/productWarehouse';

const router = Router();

// ===========================================================================
// PRODUCT TABLE CELLS — notebook cells per product table (Phase 1)
// ===========================================================================

// ───────────────────────────────────────────────────────────────────────────
// Shared-dimension redirection
// ───────────────────────────────────────────────────────────────────────────
// A product can pull in a shared dimension owned by another product. In
// product_tables we model this as a STUB row in the consumer's star schema
// with source_product_table_id pointing at the owner's real row. The owner
// holds the SQL, the cells, the warehouse path — everything authoritative.
//
// Without redirection, GET /tables/<stub>/cells returns an empty list and
// the UI shows "No cells yet" even though the dimension is fully defined
// in its owner. The fix below auto-resolves a stub to its owner before any
// cell read/write, so the consumer's notebook transparently edits the
// shared definition.
//
// Conformity is preserved because there's still ONE source of truth (the
// owner). The consent gate that warns "this affects N products" lives in
// the UI, not here — this helper is just the redirection.

interface OwnerInfo {
  ownerTableId: number;        // the id callers should actually use
  isShared: boolean;           // true when we redirected (the caller asked about a stub)
  ownerProductId?: number;
  ownerProductName?: string;
}

async function resolveOwner(
  db: ReturnType<typeof reqDb>,
  tableId: number,
): Promise<OwnerInfo | null> {
  const t = await db('product_tables')
    .where({ id: tableId })
    .select('id', 'source_product_table_id')
    .first() as { id: number; source_product_table_id: number | null } | undefined;
  if (!t) return null;
  if (!t.source_product_table_id) return { ownerTableId: tableId, isShared: false };
  const owner = await db('product_tables as pt')
    .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
    .join('data_products as dp', 'dp.id', 'ss.data_product_id')
    .where('pt.id', t.source_product_table_id)
    .select('pt.id as id', 'dp.id as product_id', 'dp.name as product_name')
    .first() as { id: number; product_id: number; product_name: string } | undefined;
  if (!owner) return { ownerTableId: tableId, isShared: false };
  return {
    ownerTableId: owner.id,
    isShared: true,
    ownerProductId: owner.product_id,
    ownerProductName: owner.product_name,
  };
}

// GET /api/products/tables/:tableId/cells — list cells for a table
router.get('/tables/:tableId/cells', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tableId = Number(req.params.tableId);
    const owner = await resolveOwner(db, tableId);
    if (!owner) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    const cells = await db('product_table_cells')
      .where({ product_table_id: owner.ownerTableId })
      .orderBy('position', 'asc');
    res.json({
      ok: true,
      data: cells,
      meta: owner.isShared
        ? { shared: true, ownerTableId: owner.ownerTableId, ownerProductId: owner.ownerProductId, ownerProductName: owner.ownerProductName }
        : { shared: false },
    });
  } catch (err) { next(err); }
});

// POST /api/products/tables/:tableId/cells — add a cell
router.post('/tables/:tableId/cells', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tableId = Number(req.params.tableId);
    const owner = await resolveOwner(db, tableId);
    if (!owner) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    const { cellType = 'sql', source = '', position } = req.body as {
      cellType?: string; source?: string; position?: number;
    };
    if (!['sql', 'markdown', 'nl'].includes(cellType)) {
      res.status(400).json({ ok: false, error: 'cellType must be sql, markdown, or nl' });
      return;
    }
    let pos = position;
    if (pos === undefined || pos === null) {
      const last = await db('product_table_cells')
        .where({ product_table_id: owner.ownerTableId })
        .max('position as max')
        .first();
      pos = ((last?.max as number) ?? -1) + 1;
    }
    const [cell] = await db('product_table_cells').insert({
      product_table_id: owner.ownerTableId,
      cell_type: cellType,
      source,
      position: pos,
      is_deploy_cell: false,
    }).returning('*');
    res.json({ ok: true, data: cell });
  } catch (err) { next(err); }
});

// PATCH /api/products/tables/cells/:cellId — update a cell
router.patch('/tables/cells/:cellId', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const cellId = Number(req.params.cellId);
    const allowed = ['source', 'cell_type', 'position', 'generated_sql', 'is_deploy_cell'];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const n = await db('product_table_cells').where({ id: cellId }).update(updates);
    if (!n) { res.status(404).json({ ok: false, error: 'Cell not found' }); return; }
    const cell = await db('product_table_cells').where({ id: cellId }).first();
    res.json({ ok: true, data: cell });
  } catch (err) { next(err); }
});

// DELETE /api/products/tables/cells/:cellId — delete a cell
router.delete('/tables/cells/:cellId', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const n = await db('product_table_cells').where({ id: Number(req.params.cellId) }).del();
    if (!n) { res.status(404).json({ ok: false, error: 'Cell not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/products/tables/cells/:cellId/execute — run a cell and return preview
router.post('/tables/cells/:cellId/execute', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  let duckDb: Database | null = null;
  try {
    const pgDb = reqDb(req);
    const cellId = Number(req.params.cellId);
    const cell = await pgDb('product_table_cells').where({ id: cellId }).first();
    if (!cell) { res.status(404).json({ ok: false, error: 'Cell not found' }); return; }
    if (cell.cell_type === 'markdown') {
      res.status(400).json({ ok: false, error: 'Cannot execute a markdown cell' });
      return;
    }

    const sqlToRun = cell.cell_type === 'nl' ? cell.generated_sql : cell.source;
    if (!sqlToRun?.trim()) {
      res.status(400).json({ ok: false, error: 'No SQL to execute' });
      return;
    }

    // Resolve connection_id from the product table's lineage
    const table = await pgDb('product_tables').where({ id: cell.product_table_id }).first();
    const schema = await pgDb('star_schemas').where({ id: table.star_schema_id }).first();
    const product = await pgDb('data_products').where({ id: schema.data_product_id }).first();
    const connectionId = product.connection_id;
    const connection = await pgDb('connections').where({ id: connectionId }).first();
    if (!connection) { res.status(400).json({ ok: false, error: 'Connection not found' }); return; }

    // Build DuckDB session with source + product tables registered.
    duckDb = await buildConnectionWarehouseSession(pgDb, connectionId);

    // Register preceding cells' outputs as views (cell chaining)
    const precedingCells = await pgDb('product_table_cells')
      .where({ product_table_id: cell.product_table_id })
      .andWhere('position', '<', cell.position)
      .whereIn('cell_type', ['sql', 'nl'])
      .orderBy('position', 'asc');

    for (const prev of precedingCells) {
      const prevSql = prev.cell_type === 'nl' ? prev.generated_sql : prev.source;
      if (prevSql?.trim()) {
        try {
          await duckDb.exec(`CREATE OR REPLACE VIEW _cell_${prev.id} AS ${prevSql}`);
        } catch { /* skip failed predecessor */ }
      }
    }

    // Execute the cell
    const start = Date.now();
    const rawRows = await duckDb.all(sqlToRun.trim()) as Record<string, unknown>[];
    const durationMs = Date.now() - start;

    const rows = rawRows.slice(0, 500).map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    // Cache output on the cell
    await pgDb('product_table_cells').where({ id: cellId }).update({
      last_output: JSON.stringify({ rows: rows.slice(0, 100), columns }),
      last_status: 'success',
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true, data: { rows, columns, rowCount: rawRows.length, durationMs } });
  } catch (err) {
    const pgDb = reqDb(req);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Try to get an AI fix suggestion
    let suggestedFix: string | undefined;
    try {
      const cell = await pgDb('product_table_cells').where({ id: Number(req.params.cellId) }).first();
      if (cell) {
        const failingSql = cell.cell_type === 'nl' ? cell.generated_sql : cell.source;
        if (failingSql?.trim()) {
          const { callClaude } = await import('../../ai/AIService');
          const fixPrompt = `The following DuckDB SQL failed with this error:\n\nSQL:\n${failingSql}\n\nError:\n${msg}\n\nReturn ONLY the corrected SQL. No markdown, no commentary.`;
          const fixed = await callClaude(
            'You fix broken DuckDB SQL. Return only the corrected SELECT statement.',
            fixPrompt,
            { maxTokens: 2000, callLabel: 'cell_error_fix', temperature: 0 },
          );
          suggestedFix = fixed.trim().replace(/^```(?:sql)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
        }
      }
    } catch { /* ignore AI error — the fix is best-effort */ }

    try {
      await pgDb('product_table_cells').where({ id: Number(req.params.cellId) }).update({
        last_status: 'error',
        last_output: JSON.stringify({ error: msg, suggestedFix }),
        last_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch { /* ignore meta-error */ }
    res.status(400).json({ ok: false, error: msg, suggestedFix });
  } finally {
    if (duckDb) try { await duckDb.close(); } catch { /* ignore */ }
  }
});

// POST /api/products/tables/:tableId/cells/reorder — bulk reorder cells
router.post('/tables/:tableId/cells/reorder', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { order } = req.body as { order: number[] };
    if (!Array.isArray(order)) {
      res.status(400).json({ ok: false, error: 'order[] is required' });
      return;
    }
    const now = new Date().toISOString();
    for (let i = 0; i < order.length; i++) {
      await db('product_table_cells')
        .where({ id: order[i], product_table_id: Number(req.params.tableId) })
        .update({ position: i, updated_at: now });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/products/tables/cells/:cellId/generate — NL → SQL generation
router.post('/tables/cells/:cellId/generate', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pgDb = reqDb(req);
    const cellId = Number(req.params.cellId);
    const cell = await pgDb('product_table_cells').where({ id: cellId }).first();
    if (!cell) { res.status(404).json({ ok: false, error: 'Cell not found' }); return; }
    if (cell.cell_type !== 'nl') {
      res.status(400).json({ ok: false, error: 'generate is only for NL cells' });
      return;
    }
    if (!cell.source?.trim()) {
      res.status(400).json({ ok: false, error: 'NL prompt is empty' });
      return;
    }

    // Build schema context
    const table = await pgDb('product_tables').where({ id: cell.product_table_id }).first();
    const schema = await pgDb('star_schemas').where({ id: table.star_schema_id }).first();
    const product = await pgDb('data_products').where({ id: schema.data_product_id }).first();
    const connectionId = product.connection_id;
    const connection = await pgDb('connections').where({ id: connectionId }).first();

    // Get source + product table schemas for context
    const sourceTables = await listSourceTables(undefined, connectionId);
    const productTablesList = await listProductTablesByConnection(undefined, connectionId);

    const schemaLines: string[] = [];
    for (const t of sourceTables) {
      schemaLines.push(`Source table "${connection.name}"."${t.tableName}"`);
    }
    for (const t of productTablesList) {
      schemaLines.push(`Product table "${t.productName}"."${t.tableName}"`);
    }

    // Get column info for the current product's tables
    const allTables = await pgDb('product_tables')
      .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
      .where('star_schemas.data_product_id', product.id)
      .select('product_tables.*');
    for (const pt of allTables) {
      const cols = await pgDb('product_columns')
        .where({ product_table_id: pt.id })
        .andWhere((qb: any) => qb.where('is_technical', false).orWhereNull('is_technical'))
        .orderBy('sort_order');
      if (cols.length > 0) {
        schemaLines.push(`\n${pt.table_name} columns: ${cols.map((c: any) => `${c.column_name} (${c.data_type ?? 'unknown'})`).join(', ')}`);
      }
    }

    const { callClaude } = await import('../../ai/AIService');
    const systemPrompt = `You are a DuckDB SQL expert writing transformation SQL for a data product. Generate a single SELECT statement that can be used as a CREATE TABLE AS. Use the available source and product tables. Return ONLY the SQL — no markdown, no commentary.`;
    const userPrompt = `Available tables:\n${schemaLines.join('\n')}\n\nUser request: "${cell.source}"\n\nGenerate the DuckDB SELECT statement.`;

    const generatedSql = await callClaude(systemPrompt, userPrompt, {
      maxTokens: 2000, callLabel: 'cell_nl_generate', temperature: 0,
    });

    const cleanSql = generatedSql.trim().replace(/^```(?:sql)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();

    await pgDb('product_table_cells').where({ id: cellId }).update({
      generated_sql: cleanSql,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true, data: { generatedSql: cleanSql } });
  } catch (err) { next(err); }
});

// POST /api/products/tables/:tableId/deploy — deploy: write cell SQL to transformation_sql + run
router.post('/tables/:tableId/deploy', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const requestedId = Number(req.params.tableId);
    // Shared dims: cells + canonical SQL live on the owner, so deploy there.
    const ownerInfo = await resolveOwner(db, requestedId);
    if (!ownerInfo) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    const tableId = ownerInfo.ownerTableId;
    const table = await db('product_tables').where({ id: tableId }).first();
    if (!table) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }

    // Find the deploy cell (or fall back to the last SQL/NL cell)
    let deployCell = await db('product_table_cells')
      .where({ product_table_id: tableId, is_deploy_cell: true })
      .first();
    if (!deployCell) {
      deployCell = await db('product_table_cells')
        .where({ product_table_id: tableId })
        .whereIn('cell_type', ['sql', 'nl'])
        .orderBy('position', 'desc')
        .first();
    }
    if (!deployCell) {
      res.status(400).json({ ok: false, error: 'No SQL cell to deploy' });
      return;
    }

    const sql = deployCell.cell_type === 'nl' ? deployCell.generated_sql : deployCell.source;
    if (!sql?.trim()) {
      res.status(400).json({ ok: false, error: 'Deploy cell has no SQL' });
      return;
    }

    // Write SQL to product_tables.transformation_sql
    await db('product_tables').where({ id: tableId }).update({
      transformation_sql: sql.trim(),
      transformation_status: 'draft',
      updated_at: new Date().toISOString(),
    });

    // Run the transformation
    const schema = await db('star_schemas').where({ id: table.star_schema_id }).first();
    const product = await db('data_products').where({ id: schema.data_product_id }).first();

    const { runProductTransformation } = await import('../../services/transformationRunner');
    const refreshedTable = await db('product_tables').where({ id: tableId }).first();
    const result = (await runProductTransformation(product, [refreshedTable], req.user?.tenantId))[0] ?? null;

    syncProductToNeo4j(product.id).catch(() => {}); // non-db — Neo4j graph sync, not a request-trx Knex query

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/deploy-all — deploy all table cells + run transformations
// ---------------------------------------------------------------------------

router.post('/:id/deploy-all', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    const product = await db('data_products').where({ id: productId }).first();
    if (!product) { res.status(404).json({ ok: false, error: 'Product not found' }); return; }

    const schemas = await db('star_schemas').where({ data_product_id: productId });
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const tables = schemaIds.length
      ? await db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy('dag_order', 'asc')
      : [];

    // Write cell SQL to transformation_sql for each table
    let updated = 0;
    for (const table of tables) {
      let deployCell = await db('product_table_cells')
        .where({ product_table_id: table.id, is_deploy_cell: true })
        .first();
      if (!deployCell) {
        deployCell = await db('product_table_cells')
          .where({ product_table_id: table.id })
          .whereIn('cell_type', ['sql', 'nl'])
          .orderBy('position', 'desc')
          .first();
      }
      if (!deployCell) continue;

      const sql = deployCell.cell_type === 'nl' ? deployCell.generated_sql : deployCell.source;
      if (!sql?.trim()) continue;

      await db('product_tables').where({ id: table.id }).update({
        transformation_sql: sql.trim(),
        transformation_status: 'draft',
        updated_at: new Date().toISOString(),
      });
      updated++;
    }

    if (updated === 0) {
      res.status(400).json({ ok: false, error: 'No tables with SQL cells to deploy' });
      return;
    }

    // Run all transformations
    const { runProductTransformation } = await import('../../services/transformationRunner');
    const freshTables = await db('product_tables')
      .whereIn('star_schema_id', schemaIds)
      .whereNotNull('transformation_sql')
      .orderBy('dag_order', 'asc');
    const results = await runProductTransformation(product, freshTables, req.user?.tenantId);

    syncProductToNeo4j(product.id).catch(() => {}); // non-db — Neo4j graph sync, not a request-trx Knex query

    res.json({ ok: true, data: { updated, results } });
  } catch (err) { next(err); }
});


export default router;
