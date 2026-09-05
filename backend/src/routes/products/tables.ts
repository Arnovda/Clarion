/**
 * Products router (4/9): product-table + product-column routes — single-table
 * run, metadata patch, add table, SQL edit, approve, checks, refresh-history,
 * column update. (PATCH /tables/:tableId/load-mode is NOT here — it sits in
 * build.ts to preserve the original registration order.)
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { updateProductTableSchema, updateProductTableSqlSchema, updateProductColumnSchema } from '../../middleware/schemas';
import { syncProductToNeo4j } from '../../services/productGraphSync';
import { reqDb } from '../../db/reqDb';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/products/tables/:tableId/run — Run a single table transformation
// ---------------------------------------------------------------------------

router.post('/tables/:tableId/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
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

router.patch('/tables/:tableId', requireAuth, requireRole('admin'), validate(updateProductTableSchema), async (req: Request, res: Response, next: NextFunction) => {
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
// PUT /api/products/tables/:tableId/sql — Update transformation SQL
// ---------------------------------------------------------------------------

router.put('/tables/:tableId/sql', requireAuth, requireRole('admin'), validate(updateProductTableSqlSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { sql } = req.body as { sql: string };
    await db('product_tables')
      .where({ id: req.params.tableId })
      .update({
        transformation_sql: sql,
        transformation_status: 'draft',
        updated_at: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/tables/:tableId/approve — Approve transformation
// ---------------------------------------------------------------------------

router.put('/tables/:tableId/approve', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    await db('product_tables')
      .where({ id: req.params.tableId })
      .update({
        transformation_status: 'approved',
        updated_at: new Date().toISOString(),
      });
    res.json({ ok: true });
  } catch (err) { next(err); }
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

// ---------------------------------------------------------------------------
// PUT /api/products/columns/:columnId — Update a product column
// ---------------------------------------------------------------------------

router.put('/columns/:columnId', requireAuth, requireRole('admin'), validate(updateProductColumnSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const allowed = [
      'column_name', 'data_type', 'display_name', 'description',
      'column_role', 'fk_target_table', 'fk_target_column',
      'transformation_expression', 'additivity', 'scd_type', 'sort_order',
    ];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    await db('product_columns').where({ id: req.params.columnId }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});


export default router;
