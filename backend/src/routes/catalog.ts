/**
 * /api/catalog — Unity-Catalog-style three-level namespace browser.
 *
 *   GET /api/catalog                          → ['sources', 'products']
 *   GET /api/catalog/:catalog                 → schemas (connections | data products)
 *   GET /api/catalog/:catalog/:schema         → tables in that schema
 *   GET /api/catalog/:catalog/:schema/:table  → columns in that table
 *
 * Schema slugs are `<name>_<id>` (see utils/slug.ts) so duplicate display
 * names don't collide. Table slugs use the raw `pgId` (integer) so they're
 * stable across renames.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { owns } from '../db/tenantOwnership';
import * as graph from '../db/semanticGraph';
import { toSlugWithId, parseIdFromSlug } from '../utils/slug';

const router = Router();

type CatalogId = 'sources' | 'products';
function isCatalogId(v: string): v is CatalogId {
  return v === 'sources' || v === 'products';
}

// ---------------------------------------------------------------------------
// GET /api/catalog — list catalogs
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const [connections, products] = await Promise.all([
      db('connections').select('id'),
      db('data_products').select('id'),
    ]);
    res.json({
      ok: true,
      data: [
        { id: 'sources',  label: 'Sources',       schemaCount: connections.length },
        { id: 'products', label: 'Data Products', schemaCount: products.length },
      ],
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/search?q=... — flat fuzzy search across both catalogs.
// Returns up to ~60 table/column matches with everything the tree needs to
// navigate to them (catalog id, schema slug + label, table id + label).
// Column matches carry an optional `columnName` so the UI can show the
// match in context ("dim_customer.first_name"). Empty q → empty result.
//
// RLS is enforced by reqDb — every read goes through the user's tenant
// session, so cross-tenant leakage is structurally impossible.
//
// Implemented as four small queries (source tables, source columns,
// product tables, product columns) rather than one giant union; the join
// to schemas + connections happens client-side here in JS to keep the SQL
// simple and ANSI-portable.
// ---------------------------------------------------------------------------
router.get('/search', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (raw.length < 2) {
      res.json({ ok: true, data: [] });
      return;
    }
    const LIMIT = 60;
    const pattern = `%${raw.replace(/[%_]/g, (c) => `\\${c}`)}%`;

    // 1. Source tables — match table_name OR display_name (limit per type so
    //    a flood of column hits can't crowd table hits out of the result).
    const sourceTables = await db('source_tables as st')
      .join('connections as c', 'st.connection_id', 'c.id')
      .where((qb) => qb.where('st.table_name', 'ilike', pattern).orWhere('st.display_name', 'ilike', pattern))
      .select(
        'st.id', 'st.table_name', 'st.display_name', 'st.connection_id',
        'c.name as connection_name',
      )
      .limit(LIMIT);

    // 2. Source columns — match column_name OR display_name. Join the table
    //    so we know how to address it (schema slug + tableId).
    const sourceColumns = await db('source_columns as sc')
      .join('source_tables as st', 'sc.table_id', 'st.id')
      .join('connections as c', 'st.connection_id', 'c.id')
      .where((qb) => qb.where('sc.column_name', 'ilike', pattern).orWhere('sc.display_name', 'ilike', pattern))
      .select(
        'sc.column_name', 'sc.display_name as column_display',
        'st.id as table_id', 'st.table_name', 'st.display_name as table_display',
        'st.connection_id', 'c.name as connection_name',
      )
      .limit(LIMIT);

    // 3. Product tables — join up to data_products for schema slug + label.
    const productTables = await db('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where((qb) => qb.where('pt.table_name', 'ilike', pattern).orWhere('pt.display_name', 'ilike', pattern))
      .select(
        'pt.id', 'pt.table_name', 'pt.display_name', 'pt.table_role',
        'dp.id as product_id', 'dp.name as product_name',
      )
      .limit(LIMIT);

    // 4. Product columns (skip technical row-hash / SCD2 metadata).
    const productColumns = await db('product_columns as pc')
      .join('product_tables as pt', 'pc.product_table_id', 'pt.id')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where((qb) => qb.where('pc.column_name', 'ilike', pattern).orWhere('pc.display_name', 'ilike', pattern))
      .andWhere((qb) => qb.where('pc.is_technical', false).orWhereNull('pc.is_technical'))
      .select(
        'pc.column_name', 'pc.display_name as column_display',
        'pt.id as table_id', 'pt.table_name', 'pt.display_name as table_display', 'pt.table_role',
        'dp.id as product_id', 'dp.name as product_name',
      )
      .limit(LIMIT);

    interface Hit {
      kind: 'table' | 'column';
      catalog: 'sources' | 'products';
      schemaSlug: string;
      schemaLabel: string;
      tableId: string;
      tableLabel: string;
      tableName: string;
      role: string | null;
      columnName?: string;
      columnLabel?: string;
    }

    const hits: Hit[] = [
      ...sourceTables.map((r): Hit => ({
        kind: 'table',
        catalog: 'sources',
        schemaSlug: toSlugWithId(String(r.connection_name), Number(r.connection_id)),
        schemaLabel: String(r.connection_name),
        tableId: String(r.id),
        tableLabel: String(r.display_name ?? r.table_name),
        tableName: String(r.table_name),
        role: 'source',
      })),
      ...sourceColumns.map((r): Hit => ({
        kind: 'column',
        catalog: 'sources',
        schemaSlug: toSlugWithId(String(r.connection_name), Number(r.connection_id)),
        schemaLabel: String(r.connection_name),
        tableId: String(r.table_id),
        tableLabel: String(r.table_display ?? r.table_name),
        tableName: String(r.table_name),
        role: 'source',
        columnName: String(r.column_name),
        columnLabel: r.column_display ? String(r.column_display) : String(r.column_name),
      })),
      ...productTables.map((r): Hit => ({
        kind: 'table',
        catalog: 'products',
        schemaSlug: toSlugWithId(String(r.product_name), Number(r.product_id)),
        schemaLabel: String(r.product_name),
        tableId: String(r.id),
        tableLabel: String(r.display_name ?? r.table_name),
        tableName: String(r.table_name),
        role: r.table_role ? String(r.table_role) : null,
      })),
      ...productColumns.map((r): Hit => ({
        kind: 'column',
        catalog: 'products',
        schemaSlug: toSlugWithId(String(r.product_name), Number(r.product_id)),
        schemaLabel: String(r.product_name),
        tableId: String(r.table_id),
        tableLabel: String(r.table_display ?? r.table_name),
        tableName: String(r.table_name),
        role: r.table_role ? String(r.table_role) : null,
        columnName: String(r.column_name),
        columnLabel: r.column_display ? String(r.column_display) : String(r.column_name),
      })),
    ];

    // Rank: exact (case-insensitive) name match wins; then prefix; then
    // substring. Tables before columns within each rank — when both match,
    // the user almost always means the table.
    const q = raw.toLowerCase();
    const tier = (h: Hit): number => {
      const name = (h.kind === 'column' ? (h.columnName ?? '') : h.tableName).toLowerCase();
      const label = (h.kind === 'column' ? (h.columnLabel ?? '') : h.tableLabel).toLowerCase();
      if (name === q || label === q) return 0;
      if (name.startsWith(q) || label.startsWith(q)) return 1;
      return 2;
    };
    hits.sort((a, b) => {
      const t = tier(a) - tier(b);
      if (t !== 0) return t;
      if (a.kind !== b.kind) return a.kind === 'table' ? -1 : 1;
      return 0;
    });

    res.json({ ok: true, data: hits.slice(0, LIMIT) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/:catalog — list schemas in a catalog
// ---------------------------------------------------------------------------
router.get('/:catalog', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const catalog = req.params.catalog;
    if (!isCatalogId(catalog)) {
      return res.status(404).json({ ok: false, error: 'Unknown catalog' });
    }

    if (catalog === 'sources') {
      const conns = await db('connections')
        .select('id', 'name', 'type', 'created_at')
        .orderBy('name');

      // Count tables per connection from Neo4j (in parallel)
      const withCounts = await Promise.all(conns.map(async (c) => {
        const tables = await graph.getTablesByConnection(c.id);
        return {
          catalog: 'sources' as const,
          id: toSlugWithId(c.name, c.id),
          label: c.name,
          tableCount: tables.length,
          ownerName: null,
          lastRefreshed: c.created_at ? String(c.created_at) : null,
          meta: { connectionId: c.id, type: c.type },
        };
      }));
      return res.json({ ok: true, data: withCounts });
    }

    // products
    const products = await db('data_products')
      .select('id', 'name', 'description', 'status', 'created_by', 'created_at', 'updated_at', 'connection_id')
      .orderBy('name');

    const productTree = await graph.getProductTree();
    const tableCountByDpid = new Map<number, number>();
    for (const p of productTree.products) {
      tableCountByDpid.set(p.dataProductId, p.tables.length);
    }

    // Compute primary source per product (same rule as GET /api/products):
    // most-tables-contributed connection wins, fallback to data_products.connection_id.
    const productIds = (products as Array<{ id: number }>).map((p) => p.id);
    const sourceRows = productIds.length
      ? await db('data_product_sources as dps')
          .join('source_tables as st', 'st.id', 'dps.source_table_id')
          .whereIn('dps.data_product_id', productIds)
          .select('dps.data_product_id as product_id', 'st.connection_id as connection_id')
      : [];
    const tallies = new Map<number, Map<number, number>>();
    for (const r of sourceRows as { product_id: number; connection_id: number }[]) {
      if (!r.connection_id) continue;
      let inner = tallies.get(r.product_id);
      if (!inner) { inner = new Map(); tallies.set(r.product_id, inner); }
      inner.set(r.connection_id, (inner.get(r.connection_id) ?? 0) + 1);
    }
    const connIds = new Set<number>();
    for (const p of products as Array<{ connection_id: number | null }>) if (p.connection_id) connIds.add(p.connection_id);
    for (const r of sourceRows as { connection_id: number }[]) if (r.connection_id) connIds.add(r.connection_id);
    const connRows = connIds.size
      ? await db('connections')
          .whereIn('id', Array.from(connIds))
          .select('id', 'name', 'type', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; type: string; connector_type: string | null }>(
      connRows.map((c: { id: number; name: string; type: string; connector_type: string | null }) => [c.id, c] as const),
    );

    const data = (products as Array<{
      id: number; name: string; description: string | null;
      status: string; created_by: string | null; updated_at: Date | string | null;
      connection_id: number | null;
    }>).map((p) => {
      const inner = tallies.get(p.id);
      const contributors = inner
        ? Array.from(inner.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])
        : [];
      const primaryId = contributors[0]?.[0] ?? p.connection_id ?? null;
      const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
      const multiSource = contributors.length > 1;
      return {
        catalog: 'products' as const,
        id: toSlugWithId(p.name, p.id),
        label: p.name,
        description: p.description,
        tableCount: tableCountByDpid.get(p.id) ?? 0,
        ownerName: p.created_by,
        status: p.status,
        lastRefreshed: p.updated_at ? String(p.updated_at) : null,
        meta: {
          dataProductId: p.id,
          // Primary-source info — drives the tree's "products grouped by
          // source" rendering. Null when the product has no resolvable
          // source (e.g. all source connections were deleted).
          sourceConnectionId:   primaryConn?.id ?? null,
          sourceConnectionName: primaryConn?.name ?? null,
          sourceConnectorType:  primaryConn?.connector_type ?? null,
          multiSource,
          sourceDeleted:        primaryId != null && !primaryConn,
        },
      };
    });
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/:catalog/:schema — list tables in a schema
// ---------------------------------------------------------------------------
router.get('/:catalog/:schema', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const catalog = req.params.catalog;
    if (!isCatalogId(catalog)) {
      return res.status(404).json({ ok: false, error: 'Unknown catalog' });
    }
    const schemaSlug = req.params.schema;
    const schemaId = parseIdFromSlug(schemaSlug);
    if (schemaId == null) {
      return res.status(404).json({ ok: false, error: 'Unknown schema' });
    }

    if (catalog === 'sources') {
      const conn = await db('connections').where({ id: schemaId }).first();
      if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });

      const tables = await graph.getTablesByConnection(schemaId);
      // Pull column counts in parallel
      const withColumns = await Promise.all(tables.map(async (t) => {
        const cols = await graph.getColumnsByTablePgId(Number(t.id));
        return {
          catalog: 'sources' as const,
          schema: schemaSlug,
          id: String(t.id),
          label: (t.display_name as string) || (t.table_name as string),
          tableName: t.table_name,
          role: 'source' as const,
          rowCount: t.row_count,
          columnCount: cols.length,
          lastProfiledAt: t.last_profiled_at,
          ownerName: t.owner_name,
          description: t.description,
          aiDraft: t.ai_draft,
          approvalStatus: t.approval_status,
        };
      }));
      return res.json({ ok: true, data: withColumns });
    }

    // products
    const product = await db('data_products').where({ id: schemaId }).first();
    if (!product) return res.status(404).json({ ok: false, error: 'Data product not found' });

    const tables = await graph.getProductTablesByProduct(schemaId);
    const withColumns = await Promise.all(tables.map(async (t) => {
      const cols = await graph.getProductColumnsByTablePgId(Number(t.id));
      return {
        catalog: 'products' as const,
        schema: schemaSlug,
        id: String(t.id),
        label: (t.display_name as string) || (t.table_name as string),
        tableName: t.table_name,
        role: t.table_role,
        dagOrder: t.dag_order,
        rowCount: t.row_count,
        columnCount: cols.length,
        transformationStatus: t.transformation_status,
        lastRunAt: t.last_run_at,
        ownerName: t.owner_name,
        description: t.description,
        aiDraft: t.ai_draft,
        approvalStatus: t.approval_status,
      };
    }));
    res.json({ ok: true, data: withColumns });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/:catalog/:schema/:table — list columns in a table
// ---------------------------------------------------------------------------
router.get('/:catalog/:schema/:table', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const catalog = req.params.catalog;
    if (!isCatalogId(catalog)) {
      return res.status(404).json({ ok: false, error: 'Unknown catalog' });
    }
    const schemaSlug = req.params.schema;
    const schemaId = parseIdFromSlug(schemaSlug);
    if (schemaId == null) {
      return res.status(404).json({ ok: false, error: 'Unknown schema' });
    }
    const tableId = Number(req.params.table);
    if (!Number.isFinite(tableId)) {
      return res.status(404).json({ ok: false, error: 'Unknown table' });
    }

    // `tableId` comes straight from the URL and the graph lookups below have no
    // tenant predicate (see db/tenantOwnership.ts), so authorise it against the
    // Postgres mirror first — otherwise this endpoint returns another tenant's
    // column catalog to any authenticated user.
    const db = reqDb(req);
    const ownsTable = await owns(
      db,
      catalog === 'sources' ? 'source_tables' : 'product_tables',
      tableId,
      req.user?.tenantId,
    );
    if (!ownsTable) {
      return res.status(404).json({ ok: false, error: 'Unknown table' });
    }

    if (catalog === 'sources') {
      const cols = await graph.getColumnsByTablePgId(tableId);
      const data = cols.map((c) => ({
        catalog: 'sources' as const,
        schema: schemaSlug,
        table: String(tableId),
        id: String(c.id),
        name: c.column_name,
        label: (c.display_name as string) || (c.column_name as string),
        type: c.data_type,
        role: c.is_measure ? 'measure' : (c.is_dimension ? 'dimension' : null),
        description: c.description,
        nullPct: c.null_pct,
        distinctPct: c.distinct_pct,
        sampleValues: c.example_values,
        approvalStatus: c.approval_status,
        aiDraft: c.ai_draft,
      }));
      return res.json({ ok: true, data });
    }

    const cols = await graph.getProductColumnsByTablePgId(tableId);
    const data = cols.map((c) => ({
      catalog: 'products' as const,
      schema: schemaSlug,
      table: String(tableId),
      id: String(c.id),
      name: c.column_name,
      label: (c.display_name as string) || (c.column_name as string),
      type: c.data_type,
      role: c.column_role,
      description: c.description,
      fkTargetTable: c.fk_target_table,
      fkTargetColumn: c.fk_target_column,
      additivity: c.additivity,
      transformationExpression: c.transformation_expression,
      sortOrder: c.sort_order,
      approvalStatus: c.approval_status,
      aiDraft: c.ai_draft,
    }));
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

export default router;
