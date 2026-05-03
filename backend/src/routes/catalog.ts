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
import { semanticDb } from '../db/knex';
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
router.get('/', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [connections, products] = await Promise.all([
      semanticDb('connections').select('id'),
      semanticDb('data_products').select('id'),
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
// GET /api/catalog/:catalog — list schemas in a catalog
// ---------------------------------------------------------------------------
router.get('/:catalog', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const catalog = req.params.catalog;
    if (!isCatalogId(catalog)) {
      return res.status(404).json({ ok: false, error: 'Unknown catalog' });
    }

    if (catalog === 'sources') {
      const conns = await semanticDb('connections')
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
    const products = await semanticDb('data_products')
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
      ? await semanticDb('data_product_sources as dps')
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
      ? await semanticDb('connections')
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
      const conn = await semanticDb('connections').where({ id: schemaId }).first();
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
    const product = await semanticDb('data_products').where({ id: schemaId }).first();
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
