import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
// tenantQuery removed — AI repair loops eliminated; deterministic auto-fix lives in transformationRunner
import { parsePagination, paginatedResponse } from '../utils/paginate';
import { syncProductToNeo4j, deleteProductFromNeo4j } from '../services/productGraphSync';
import { refineProduct, refineProductCross } from '../ai/AIService';
import { deleteWarehousePaths, productBasePath, productBasePathV2, warehouseLayoutVersion, productSlug as toProductSlug, isAzurePath, setupDuckDBForWarehouse, createScanView } from '../services/warehouse';
import { listProductTables, listSourceTables, listProductTablesByConnection } from '../services/tableCatalog';
import { Database } from 'duckdb-async';
import { tenantQuery } from '../services/tenantQuery';
import { recordAudit } from '../services/auditService';
import { reqDb } from '../db/reqDb';
import { tenantScopedWrite } from '../db/tenantScopedWrite';
import type {
  ProductSummary,
  RefineChange,
} from '../ai/prompts/refineProductPrompt';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'products' });

const router = Router();

/**
 * Build an in-memory DuckDB session with every table reachable from a
 * connection registered as a view: the connection's own source tables
 * (under `<connection.name>` schema) and every product table built from
 * that connection (under `<productName>` schema), with the search_path
 * set so unqualified refs resolve. Shared by the notebook cell-execute
 * endpoint and the refinement preview endpoint so the two stay in lockstep.
 *
 * Caller owns the returned Database and MUST close it.
 */
async function buildConnectionWarehouseSession(
  pgDb: ReturnType<typeof reqDb>,
  connectionId: number,
): Promise<Database> {
  const connection = await pgDb('connections').where({ id: connectionId }).first();
  if (!connection) throw new Error('Connection not found');

  const productDeltaPaths = await pgDb('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .join('data_products', 'star_schemas.data_product_id', 'data_products.id')
    .where('data_products.connection_id', connectionId)
    .whereNotNull('product_tables.delta_path')
    .pluck<string[]>('product_tables.delta_path');
  const needAzure = isAzurePath(connection.warehouse_path ?? '') || productDeltaPaths.some(isAzurePath);

  const db = await Database.create(':memory:');
  await setupDuckDBForWarehouse(db, needAzure);

  const sources = await listSourceTables(undefined, connectionId);
  for (const t of sources) {
    try { await createScanView(db, t.tableName, t.uri, { schema: connection.name }); } catch { /* skip */ }
  }
  const productTables = await listProductTablesByConnection(undefined, connectionId);
  for (const t of productTables) {
    try { await createScanView(db, t.tableName, t.uri, { schema: t.productName }); } catch { /* skip */ }
  }

  const schemas = new Set<string>([connection.name]);
  for (const t of productTables) schemas.add(t.productName);
  const schemaList = [...schemas].map((s) => s.replace(/'/g, "''")).join(',');
  if (schemaList) {
    try { await db.exec(`SET search_path = '${schemaList}';`); } catch { /* ignore */ }
  }
  return db;
}

// ---------------------------------------------------------------------------
// GET /api/products — List all data products
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { page, limit, offset } = parsePagination(req.query, { limit: 50 });
    const [{ count: total }] = await db('data_products').count('* as count');
    // Cards on /catalog need a few extra signals beyond raw row data:
    //   - star_schema_count (existing)
    //   - kpi_count          → "N metrics" stat on the card
    //   - last_refreshed_at  → MAX(product_tables.last_run_at), the freshness
    //     line on the card. Pulls from the catalog-source-of-truth column.
    //   - table_count        → for the "N tables" muted secondary stat.
    const products = await db('data_products')
      .select('data_products.*')
      .select(
        db.raw('(SELECT COUNT(*) FROM star_schemas WHERE star_schemas.data_product_id = data_products.id) as star_schema_count'),
        db.raw('(SELECT COUNT(*) FROM product_kpis WHERE product_kpis.data_product_id = data_products.id) as kpi_count'),
        db.raw(`(
          SELECT COUNT(*)
          FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as table_count`),
        db.raw(`(
          SELECT MAX(pt.last_run_at)
          FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as last_refreshed_at`),
      )
      .orderBy('data_products.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Compute the canonical "primary source" for every product so the UI
    // can group / filter / badge consistently. Rules (see CLAUDE.md notes):
    //   1. Most-tables-contributed connection wins.
    //   2. Tie → fall back to data_products.connection_id.
    //   3. Empty data_product_sources → use data_products.connection_id.
    //   4. Connection deleted → primary becomes null + sourceDeleted=true.
    // multiSource=true when the product touches >1 connection.
    const productIds = products.map((p: { id: number }) => p.id);
    const sourceRows = productIds.length
      ? await db('data_product_sources as dps')
          .join('source_tables as st', 'st.id', 'dps.source_table_id')
          .whereIn('dps.data_product_id', productIds)
          .select('dps.data_product_id as product_id', 'st.connection_id as connection_id')
      : [];

    const connectionIds = new Set<number>();
    for (const p of products as { connection_id: number | null }[]) if (p.connection_id) connectionIds.add(p.connection_id);
    for (const r of sourceRows as { connection_id: number }[]) if (r.connection_id) connectionIds.add(r.connection_id);
    const connRows = connectionIds.size
      ? await db('connections')
          .whereIn('id', Array.from(connectionIds))
          .select('id', 'name', 'type', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; type: string; connectorType: string | null }>(
      connRows.map((c: { id: number; name: string; type: string; connector_type: string | null }) =>
        [c.id, { id: c.id, name: c.name, type: c.type, connectorType: c.connector_type }] as const,
      ),
    );

    // product_id → connection_id → table_count
    const tallies = new Map<number, Map<number, number>>();
    for (const r of sourceRows as { product_id: number; connection_id: number }[]) {
      if (!r.connection_id) continue;
      let inner = tallies.get(r.product_id);
      if (!inner) { inner = new Map(); tallies.set(r.product_id, inner); }
      inner.set(r.connection_id, (inner.get(r.connection_id) ?? 0) + 1);
    }

    type RawProduct = {
      id: number;
      connection_id: number | null;
      star_schema_count?: string | number;
      kpi_count?: string | number;
      table_count?: string | number;
      last_refreshed_at?: Date | string | null;
    };
    const enriched = (products as RawProduct[]).map((p) => {
      const inner = tallies.get(p.id);
      const contributors = inner
        ? Array.from(inner.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])
        : [];
      // Primary connection: most-tables wins, fallback to data_products.connection_id.
      const primaryId = contributors[0]?.[0] ?? p.connection_id ?? null;
      const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
      const otherIds = contributors.slice(1).map(([id]) => id);
      const otherSources = otherIds
        .map((id) => connMap.get(id))
        .filter((c): c is NonNullable<typeof c> => !!c);
      const multiSource = contributors.length > 1;
      // The product's stored connection_id pointed at a row we couldn't load
      // (cascade delete left the FK NULL or the connection row vanished
      // outside the tenant filter). Surface that explicitly so the UI can
      // render a "Source deleted" pill rather than a silent "Unknown".
      const sourceDeleted = primaryId != null && !primaryConn;
      return {
        ...p,
        // Cast pg COUNT(*) (string) and MAX(timestamp) (Date) so the
        // frontend can use them without runtime coercion.
        star_schema_count: Number(p.star_schema_count ?? 0),
        kpi_count:         Number(p.kpi_count ?? 0),
        table_count:       Number(p.table_count ?? 0),
        last_refreshed_at: p.last_refreshed_at instanceof Date
                             ? p.last_refreshed_at.toISOString()
                             : (p.last_refreshed_at ?? null),
        source: {
          id: primaryConn?.id ?? null,
          name: primaryConn?.name ?? null,
          connectorType: primaryConn?.connectorType ?? null,
          multiSource,
          sourceDeleted,
          otherSources,
        },
      };
    });

    res.json(paginatedResponse(enriched, Number(total), page, limit));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/catalog/by-source — Two-tier catalog grouped by source
//
// Drives the new /catalog split view: per-source bands with two columns
// (Analytics on the left, Reference data on the right). Reference products
// are "unfolded" — each constituent product_table becomes its own first-
// class card so users see the actual entity (Customer / Item / GL account)
// instead of a vague "Reference" wrapper. The product_id is preserved on
// each reference card so downstream APIs (refresh-history, quality, etc.)
// keep working unchanged.
// ---------------------------------------------------------------------------

interface AnalyticsCardOut {
  productId: number;
  name: string;
  description: string | null;
  status: string;
  metricCount: number;
  factCount: number;
  tableCount: number;
  lastRefreshedAt: string | null;
}

interface ReferenceCardOut {
  productId: number;       // the wrapping data_product (kept for stability)
  tableId: number;         // the addressable product_table — what we open
  name: string;            // table display_name or table_name
  description: string | null;
  rowCount: number | null;
  lastRefreshedAt: string | null;
  usedIn: Array<{ productId: number; name: string }>;
}

interface SourceBlockOut {
  connectionId: number | null;
  name: string;
  connectorType: string | null;
  sourceDeleted: boolean;
  analytics: AnalyticsCardOut[];
  reference: ReferenceCardOut[];
}

router.get('/catalog/by-source', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (tenantId) {
      }

    // 1. Pull every data_product with the same primary-source enrichment
    //    used by GET /. Same rules: most-tables-contributed connection wins,
    //    falls back to data_products.connection_id, sourceDeleted when the
    //    connection has been removed.
    const products = await db('data_products')
      .select(
        'id', 'name', 'description', 'status', 'kind', 'connection_id',
      )
      .select(
        db.raw('(SELECT COUNT(*) FROM product_kpis WHERE product_kpis.data_product_id = data_products.id) as kpi_count'),
        db.raw(`(
          SELECT COUNT(*) FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as table_count`),
        db.raw(`(
          SELECT COUNT(*) FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.table_role = 'fact'
        ) as fact_count`),
        db.raw(`(
          SELECT MAX(pt.last_run_at) FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as last_refreshed_at`),
      )
      .orderBy('data_products.name');

    if (products.length === 0) {
      res.json({ ok: true, data: { sources: [] } });
      return;
    }

    const productIds = products.map((p: { id: number }) => p.id);

    // 2. Resolve primary source per product (tally + fallback).
    const sourceRows = await db('data_product_sources as dps')
      .join('source_tables as st', 'st.id', 'dps.source_table_id')
      .whereIn('dps.data_product_id', productIds)
      .select('dps.data_product_id as product_id', 'st.connection_id as connection_id');

    const tallies = new Map<number, Map<number, number>>();
    for (const r of sourceRows as { product_id: number; connection_id: number }[]) {
      if (!r.connection_id) continue;
      let inner = tallies.get(r.product_id);
      if (!inner) { inner = new Map(); tallies.set(r.product_id, inner); }
      inner.set(r.connection_id, (inner.get(r.connection_id) ?? 0) + 1);
    }

    const connIds = new Set<number>();
    for (const p of products as Array<{ connection_id: number | null }>) {
      if (p.connection_id) connIds.add(p.connection_id);
    }
    for (const r of sourceRows as { connection_id: number }[]) {
      if (r.connection_id) connIds.add(r.connection_id);
    }
    const connRows = connIds.size
      ? await db('connections')
          .whereIn('id', Array.from(connIds))
          .select('id', 'name', 'type', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; type: string; connectorType: string | null }>(
      connRows.map((c: { id: number; name: string; type: string; connector_type: string | null }) =>
        [c.id, { id: c.id, name: c.name, type: c.type, connectorType: c.connector_type }] as const,
      ),
    );

    // 3. For reference-kind products, pull every product_table so we can
    //    unfold them into individual reference cards.
    const referenceProductIds = (products as Array<{ id: number; kind: string }>)
      .filter((p) => p.kind === 'reference')
      .map((p) => p.id);

    const referenceTables = referenceProductIds.length
      ? await db('product_tables as pt')
          .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
          .whereIn('ss.data_product_id', referenceProductIds)
          .where('pt.transformation_status', 'success')
          .select(
            'pt.id as table_id',
            'pt.table_name',
            'pt.display_name',
            'pt.description',
            'pt.row_count',
            'pt.last_run_at',
            'ss.data_product_id as product_id',
          )
          .orderBy(['ss.data_product_id', 'pt.table_name'])
      : [];

    // 4. Compute "used by" per reference table. Two strategies, unioned:
    //    (a) product_relationships rows linking a fact INTO this dim
    //        — works for the rare same-star-schema case.
    //    (b) product_columns.fk_target_table name-matching across
    //        analytics products attributed to the same source — the
    //        dominant real-world case where a dim lives in a "Reference"
    //        product and the consuming fact lives in a "Sales" product
    //        (different data_products, different star_schemas, so (a)
    //        can never find them by design).
    const refTableIds = referenceTables.map((t: { table_id: number }) => t.table_id);
    const usedByMap = new Map<number, Array<{ productId: number; name: string }>>();

    // (a) Same-star-schema relationship rows
    const usageRows = refTableIds.length
      ? await db('product_relationships as pr')
          .join('product_tables as pt_from', 'pt_from.id', 'pr.from_table_id')
          .join('star_schemas as ss', 'pt_from.star_schema_id', 'ss.id')
          .join('data_products as dp', 'dp.id', 'ss.data_product_id')
          .whereIn('pr.to_table_id', refTableIds)
          .where('dp.kind', 'analytics')
          .select(
            'pr.to_table_id as ref_table_id',
            'dp.id as analytics_product_id',
            'dp.name as analytics_product_name',
          )
      : [];
    for (const u of usageRows as { ref_table_id: number; analytics_product_id: number; analytics_product_name: string }[]) {
      const list = usedByMap.get(u.ref_table_id) ?? [];
      if (!list.some((x) => x.productId === u.analytics_product_id)) {
        list.push({ productId: u.analytics_product_id, name: u.analytics_product_name });
      }
      usedByMap.set(u.ref_table_id, list);
    }

    // (b) + (c) Name-flexible matching across same-source analytics
    //     products. Two strategies combined per ref table:
    //
    //     (b) fk_target_table case-insensitive match across name variants
    //         (handles `dim_account` ↔ `Account` ↔ `account`).
    //     (c) SQL-scan: a dim's table_name MUST appear in any fact that
    //         joins to it, because dependency dims are loaded into DuckDB
    //         as views named after their table_name. This is the most
    //         reliable signal — works even when the AI didn't populate
    //         fk_target_table consistently.
    if (refTableIds.length > 0) {
      type RefMeta = {
        tableId: number;
        productId: number;
        connectionId: number | null;
        variants: string[];
      };
      const refMeta: RefMeta[] = (referenceTables as Array<{
        table_id: number; table_name: string; display_name: string | null; product_id: number;
      }>).map((t) => {
        const owner = (products as Array<{ id: number; connection_id: number | null; kind: string }>)
          .find((p) => p.id === t.product_id);
        const ownerContributors = tallies.get(t.product_id);
        const inferredConn = ownerContributors && ownerContributors.size > 0
          ? Array.from(ownerContributors.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
          : (owner?.connection_id ?? null);
        return {
          tableId: t.table_id,
          productId: t.product_id,
          connectionId: inferredConn,
          variants: dimNameVariants(t.table_name, t.display_name),
        };
      });

      // Group analytics-product ids per connection.
      const analyticsByConn = new Map<number, number[]>();
      for (const p of products as Array<{ id: number; kind: string; connection_id: number | null }>) {
        if (p.kind !== 'analytics') continue;
        const inner = tallies.get(p.id);
        const primary = inner && inner.size > 0
          ? Array.from(inner.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
          : p.connection_id;
        if (primary == null) continue;
        const list = analyticsByConn.get(primary) ?? [];
        list.push(p.id);
        analyticsByConn.set(primary, list);
      }

      // For each source, fetch fk_target_table rows AND fact SQLs ONCE.
      type FkRow = {
        analytics_product_id: number; analytics_product_name: string;
        fk_target: string;
      };
      type SqlRow = {
        analytics_product_id: number; analytics_product_name: string;
        sql: string | null;
      };
      const fkByConn = new Map<number, FkRow[]>();
      const sqlByConn = new Map<number, SqlRow[]>();
      for (const [connId, analyticsIds] of analyticsByConn.entries()) {
        if (analyticsIds.length === 0) continue;
        const fkRows = await db('product_columns as pc')
          .join('product_tables as pt_from', 'pt_from.id', 'pc.product_table_id')
          .join('star_schemas as ss', 'pt_from.star_schema_id', 'ss.id')
          .join('data_products as dp', 'dp.id', 'ss.data_product_id')
          .whereIn('dp.id', analyticsIds)
          .andWhere('pt_from.table_role', 'fact')
          .whereNotNull('pc.fk_target_table')
          .select(
            'dp.id as analytics_product_id',
            'dp.name as analytics_product_name',
            'pc.fk_target_table as fk_target',
          );
        fkByConn.set(connId, fkRows as FkRow[]);

        const sqlRows = await db('product_tables as pt_from')
          .join('star_schemas as ss', 'pt_from.star_schema_id', 'ss.id')
          .join('data_products as dp', 'dp.id', 'ss.data_product_id')
          .whereIn('dp.id', analyticsIds)
          .andWhere('pt_from.table_role', 'fact')
          .whereNotNull('pt_from.transformation_sql')
          .select(
            'dp.id as analytics_product_id',
            'dp.name as analytics_product_name',
            'pt_from.transformation_sql as sql',
          );
        sqlByConn.set(connId, sqlRows as SqlRow[]);
      }

      // Match each ref table against its source's fk / SQL pools.
      for (const meta of refMeta) {
        if (meta.connectionId == null) continue;
        const variantSetLc = new Set(meta.variants.map((v) => v.toLowerCase()));
        const list = usedByMap.get(meta.tableId) ?? [];

        // (b) fk_target_table matches
        const fkRows = fkByConn.get(meta.connectionId) ?? [];
        for (const r of fkRows) {
          if (!variantSetLc.has(String(r.fk_target).toLowerCase())) continue;
          if (!list.some((x) => x.productId === r.analytics_product_id)) {
            list.push({ productId: r.analytics_product_id, name: r.analytics_product_name });
          }
        }

        // (c) SQL-scan matches
        const sqlRows = sqlByConn.get(meta.connectionId) ?? [];
        for (const r of sqlRows) {
          if (!sqlReferencesAnyVariant(r.sql, meta.variants)) continue;
          if (!list.some((x) => x.productId === r.analytics_product_id)) {
            list.push({ productId: r.analytics_product_id, name: r.analytics_product_name });
          }
        }

        if (list.length > 0) usedByMap.set(meta.tableId, list);
      }
    }

    // 5. Assemble per-source blocks. A source's block contains its analytics
    //    products and its reference cards (one per dim table from any
    //    reference-kind product attributed to that source).
    type RawProduct = {
      id: number;
      name: string;
      description: string | null;
      status: string;
      kind: 'analytics' | 'reference';
      connection_id: number | null;
      kpi_count?: string | number;
      table_count?: string | number;
      fact_count?: string | number;
      last_refreshed_at?: Date | string | null;
    };

    function isoOrNull(v: Date | string | null | undefined): string | null {
      if (!v) return null;
      return v instanceof Date ? v.toISOString() : String(v);
    }

    type Block = {
      connectionId: number | null;
      name: string;
      connectorType: string | null;
      sourceDeleted: boolean;
      analytics: AnalyticsCardOut[];
      reference: ReferenceCardOut[];
    };

    const blocks = new Map<string, Block>();
    function bucketKey(connId: number | null, sourceDeleted: boolean): string {
      if (sourceDeleted) return 'deleted';
      if (connId == null) return 'unassigned';
      return `c:${connId}`;
    }
    function ensureBlock(connId: number | null, name: string, connectorType: string | null, sourceDeleted: boolean): Block {
      const key = bucketKey(connId, sourceDeleted);
      let b = blocks.get(key);
      if (!b) {
        b = {
          connectionId: connId,
          name,
          connectorType,
          sourceDeleted,
          analytics: [],
          reference: [],
        };
        blocks.set(key, b);
      }
      return b;
    }

    for (const raw of products as RawProduct[]) {
      const inner = tallies.get(raw.id);
      const contributors = inner
        ? Array.from(inner.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])
        : [];
      const primaryId = contributors[0]?.[0] ?? raw.connection_id ?? null;
      const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
      const sourceDeleted = primaryId != null && !primaryConn;
      const blockName = primaryConn?.name ?? (sourceDeleted ? 'Source deleted' : 'Unassigned');
      const block = ensureBlock(primaryConn?.id ?? null, blockName, primaryConn?.connectorType ?? null, sourceDeleted);

      if (raw.kind === 'reference') {
        // Unfold into individual reference cards.
        const dims = referenceTables.filter((t: { product_id: number }) => t.product_id === raw.id);
        for (const t of dims as Array<{
          table_id: number; table_name: string; display_name: string | null;
          description: string | null; row_count: number | null;
          last_run_at: Date | string | null;
        }>) {
          block.reference.push({
            productId: raw.id,
            tableId: t.table_id,
            name: t.display_name ?? t.table_name,
            description: t.description ?? raw.description,
            rowCount: t.row_count != null ? Number(t.row_count) : null,
            lastRefreshedAt: isoOrNull(t.last_run_at),
            usedIn: usedByMap.get(t.table_id) ?? [],
          });
        }
      } else {
        block.analytics.push({
          productId: raw.id,
          name: raw.name,
          description: raw.description,
          status: raw.status,
          metricCount: Number(raw.kpi_count ?? 0),
          factCount: Number(raw.fact_count ?? 0),
          tableCount: Number(raw.table_count ?? 0),
          lastRefreshedAt: isoOrNull(raw.last_refreshed_at ?? null),
        });
      }
    }

    // Sort: real sources alphabetically, then 'Unassigned', then 'Source deleted'.
    const ordered: SourceBlockOut[] = Array.from(blocks.values())
      .sort((a, b) => {
        const aBucket = a.sourceDeleted ? 2 : a.connectionId == null ? 1 : 0;
        const bBucket = b.sourceDeleted ? 2 : b.connectionId == null ? 1 : 0;
        if (aBucket !== bBucket) return aBucket - bBucket;
        return a.name.localeCompare(b.name);
      });

    res.json({ ok: true, data: { sources: ordered } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/tables/:tableId/used-by — Reverse-lineage for a dim
//
// Powers the "Used in" tab on the new ReferenceDetailPanel. Returns the
// list of analytics products whose star-schema relationships reach into
// this dim table. Cheap join; useful for the curator answering "who
// would I break if I rename a column on this dim?"
// ---------------------------------------------------------------------------

/**
 * Build the set of name variants we'll match against `fk_target_table`
 * and search for inside fact SQL. The AI is inconsistent about which
 * form it uses, so we accept many: `dim_account`, `Account`, `account`,
 * `accounts`. Case-insensitive equality, whole-word search inside SQL.
 */
function dimNameVariants(tableName: string | null, displayName: string | null): string[] {
  const out = new Set<string>();
  for (const raw of [tableName, displayName]) {
    if (!raw) continue;
    const t = String(raw);
    out.add(t);
    out.add(t.toLowerCase());
    const stripped = t.toLowerCase().replace(/^dim[_\s-]+/i, '').replace(/^dimension[_\s-]+/i, '');
    if (stripped) {
      out.add(stripped);
      // Plural / singular variants. Cheap; common AI inconsistency.
      out.add(stripped.endsWith('s') ? stripped.slice(0, -1) : stripped + 's');
    }
  }
  return Array.from(out).filter(Boolean);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns true if any variant of `dimName` appears as a whole word
 *  inside the SQL — i.e. the fact's transformation_sql actually joins
 *  to this dim. The most reliable signal for cross-product usage,
 *  because dependency dims get loaded into DuckDB as views named after
 *  their `table_name` and the fact SQL has to reference that view to
 *  materialise. */
function sqlReferencesAnyVariant(sql: string | null | undefined, variants: string[]): boolean {
  if (!sql) return false;
  for (const v of variants) {
    if (v.length < 3) continue;  // skip noise like "a", "ID"
    const re = new RegExp(`\\b${escapeRegex(v)}\\b`, 'i');
    if (re.test(sql)) return true;
  }
  return false;
}

router.get('/tables/:tableId/used-by', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tableId = Number(req.params.tableId);
    if (!Number.isFinite(tableId)) {
      res.status(400).json({ ok: false, error: 'invalid tableId' });
      return;
    }
    const debug = req.query.debug === '1';
    const tenantId = req.user?.tenantId;
    if (tenantId) {
      }

    // Identify the dim we're being asked about + its source. We need the
    // source so the FK-name + SQL-scanning fallbacks stay scoped to the
    // same connection — otherwise EO.dim_account would claim to be "used
    // by" any wholesale_erp fact with a similarly-named FK column.
    const dimRow = await db('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'dp.id', 'ss.data_product_id')
      .where('pt.id', tableId)
      .select(
        'pt.table_name as dim_table_name',
        'pt.display_name as dim_display_name',
        'dp.id as dim_product_id',
        'dp.connection_id as dim_connection_id',
      )
      .first();

    if (!dimRow) {
      res.json({ ok: true, data: [] });
      return;
    }

    interface UsageOut {
      productId: number;
      productName: string;
      kind: string;
      factTable: string;
      joinColumns: Array<{ fact: string; dim: string }>;
      detectedVia?: string;   // diagnostic
    }
    const byKey = new Map<string, UsageOut>();
    const debugInfo: Record<string, unknown> = {};

    const variants = dimNameVariants(dimRow.dim_table_name, dimRow.dim_display_name);
    if (debug) {
      debugInfo.dim = {
        tableName: dimRow.dim_table_name,
        displayName: dimRow.dim_display_name,
        productId: dimRow.dim_product_id,
        connectionId: dimRow.dim_connection_id,
      };
      debugInfo.candidateNameVariants = variants;
    }

    // Strategy 1: product_relationships within a star_schema. Rarely fires
    // for cross-product refs but cheap and authoritative when it does.
    const relRows = await db('product_relationships as pr')
      .join('product_tables as pt_from', 'pt_from.id', 'pr.from_table_id')
      .join('star_schemas as ss', 'pt_from.star_schema_id', 'ss.id')
      .join('data_products as dp', 'dp.id', 'ss.data_product_id')
      .where('pr.to_table_id', tableId)
      .select(
        'dp.id as product_id',
        'dp.name as product_name',
        'dp.kind as kind',
        'pt_from.table_name as fact_table_name',
        'pr.from_column_name as fact_column',
        'pr.to_column_name as dim_column',
      );

    for (const r of relRows as Array<{
      product_id: number; product_name: string; kind: string;
      fact_table_name: string; fact_column: string; dim_column: string;
    }>) {
      if (r.product_id === Number(dimRow.dim_product_id)) continue;
      const key = `${r.product_id}::${r.fact_table_name}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.joinColumns.some((j) => j.fact === r.fact_column)) {
          existing.joinColumns.push({ fact: r.fact_column, dim: r.dim_column });
        }
      } else {
        byKey.set(key, {
          productId: r.product_id,
          productName: r.product_name,
          kind: r.kind,
          factTable: r.fact_table_name,
          joinColumns: [{ fact: r.fact_column, dim: r.dim_column }],
          detectedVia: 'product_relationships',
        });
      }
    }
    if (debug) debugInfo.strategy1_relationships_found = relRows.length;

    // Same-source analytics products — needed by strategies 2 + 3.
    const sameSourceProductIds = dimRow.dim_connection_id != null
      ? (await db('data_products')
          .where('connection_id', dimRow.dim_connection_id)
          .andWhere('kind', 'analytics')
          .pluck<number[]>('id'))
      : [];
    if (debug) debugInfo.sameSourceAnalyticsProductIds = sameSourceProductIds;

    // Strategy 2: case-insensitive fk_target_table match across same-source
    // analytics products' fact tables.
    if (variants.length > 0 && sameSourceProductIds.length > 0) {
      const variantSetLc = new Set(variants.map((v) => v.toLowerCase()));
      // Pull all candidate FK columns then match in JS (case-insensitive).
      const fkCandidates = await db('product_columns as pc')
        .join('product_tables as pt_from', 'pt_from.id', 'pc.product_table_id')
        .join('star_schemas as ss', 'pt_from.star_schema_id', 'ss.id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .whereIn('dp.id', sameSourceProductIds)
        .andWhere('pt_from.table_role', 'fact')
        .whereNotNull('pc.fk_target_table')
        .select(
          'dp.id as product_id',
          'dp.name as product_name',
          'dp.kind as kind',
          'pt_from.table_name as fact_table_name',
          'pc.column_name as fact_column',
          'pc.fk_target_table as fk_target',
          'pc.fk_target_column as dim_column',
        );

      let matchCount = 0;
      for (const r of fkCandidates as Array<{
        product_id: number; product_name: string; kind: string;
        fact_table_name: string; fact_column: string; fk_target: string;
        dim_column: string | null;
      }>) {
        if (!variantSetLc.has(String(r.fk_target).toLowerCase())) continue;
        matchCount++;
        const key = `${r.product_id}::${r.fact_table_name}`;
        const existing = byKey.get(key);
        const join = { fact: r.fact_column, dim: r.dim_column ?? '' };
        if (existing) {
          if (!existing.joinColumns.some((j) => j.fact === join.fact)) {
            existing.joinColumns.push(join);
          }
        } else {
          byKey.set(key, {
            productId: r.product_id,
            productName: r.product_name,
            kind: r.kind,
            factTable: r.fact_table_name,
            joinColumns: [join],
            detectedVia: 'fk_target_table',
          });
        }
      }
      if (debug) {
        debugInfo.strategy2_fk_match = {
          candidatesScanned: fkCandidates.length,
          matched: matchCount,
          fkTargetsSeen: Array.from(new Set(
            (fkCandidates as Array<{ fk_target: string }>).map((r) => r.fk_target),
          )),
        };
      }
    }

    // Strategy 3: SQL-scan. Dependency dims are loaded as DuckDB views
    // named after the dim's table_name, so the fact's transformation_sql
    // MUST contain that name as a whole word for the JOIN to work. This
    // is the most reliable signal — independent of whether the AI
    // populated fk_target_table — and catches the dominant real-world
    // case the user reported.
    if (variants.length > 0 && sameSourceProductIds.length > 0) {
      const factSqls = await db('product_tables as pt_from')
        .join('star_schemas as ss', 'pt_from.star_schema_id', 'ss.id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .whereIn('dp.id', sameSourceProductIds)
        .andWhere('pt_from.table_role', 'fact')
        .whereNotNull('pt_from.transformation_sql')
        .select(
          'dp.id as product_id',
          'dp.name as product_name',
          'dp.kind as kind',
          'pt_from.id as fact_table_id',
          'pt_from.table_name as fact_table_name',
          'pt_from.transformation_sql as sql',
        );

      let sqlMatchCount = 0;
      const matchedFactIds: number[] = [];
      for (const r of factSqls as Array<{
        product_id: number; product_name: string; kind: string;
        fact_table_id: number; fact_table_name: string; sql: string | null;
      }>) {
        if (!sqlReferencesAnyVariant(r.sql, variants)) continue;
        sqlMatchCount++;
        matchedFactIds.push(r.fact_table_id);
        const key = `${r.product_id}::${r.fact_table_name}`;
        const existing = byKey.get(key);
        if (existing) {
          // Already detected by an earlier strategy — keep its joinColumns.
        } else {
          byKey.set(key, {
            productId: r.product_id,
            productName: r.product_name,
            kind: r.kind,
            factTable: r.fact_table_name,
            joinColumns: [],   // SQL scan can't enumerate columns reliably
            detectedVia: 'sql_scan',
          });
        }
      }
      if (debug) {
        debugInfo.strategy3_sql_scan = {
          factSqlsScanned: factSqls.length,
          matched: sqlMatchCount,
          matchedFactIds,
        };
      }
    }

    const data = Array.from(byKey.values()).sort((a, b) =>
      a.productName.localeCompare(b.productName) || a.factTable.localeCompare(b.factTable),
    );

    if (debug) {
      res.json({ ok: true, data, debug: debugInfo });
    } else {
      // Strip the diagnostic field from the public response shape.
      const clean = data.map(({ detectedVia: _ignored, ...rest }) => rest);
      res.json({ ok: true, data: clean });
    }
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products — Create a data product
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, description, connectionId, sourceTables } = req.body as {
      name: string;
      description?: string;
      connectionId: number;
      sourceTables: { sourceTableId: number; tableName: string }[];
    };

    if (!name?.trim()) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }

    const [row] = await db('data_products')
      .insert({
        name,
        description: description ?? null,
        connection_id: connectionId,
        status: 'draft',
        created_by: req.user!.sub,
      })
      .returning('id');

    const productId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);

    // Insert source table selections
    if (sourceTables?.length) {
      await db('data_product_sources').insert(
        sourceTables.map((s) => ({
          data_product_id: productId,
          source_table_id: s.sourceTableId,
          table_name: s.tableName,
        })),
      );
    }

    await recordAudit(req, {
      action:     'product.create',
      entityType: 'product',
      entityId:   productId,
      context:    { name, connection_id: connectionId, source_table_count: sourceTables?.length ?? 0 },
    });

    res.json({ ok: true, data: { id: productId } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/dependency-graph — All dependency edges for this tenant
// Must be before /:id routes to avoid being captured by the param handler
// ---------------------------------------------------------------------------

router.get('/dependency-graph', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const deps = await db('data_product_dependencies')
      .select('dependent_product_id', 'source_product_id');
    res.json({ ok: true, data: deps });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/by-source-table/:sourceTableId — Products referencing a source table
// Must be before /:id routes to avoid being captured by the param handler
// ---------------------------------------------------------------------------

router.get('/by-source-table/:sourceTableId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const sourceTableId = Number(req.params.sourceTableId);
    if (!Number.isFinite(sourceTableId)) {
      res.status(400).json({ ok: false, error: 'sourceTableId required' });
      return;
    }
    const rows = await db('data_product_sources as dps')
      .join('data_products as dp', 'dp.id', 'dps.data_product_id')
      .where('dps.source_table_id', sourceTableId)
      .select('dp.id', 'dp.name', 'dp.status');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id — Full data product with star schemas, tables, columns, lineage, relationships
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Star schemas
    const schemas = await db('star_schemas')
      .where({ data_product_id: product.id })
      .orderBy('id');

    // Tables
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const rawTables = schemaIds.length
      ? await db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .orderBy(['dag_order', 'table_name'])
      : [];

    // Enrich reference rows (rows that point at an owner via source_product_table_id)
    // with the owner's freshness fields and product name. Without this, a consumer
    // product's UI shows stale "last_run_at" / row_count for shared dims that are
    // only physically rebuilt under their owning product.
    const ownerIds = rawTables
      .map((t: { source_product_table_id?: number | null }) => t.source_product_table_id)
      .filter((id): id is number => typeof id === 'number');
    const owners = ownerIds.length
      ? await db('product_tables as pt')
          .leftJoin('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
          .leftJoin('data_products as dp', 'ss.data_product_id', 'dp.id')
          .whereIn('pt.id', ownerIds)
          .select(
            'pt.id', 'pt.transformation_status', 'pt.last_run_at',
            'pt.last_run_error', 'pt.row_count', 'pt.delta_path',
            'dp.id as owner_product_id', 'dp.name as owner_product_name',
          )
      : [];
    const ownerById = new Map(owners.map((o: { id: number }) => [o.id, o]));

    const tables: any[] = rawTables.map((t: any) => {
      const ownerId = t.source_product_table_id as number | null | undefined;
      if (!ownerId) return t;
      const owner = ownerById.get(ownerId) as any;
      if (!owner) return t;
      return {
        ...t,
        transformation_status: owner.transformation_status ?? t.transformation_status,
        last_run_at: owner.last_run_at ?? t.last_run_at,
        last_run_error: owner.last_run_error ?? t.last_run_error,
        row_count: owner.row_count ?? t.row_count,
        delta_path: owner.delta_path ?? t.delta_path,
        owner_product_id: owner.owner_product_id ?? null,
        owner_product_name: owner.owner_product_name ?? null,
        is_reference: true,
      };
    });

    // Columns. Hide technical columns (`_row_hash` today; future SCD2
    // metadata) from the product detail panel — these are physical-storage
    // concerns the curator never authors or describes.
    const tableIds = tables.map((t: { id: number }) => t.id);
    const columns = tableIds.length
      ? await db('product_columns')
          .whereIn('product_table_id', tableIds)
          .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
          .orderBy(['sort_order', 'id'])
      : [];

    // Lineage
    const columnIds = columns.map((c: { id: number }) => c.id);
    const lineage = columnIds.length
      ? await db('column_lineage').whereIn('product_column_id', columnIds)
      : [];

    // Relationships
    const relationships = schemaIds.length
      ? await db('product_relationships as pr')
          .join('product_tables as ft', 'pr.from_table_id', 'ft.id')
          .join('product_tables as tt', 'pr.to_table_id', 'tt.id')
          .whereIn('pr.star_schema_id', schemaIds)
          .select(
            'pr.id', 'pr.star_schema_id',
            'ft.table_name as from_table_name', 'pr.from_column_name',
            'tt.table_name as to_table_name', 'pr.to_column_name',
            'pr.relationship_type',
          )
      : [];

    // Transformation quality checks
    const checks = tableIds.length
      ? await db('transformation_checks').whereIn('product_table_id', tableIds)
      : [];

    const checksByTable = new Map<number, typeof checks>();
    for (const c of checks) {
      const arr = checksByTable.get(c.product_table_id) ?? [];
      arr.push(c);
      checksByTable.set(c.product_table_id, arr);
    }

    // Assemble nested response
    const lineageByCol = new Map<number, typeof lineage>();
    for (const l of lineage) {
      const arr = lineageByCol.get(l.product_column_id) ?? [];
      arr.push(l);
      lineageByCol.set(l.product_column_id, arr);
    }

    const colsByTable = new Map<number, (typeof columns[0] & { lineage: typeof lineage })[]>();
    for (const c of columns) {
      const arr = colsByTable.get(c.product_table_id) ?? [];
      arr.push({ ...c, lineage: lineageByCol.get(c.id) ?? [] });
      colsByTable.set(c.product_table_id, arr);
    }

    const tablesBySchema = new Map<number, (typeof tables[0] & { columns: unknown[]; quality_checks: unknown[] })[]>();
    for (const t of tables) {
      const arr = tablesBySchema.get(t.star_schema_id) ?? [];
      arr.push({ ...t, columns: colsByTable.get(t.id) ?? [], quality_checks: checksByTable.get(t.id) ?? [] });
      tablesBySchema.set(t.star_schema_id, arr);
    }

    const relsBySchema = new Map<number, typeof relationships>();
    for (const r of relationships) {
      const arr = relsBySchema.get(r.star_schema_id) ?? [];
      arr.push(r);
      relsBySchema.set(r.star_schema_id, arr);
    }

    // Compute the same `source` block the list endpoint returns so the
    // detail panel can show <SourceBadge> consistently with /products and
    // the catalog tree.
    const dpsRows = await db('data_product_sources as dps')
      .join('source_tables as st', 'st.id', 'dps.source_table_id')
      .where('dps.data_product_id', product.id)
      .select('st.connection_id as connection_id');
    const tally = new Map<number, number>();
    for (const r of dpsRows as { connection_id: number }[]) {
      if (!r.connection_id) continue;
      tally.set(r.connection_id, (tally.get(r.connection_id) ?? 0) + 1);
    }
    const contributors = Array.from(tally.entries()).sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    );
    const primaryId = contributors[0]?.[0] ?? product.connection_id ?? null;
    const involvedIds = new Set<number>(contributors.map(([id]) => id));
    if (product.connection_id) involvedIds.add(product.connection_id);
    const connRows = involvedIds.size
      ? await db('connections')
          .whereIn('id', Array.from(involvedIds))
          .select('id', 'name', 'connector_type')
      : [];
    const connMap = new Map<number, { id: number; name: string; connector_type: string | null }>(
      connRows.map((c: { id: number; name: string; connector_type: string | null }) => [c.id, c] as const),
    );
    const primaryConn = primaryId != null ? connMap.get(primaryId) ?? null : null;
    const otherSources = contributors.slice(1)
      .map(([id]) => connMap.get(id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ id: c.id, name: c.name, connectorType: c.connector_type }));
    const source = {
      id: primaryConn?.id ?? null,
      name: primaryConn?.name ?? null,
      connectorType: primaryConn?.connector_type ?? null,
      multiSource: contributors.length > 1,
      sourceDeleted: primaryId != null && !primaryConn,
      otherSources,
    };

    const result = {
      ...product,
      source,
      star_schemas: schemas.map((s: { id: number }) => ({
        ...s,
        tables: tablesBySchema.get(s.id) ?? [],
        relationships: relsBySchema.get(s.id) ?? [],
      })),
    };

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/products/:id — Update data product
// ---------------------------------------------------------------------------

router.put('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, description, status } = req.body as { name?: string; description?: string; status?: string };
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;

    await db('data_products').where({ id: req.params.id }).update(updates);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/products/:id — Delete data product (cascade)
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);

    // Collect table info before cascading delete removes it
    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await db('star_schemas').where({ data_product_id: productId }).select('id');
    const schemaIds = schemas.map((s: { id: number }) => s.id);
    const tables = schemaIds.length
      ? await db('product_tables').whereIn('star_schema_id', schemaIds).select('table_name', 'delta_path')
      : [];
    const connId = product.connection_id;

    // Clean up quality data for product tables (keyed by connection_id + table_name, no FK cascade)
    for (const t of tables) {
      const tn = t.table_name as string;
      // Delete quality rules (cascades to rule_executions + quality_failures)
      await db('quality_rules').where({ connection_id: connId, table_name: tn }).delete();
      // Delete quality score history
      await db('quality_score_history').where({ connection_id: connId, table_name: tn }).delete();
      // Delete field profiles via dataset_profiles
      const profiles = await db('dataset_profiles')
        .where({ connection_id: connId, table_name: tn }).select('id');
      if (profiles.length) {
        await db('field_profiles').whereIn('profile_id', profiles.map((p: { id: number }) => p.id)).delete();
        await db('dataset_profiles').where({ connection_id: connId, table_name: tn }).delete();
      }
    }

    // Clean up the warehouse data files. We collect every possible
    // location the product's data might live BEFORE we wipe the
    // metadata rows (the catalog reads from those rows).
    //
    // Three sources, in priority order:
    //   1. The catalog's resolved URIs — what `delta_path` actually
    //      says for each materialised product_tables row. Authoritative
    //      because it captures the historical writer's exact location,
    //      including the v1 vs v2 layout chosen at write time.
    //   2. The expected v2 product directory — `tenant_<tid>/product_<pid>`
    //      under the warehouse root. Catches v2 deployments where the
    //      catalog rows might miss empty/never-written directories.
    //   3. The expected v1 product directory — `./warehouse/product/<slug>`
    //      (local) or `az://.../products/<slug>` (azure). Catches
    //      legacy deployments where the catalog rows are gone but the
    //      files were never migrated.
    //
    // Best-effort: per-blob failures are logged into the audit
    // context, never block the DB-row deletion. Orphan blobs are
    // recoverable (and we can re-run cleanup), orphan rows are not.
    const slug = toProductSlug(product.name as string);
    const tenantId = req.user!.tenantId;
    const conn = await db('connections').where({ id: connId }).first();
    const sourceWarehousePath: string = conn?.warehouse_path ?? `./warehouse/conn_${connId}`;

    const urisToDelete = new Set<string>();

    // (1) Resolved URIs from the catalog — one per ready product_tables row.
    try {
      const resolved = await listProductTables(tenantId, productId);
      for (const t of resolved) {
        if (t.uri) urisToDelete.add(t.uri);
      }
    } catch (err) {
      log.warn({ err }, '[products.delete] catalog lookup failed; falling back to layout-based paths');
    }

    // (2) Expected v2 product directory. Stable across renames.
    urisToDelete.add(productBasePathV2(tenantId, productId));

    // (3) Expected v1 product directory. Slug-based; only matters for
    //     legacy deployments. productBasePath handles azure vs local.
    if (warehouseLayoutVersion() === 'v1' || sourceWarehousePath) {
      urisToDelete.add(productBasePath(sourceWarehousePath, slug));
    }

    const warehouseDeleteResult = await deleteWarehousePaths(Array.from(urisToDelete));
    if (warehouseDeleteResult.errors.length > 0) {
      log.warn(
        { errors: warehouseDeleteResult.errors.slice(0, 5) },
        `[products.delete] product=${productId} warehouse cleanup had ${warehouseDeleteResult.errors.length} errors`,
      );
    }
    log.info(
      `product=${productId} deleted ${warehouseDeleteResult.deleted} warehouse file(s) ` +
      `(${warehouseDeleteResult.kind}) from ${urisToDelete.size} candidate path(s)`,
    );

    // Delete product row (cascades to star_schemas → product_tables → product_columns)
    await db('data_products').where({ id: productId }).delete();

    // Remove product graph from Neo4j — fire-and-forget, non-db.
    // Neo4j is a separate store with its own driver/connection pool;
    // a failure here cannot poison the Postgres request transaction.
    deleteProductFromNeo4j(productId).catch(() => {}); // fire-and-forget

    await recordAudit(req, {
      action:     'product.delete',
      entityType: 'product',
      entityId:   productId,
      context: {
        product_name:           product.name,
        kind:                   product.kind,
        tables_deleted:         tables.length,
        warehouse_files_deleted: warehouseDeleteResult.deleted,
        warehouse_storage_kind:  warehouseDeleteResult.kind,
        warehouse_errors:        warehouseDeleteResult.errors.length || undefined,
      },
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/sources — Source tables assigned to this data product
// ---------------------------------------------------------------------------

router.get('/:id/sources', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const sources = await db('data_product_sources')
      .where({ data_product_id: req.params.id })
      .orderBy('table_name');
    res.json({ ok: true, data: sources });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/design-stream — SSE streaming AI star schema design
// Streams thinking tokens, phase updates, and table previews as they appear.
// ---------------------------------------------------------------------------

router.post('/:id/design-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const db = reqDb(req);
  try {
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      emit({ type: 'error', message: 'Data product not found' });
      res.end(); return;
    }

    const sources = await db('data_product_sources').where({ data_product_id: product.id });
    if (sources.length === 0) {
      emit({ type: 'error', message: 'No source tables selected for this data product' });
      res.end(); return;
    }

    // Mark as designing
    await db('data_products').where({ id: product.id }).update({
      status: 'designing', updated_at: new Date().toISOString(),
    });

    emit({ type: 'phase', text: `Reading ${sources.length} source tables...` });

    // Build source context
    const sourceTableNames = sources.map((s: { table_name: string }) => s.table_name);
    const sourceTables = await db('source_tables')
      .where({ connection_id: product.connection_id, is_active: true })
      .whereIn('table_name', sourceTableNames);

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await db('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    const sourceContext = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean; example_values: unknown }) => {
          const examples = c.example_values
            ? ` — samples: ${JSON.stringify(typeof c.example_values === 'string' ? JSON.parse(c.example_values) : c.example_values)}`
            : '';
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}${examples}`;
        }).join('\n');
      return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // ── Load shared dimensions from dependency products ───────────────────
    // These are conformed dims already designed in other products.
    // We inject their schemas so the AI knows NOT to redesign them and can
    // write correct JOIN SQL referencing the right surrogate key columns.
    let sharedDimsContext = '';
    try {
      const deps = await db('data_product_dependencies as dpd')
        .join('data_products as dp', 'dpd.source_product_id', 'dp.id')
        .where('dpd.dependent_product_id', product.id)
        .select('dpd.source_product_id', 'dp.name as source_product_name');

      if (deps.length > 0) {
        const sharedDimBlocks: string[] = [];
        for (const dep of deps) {
          // Owners (is_shared_dimension=false) live in the upstream product
          // and have transformation_sql. Stubs in downstream products are
          // is_shared_dimension=true with null SQL — we want the owners here.
          const sharedTables = await db('product_tables as pt')
            .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
            .where({ 'ss.data_product_id': dep.source_product_id, 'pt.is_shared_dimension': false })
            .where('pt.table_role', 'dimension')
            .whereNotNull('pt.transformation_sql')
            .select('pt.id', 'pt.table_name', 'pt.display_name', 'pt.description');

          for (const tbl of sharedTables) {
            const cols = await db('product_columns')
              .where({ product_table_id: tbl.id })
              .orderBy('sort_order')
              .select('column_name', 'data_type', 'column_role', 'description');

            const colLines = cols.map((c: { column_name: string; data_type: string; column_role: string; description: string }) =>
              `    ${c.column_name} (${c.data_type}) [${c.column_role}]: ${c.description ?? ''}`
            ).join('\n');

            sharedDimBlocks.push(
              `Shared dimension from "${dep.source_product_name}" (already built — reference only, do NOT redesign):\n` +
              `Table: ${tbl.table_name} — ${tbl.description ?? tbl.display_name}\n  Columns:\n${colLines}`
            );
          }
        }
        if (sharedDimBlocks.length > 0) {
          sharedDimsContext = sharedDimBlocks.join('\n\n');
        }
      }
    } catch (depErr) {
      log.warn({ err: depErr }, '[products/design-stream] Could not load dependency dims');
    }

    const fullSourceContext = sharedDimsContext
      ? `${sourceContext}\n\n━━━ CONFORMED DIMENSIONS (owned by other products — JOIN to these, do NOT rebuild) ━━━\n\n${sharedDimsContext}`
      : sourceContext;

    emit({ type: 'phase', text: 'Designing star schema with AI...' });

    // ── Phase 1: Streaming star schema design ─────────────────────────────
    const { generateStarSchemaDesignStreaming } = await import('../ai/AIService');

    const design = await generateStarSchemaDesignStreaming(
      product.name,
      product.description ?? '',
      fullSourceContext,
      (type, delta) => {
        if (type === 'thinking') {
          emit({ type: 'thinking', text: delta });
        }
        // We could parse partial JSON for live table previews, but it's fragile.
        // Instead, we send text deltas so frontend can detect table names in the JSON stream.
        if (type === 'text') {
          emit({ type: 'json_delta', text: delta });
        }
      },
    );

    emit({ type: 'phase', text: 'Saving star schema design...' });

    // ── Save design to DB (same logic as non-streaming endpoint) ──────────
    await db('star_schemas').where({ data_product_id: product.id }).delete();

    const allSavedTables: { name: string; role: string; columnCount: number }[] = [];

    const schema = design.star_schema;
    {
      const [schemaRow] = await db('star_schemas')
        .insert({
          data_product_id: product.id,
          name: schema.name,
          description: schema.description,
          grain: schema.grain,
          fact_table_type: schema.fact_table_type,
        }).returning('id');
      const schemaId: number = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      for (const table of schema.tables) {
        const [tableRow] = await db('product_tables')
          .insert({
            star_schema_id: schemaId,
            table_name: table.table_name,
            display_name: table.display_name,
            description: table.description,
            table_role: table.table_role,
            dag_order: table.dag_order,
            transformation_sql: table.transformation_sql ?? null,
            transformation_status: table.transformation_sql ? 'draft' : 'pending',
            ai_draft: true,
          }).returning('id');
        const tableId: number = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(table.table_name, tableId);

        for (const col of table.columns) {
          const [colRow] = await db('product_columns')
            .insert({
              product_table_id: tableId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            }).returning('id');
          const colId: number = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          // Filter out lineage entries with null source columns (e.g. generated dim_date keys)
          const validLineage = (col.lineage ?? []).filter(
            (l) => l.source_table_name && l.source_column_name,
          );
          if (validLineage.length) {
            await db('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }

        allSavedTables.push({
          name: table.table_name,
          role: table.table_role,
          columnCount: table.columns.length,
        });

        // Emit table preview as each table is saved
        emit({ type: 'table_saved', table: {
          name: table.table_name,
          role: table.table_role,
          description: table.description,
          columns: table.columns.map((c) => ({
            name: c.column_name,
            role: c.column_role,
            type: c.data_type,
          })),
        }});
      }

      // Save relationships
      for (const rel of schema.relationships) {
        const fromTableId = tableNameToId.get(rel.from_table_name);
        const toTableId = tableNameToId.get(rel.to_table_name);
        if (fromTableId && toTableId) {
          await db('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromTableId,
            from_column_name: rel.from_column_name,
            to_table_id: toTableId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // ── Auto-inject dim_date using hardcoded template ──────────────────
      const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');
      const dateRange = design.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };

      const [dimDateRow] = await db('product_tables')
        .insert({
          star_schema_id: schemaId,
          table_name: 'dim_date',
          display_name: 'Date',
          description: 'Auto-generated calendar dimension',
          table_role: 'dimension',
          dag_order: 0,
          transformation_sql: DIM_DATE_SQL(dateRange.start, dateRange.end),
          transformation_status: 'draft',
          ai_draft: false,
        }).returning('id');
      const dimDateId: number = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await db('product_columns')
          .insert({
            product_table_id: dimDateId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            transformation_expression: col.transformation_expression,
            scd_type: col.scd_type,
            sort_order: col.sort_order,
            ai_draft: false,
          });
      }

      allSavedTables.push({
        name: 'dim_date',
        role: 'dimension',
        columnCount: DIM_DATE_COLUMNS.length,
      });

      emit({ type: 'table_saved', table: {
        name: 'dim_date',
        role: 'dimension',
        description: 'Auto-generated calendar dimension',
        columns: DIM_DATE_COLUMNS.map((c) => ({
          name: c.column_name,
          role: c.column_role,
          type: c.data_type,
        })),
      }});
    }

    // Save proposed KPIs
    if (design.proposed_kpis?.length) {
      await db('product_kpis').insert(
        design.proposed_kpis.map((k) => ({
          data_product_id: product.id,
          name: k.name,
          description: k.description,
          formula_plain_text: k.formula_plain_text,
          formula_sql: k.formula_sql,
          ai_draft: true,
        })),
      );
    }

    await db('data_products').where({ id: product.id }).update({
      status: 'approved', updated_at: new Date().toISOString(),
    });

    emit({ type: 'design_complete', tables: allSavedTables });

    emit({ type: 'sql_complete', tablesUpdated: allSavedTables.length });

    // Sync product graph to Neo4j for data dictionary
    await syncProductToNeo4j(product.id);

    emit({ type: 'done' });
    res.end();
  } catch (err: unknown) {
    log.error({ err }, '[products/design-stream] Error');
    // Mark the product as errored in a FRESH transaction. The request
    // trx (`db`) may already be poisoned by whatever blew up upstream
    // (Postgres rejects every statement in a failed trx with 25P02);
    // writing to it would silently no-op. tenantScopedWrite opens its
    // own short trx with the user's tenant context set, so this
    // diagnostic update lands even when the request trx is in
    // failed state.
    const productId = Number(req.params.id);
    if (req.user?.tenantId && Number.isFinite(productId)) {
      try {
        await tenantScopedWrite(req.user.tenantId, (trx) =>
          trx('data_products').where({ id: productId }).update({
            status: 'error', updated_at: new Date().toISOString(),
          }),
        );
      } catch (markErr) {
        log.error({ err: markErr }, '[products/design-stream] failed to mark errored');
      }
    }
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Design failed. Please try again.' });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/design — Trigger AI star schema design (non-streaming)
// ---------------------------------------------------------------------------

router.post('/:id/design', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const db = reqDb(req);
  try {
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    // Get source tables
    const sources = await db('data_product_sources')
      .where({ data_product_id: product.id });

    if (sources.length === 0) {
      res.status(400).json({ ok: false, error: 'No source tables selected for this data product' });
      return;
    }

    // Mark as designing
    await db('data_products').where({ id: product.id }).update({
      status: 'designing',
      updated_at: new Date().toISOString(),
    });

    // Build source context for AI
    const sourceTableNames = sources.map((s: { table_name: string }) => s.table_name);
    const sourceTables = await db('source_tables')
      .where({ connection_id: product.connection_id, is_active: true })
      .whereIn('table_name', sourceTableNames);

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await db('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    // Build context string
    const sourceContext = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean; example_values: unknown }) => {
          const examples = c.example_values
            ? ` — samples: ${JSON.stringify(typeof c.example_values === 'string' ? JSON.parse(c.example_values) : c.example_values)}`
            : '';
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}${examples}`;
        })
        .join('\n');
      return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // Call AI to design star schema
    const { generateStarSchemaDesign } = await import('../ai/AIService');
    const design = await generateStarSchemaDesign(
      product.name,
      product.description ?? '',
      sourceContext,
    );

    // Delete existing schemas for this product (re-design)
    await db('star_schemas').where({ data_product_id: product.id }).delete();

    // Save the design
    const schema = design.star_schema;
    {
      const [schemaRow] = await db('star_schemas')
        .insert({
          data_product_id: product.id,
          name: schema.name,
          description: schema.description,
          grain: schema.grain,
          fact_table_type: schema.fact_table_type,
        })
        .returning('id');
      const schemaId: number = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      // Track table_name → id for relationship resolution
      const tableNameToId = new Map<string, number>();

      for (const table of schema.tables) {
        const [tableRow] = await db('product_tables')
          .insert({
            star_schema_id: schemaId,
            table_name: table.table_name,
            display_name: table.display_name,
            description: table.description,
            table_role: table.table_role,
            dag_order: table.dag_order,
            transformation_sql: table.transformation_sql ?? null,
            transformation_status: table.transformation_sql ? 'draft' : 'pending',
            ai_draft: true,
          })
          .returning('id');
        const tableId: number = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(table.table_name, tableId);

        for (const col of table.columns) {
          const [colRow] = await db('product_columns')
            .insert({
              product_table_id: tableId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            })
            .returning('id');
          const colId: number = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          // Save lineage
          // Filter out lineage entries with null source columns (e.g. generated dim_date keys)
          const validLineage = (col.lineage ?? []).filter(
            (l) => l.source_table_name && l.source_column_name,
          );
          if (validLineage.length) {
            await db('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }
      }

      // Save relationships
      for (const rel of schema.relationships) {
        const fromTableId = tableNameToId.get(rel.from_table_name);
        const toTableId = tableNameToId.get(rel.to_table_name);
        if (fromTableId && toTableId) {
          await db('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromTableId,
            from_column_name: rel.from_column_name,
            to_table_id: toTableId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // ── Auto-inject dim_date using hardcoded template ──────────────────
      const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');
      const dateRange = design.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };

      const [dimDateRow] = await db('product_tables')
        .insert({
          star_schema_id: schemaId,
          table_name: 'dim_date',
          display_name: 'Date',
          description: 'Auto-generated calendar dimension',
          table_role: 'dimension',
          dag_order: 0,
          transformation_sql: DIM_DATE_SQL(dateRange.start, dateRange.end),
          transformation_status: 'draft',
          ai_draft: false,
        }).returning('id');
      const dimDateId: number = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await db('product_columns')
          .insert({
            product_table_id: dimDateId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            transformation_expression: col.transformation_expression,
            scd_type: col.scd_type,
            sort_order: col.sort_order,
            ai_draft: false,
          });
      }
    }

    // Save proposed KPIs
    if (design.proposed_kpis?.length) {
      await db('product_kpis').insert(
        design.proposed_kpis.map((k) => ({
          data_product_id: product.id,
          name: k.name,
          description: k.description,
          formula_plain_text: k.formula_plain_text,
          formula_sql: k.formula_sql,
          ai_draft: true,
        })),
      );
    }

    // Update product status
    await db('data_products').where({ id: product.id }).update({
      status: 'approved',
      updated_at: new Date().toISOString(),
    });

    // Sync product graph to Neo4j for data dictionary
    await syncProductToNeo4j(product.id);

    res.json({ ok: true, data: { status: 'approved', sqlGenerated: true } });
  } catch (err) {
    // Revert status on error. Same trx-poison rationale as the
    // /design-stream handler above — use a fresh tenantScopedWrite
    // so the "mark as error" update isn't lost when req.dbTrx has
    // already been poisoned upstream.
    const productId = Number(req.params.id);
    if (req.user?.tenantId && Number.isFinite(productId)) {
      try {
        await tenantScopedWrite(req.user.tenantId, (trx) =>
          trx('data_products').where({ id: productId }).update({
            status: 'error',
            updated_at: new Date().toISOString(),
          }),
        );
      } catch (markErr) {
        log.error({ err: markErr }, 'failed to mark errored');
      }
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/run — Run all transformations for a data product
// ---------------------------------------------------------------------------

router.post('/:id/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const schemas = await db('star_schemas').where({ data_product_id: product.id });
    const schemaIds = schemas.map((s: { id: number }) => s.id);

    const fetchTables = () => schemaIds.length
      ? db('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .whereNotNull('transformation_sql')
          .orderBy('dag_order', 'asc')
      : Promise.resolve([]);

    const { runProductTransformation } = await import('../services/transformationRunner');

    const tables = await fetchTables();
    const results = await runProductTransformation(product, tables, req.user?.tenantId);

    // Sync updated row counts / status to Neo4j
    syncProductToNeo4j(product.id).catch(() => {}); // non-db — Neo4j graph sync, not a request-trx Knex query

    res.json({ ok: true, data: results });
  } catch (err) { next(err); }
});

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

    const { runProductTransformation } = await import('../services/transformationRunner');

    const result = (await runProductTransformation(product, [table], req.user?.tenantId))[0] ?? null;

    // Sync updated row counts / status to Neo4j
    syncProductToNeo4j(product.id).catch(() => {}); // non-db — Neo4j graph sync, not a request-trx Knex query

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/products/tables/:tableId — Update product table metadata
// (currently: description, display_name)
// ---------------------------------------------------------------------------

router.patch('/tables/:tableId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const allowed = ['description', 'display_name'];
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

router.put('/tables/:tableId/sql', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
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

router.put('/columns/:columnId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
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

    const { draftKpiFormula } = await import('../ai/AIService');
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
    const { getProductStarters } = await import('../services/queryStartersService');
    const result = await getProductStarters(tenantId, productId);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/kpis — Create a KPI
// Role widened to admin+analyst — analysts curate KPIs alongside admins
// (matches the role gating on /semantic confirms).
// ---------------------------------------------------------------------------

router.post('/:id/kpis', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, description, formulaPlainText, formulaSql, ownerName } = req.body as {
      name: string; description?: string; formulaPlainText?: string;
      formulaSql?: string; ownerName?: string;
    };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ ok: false, error: 'KPI name is required' });
      return;
    }

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

router.put('/kpis/:kpiId', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const allowed = ['name', 'description', 'formula_plain_text', 'formula_sql', 'owner_name', 'ai_draft'];
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

// ---------------------------------------------------------------------------
// PATCH /api/products/tables/:tableId/load-mode — Toggle incremental vs full
// Body: { load_mode: 'full' | 'incremental' }
// ---------------------------------------------------------------------------
router.patch('/tables/:tableId/load-mode', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { load_mode } = req.body as { load_mode: 'full' | 'incremental' };
    if (!['full', 'incremental'].includes(load_mode)) {
      res.status(400).json({ ok: false, error: 'load_mode must be "full" or "incremental"' });
      return;
    }
    await db('product_tables')
      .where({ id: req.params.tableId })
      .update({ load_mode });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/run-full — Force a full refresh (ignores load_mode)
// Query: ?include=upstream  also rebuilds upstream dependency products in
// topological order, so shared dims are fresh before consumer facts run.
// ---------------------------------------------------------------------------
router.post('/:id/run-full', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const includeUpstream = String(req.query.include ?? '').toLowerCase() === 'upstream';

    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const { runProductTransformation } = await import('../services/transformationRunner');
    const { resolveUpstreamProductsTopo } = await import('../services/productOwnership');

    // Build the run order: upstream-first if requested, then current product.
    const upstreamIds = includeUpstream
      ? await resolveUpstreamProductsTopo(Number(product.id), tenantId)
      : [];
    const runOrder = [...upstreamIds, Number(product.id)];

    const allResults: Array<{
      product_id: number;
      product_name: string;
      table_name: string;
      status: 'success' | 'error';
      row_count?: number;
      error?: string;
    }> = [];

    for (const pid of runOrder) {
      const p = await db('data_products').where({ id: pid }).first();
      if (!p) continue;

      const schemas = await db('star_schemas').where({ data_product_id: pid });
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      const tables = schemaIds.length
        ? await db('product_tables')
            .whereIn('star_schema_id', schemaIds)
            .whereNotNull('transformation_sql')
            .orderBy('dag_order', 'asc')
        : [];

      // Override load_mode to 'full' for this run only
      const fullTables = tables.map((t: Record<string, unknown>) => ({ ...t, load_mode: 'full' }));

      const results = await runProductTransformation(p, fullTables as any, tenantId);
      for (const r of results) {
        allResults.push({
          product_id: pid,
          product_name: p.name as string,
          ...r,
        });
      }
    }

    res.json({
      ok: true,
      data: allResults,
      meta: {
        run_order: runOrder,
        included_upstream: includeUpstream && upstreamIds.length > 0,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-single — propose exactly one data product
// from a free-text user description. No streaming — returns JSON directly.
// ---------------------------------------------------------------------------

router.post('/propose-single', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const { connectionId, description } = req.body as { connectionId: number; description: string };
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await db('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure');
      const fkRels = await db('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');
      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));
      const bkCol = t.business_key_column as string | null;
      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: c.column_name === 'id' || c.column_name === bkCol,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    const existingProducts = await db('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateStarSchemaDesign } = await import('../ai/AIService');

    const sourceTablesContext = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const desc = description.trim().slice(0, 500);
    const proposal = await generateStarSchemaDesign(
      desc || connection.name as string,
      desc,
      sourceTablesContext,
    );

    return res.json({ ok: true, data: proposal });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to propose data product';
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Bus Matrix — job-based flow (survives browser close, supports cancel)
//
// Endpoints:
//   POST /api/products/bus-matrix/start       → enqueue job, return { jobId }
//   GET  /api/products/bus-matrix/active      → currently running/queued job for tenant
//   GET  /api/products/bus-matrix/:jobId/stream → SSE: tail job logs + progress
//   POST /api/products/bus-matrix/:jobId/cancel → cancel a running job
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/products/:id/refresh-start — enqueue a refresh job for one product
//
// Body: { syncSource?: boolean }
//   - false (default) → just re-runs this product's transformations
//   - true            → triggers source connection sync first, waits for it
//                       to complete, THEN runs transformations. Single click
//                       for the upstream → downstream pipeline.
//
// Returns { jobId } — frontend then attaches via /bus-matrix/:jobId/stream
// (the SSE / cancel / active-job endpoints are mode-agnostic).
// ---------------------------------------------------------------------------
router.post('/:id/refresh-start', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) {
      res.status(400).json({ ok: false, error: 'Invalid product id' });
      return;
    }
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const syncSource = !!(req.body as { syncSource?: boolean })?.syncSource;

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({
        ok: false,
        error: 'Job queue not available — Redis is not configured. Refresh requires Redis to survive browser close.',
      });
      return;
    }

    // Refuse to enqueue a second active refresh for the same product.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find(
      (j) => j.data.tenantId === tenantId && j.data.mode === 'refresh' && j.data.productId === productId,
    );
    if (existing) {
      res.status(409).json({
        ok: false,
        error: 'A refresh is already running for this product.',
        jobId: existing.id,
      });
      return;
    }

    const job = await queue.add('product-refresh', {
      // connectionId is also required by the JobData type; carry it for tenant
      // filtering on the active-jobs endpoint.
      connectionId: Number(product.connection_id ?? 0),
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
      mode: 'refresh' as const,
      productId,
      syncSource,
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix', mode: 'refresh', syncSource } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to start refresh' });
  }
});

router.post('/bus-matrix/start', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({
        ok: false,
        error: 'Job queue not available — Redis is not configured. Bus matrix builds require Redis to survive browser close.',
      });
      return;
    }

    // Refuse to enqueue a second active job for the same connection.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find((j) => j.data.connectionId === connectionId && j.data.tenantId === tenantId);
    if (existing) {
      res.status(409).json({
        ok: false,
        error: 'A bus matrix build is already running for this connection.',
        jobId: existing.id,
      });
      return;
    }

    const job = await queue.add('bus-matrix', {
      connectionId,
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to start bus matrix job' });
  }
});

router.get('/bus-matrix/active', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.json({ ok: true, data: null });
      return;
    }

    const jobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const match = jobs.find((j) =>
      j.data.tenantId === tenantId &&
      (connectionId === undefined || j.data.connectionId === connectionId),
    );

    if (!match) { res.json({ ok: true, data: null }); return; }

    const state = await match.getState();
    res.json({
      ok: true,
      data: {
        jobId: match.id,
        state,
        connectionId: match.data.connectionId,
        progress: match.progress,
        createdAt: match.timestamp,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to query active jobs' });
  }
});

router.post('/bus-matrix/:jobId/cancel', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const { jobId } = req.params;

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({ ok: false, error: 'Job queue not available' });
      return;
    }

    const job = await queue.getJob(jobId);
    if (!job) { res.status(404).json({ ok: false, error: 'Job not found' }); return; }
    if (job.data.tenantId !== tenantId) { res.status(403).json({ ok: false, error: 'Forbidden' }); return; }

    const state = await job.getState();
    const { cancelJob } = await import('../jobs/cancellation');
    const aborted = cancelJob(jobId);

    // If still waiting in the queue, remove it directly.
    if (state === 'waiting' || state === 'delayed') {
      try { await job.remove(); } catch { /* ignore */ }
    }

    res.json({
      ok: true,
      data: {
        jobId,
        priorState: state,
        aborted,
        message: aborted
          ? 'Cancellation signal sent — the worker will stop at the next safe checkpoint.'
          : (state === 'waiting' || state === 'delayed')
            ? 'Job removed from the queue before it started.'
            : 'Cancellation flag set; worker is not currently active in this process.',
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Failed to cancel job' });
  }
});

router.get('/bus-matrix/:jobId/stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const tenantId = req.user?.tenantId;
  const { jobId } = req.params;

  const emit = (data: Record<string, unknown>) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
  };

  const { getBusMatrixQueue } = await import('../jobs/queues');
  const queue = getBusMatrixQueue();
  if (!queue) {
    emit({ type: 'error', message: 'Job queue not available' });
    res.end();
    return;
  }

  const job = await queue.getJob(jobId);
  if (!job) { emit({ type: 'error', message: 'Job not found' }); res.end(); return; }
  if (job.data.tenantId !== tenantId) { emit({ type: 'error', message: 'Forbidden' }); res.end(); return; }

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  // Track which logs we've already sent so polling can resume on reconnect.
  let logCursor = 0;

  const pollLogs = async () => {
    try {
      const { logs } = await queue.getJobLogs(jobId, logCursor, logCursor + 500);
      if (logs.length > 0) {
        for (const line of logs) {
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { /* ignore */ }
          if (parsed) emit(parsed);
          else emit({ type: 'log', text: line });
        }
        logCursor += logs.length;
      }
    } catch { /* job may have been removed */ }
  };

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
  }, 20_000);

  // Poll loop — every 500ms, drain new logs + check state.
  const POLL_MS = 500;
  while (!clientClosed) {
    await pollLogs();

    let state: string;
    try { state = await job.getState(); } catch { state = 'unknown'; }

    if (state === 'completed') {
      await pollLogs();
      const updated = await queue.getJob(jobId);
      emit({ type: 'completed', result: updated?.returnvalue ?? null });
      break;
    }
    if (state === 'failed') {
      await pollLogs();
      const updated = await queue.getJob(jobId);
      emit({ type: 'failed', error: updated?.failedReason ?? 'Job failed' });
      break;
    }
    if (state === 'unknown') {
      emit({ type: 'failed', error: 'Job vanished from queue' });
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  clearInterval(keepalive);
  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/products/bus-matrix-stream — SSE streaming enterprise bus matrix
// One AI call designs ALL dims + ALL facts + groupings. Replaces propose + design.
// (LEGACY — kept for backward compat. New flow uses /bus-matrix/start.)
// ---------------------------------------------------------------------------

router.post('/bus-matrix-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const reqId = `bms-${Date.now().toString(36)}`;
  const startTs = Date.now();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable any proxy buffering
  res.flushHeaders();

  log.info(`[${reqId}] bus-matrix-stream START (connectionId=${(req.body as { connectionId?: number })?.connectionId})`);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    log.warn(`[${reqId}] CLIENT DISCONNECTED after ${Date.now() - startTs}ms`);
  });

  const emit = (data: Record<string, unknown>) => {
    try {
      const written = res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (!written) {
        log.warn(`[${reqId}] res.write returned false (backpressure) type=${data.type as string}`);
      }
    } catch (err) {
      log.error({ err }, `[${reqId}] res.write failed type=${data.type as string}`);
    }
  };

  let keepaliveInterval: NodeJS.Timeout | null = null;

  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { emit({ type: 'error', message: 'connectionId required' }); res.end(); return; }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) { emit({ type: 'error', message: 'Connection not found' }); res.end(); return; }

    emit({ type: 'phase', text: `Reading schema for ${connection.name}…` });

    // Build source context WITHOUT example values to keep the prompt compact
    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await db('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    const tablesText = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) => {
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`;
        }).join('\n');
      return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // Pull confirmed FK relationships from Neo4j so the AI knows the actual joins
    // instead of inferring them from column names (root cause of phantom join cols
    // like dc.source_system that crash the build).
    let relationshipsText = '';
    try {
      const { getRelationshipsForContext } = await import('../db/semanticGraph');
      const rels = await getRelationshipsForContext(connectionId);
      if (rels.length > 0) {
        const lines = rels.map((r) => {
          const from = `${r.from_table as string}.${r.from_column as string}`;
          const to = `${r.to_table as string}.${r.to_column as string}`;
          const type = (r.relationship_type as string) || 'RELATES_TO';
          const desc = (r.description as string) ? ` — ${r.description as string}` : '';
          return `  ${from} → ${to} (${type})${desc}`;
        }).join('\n');
        relationshipsText = `\n\nCONFIRMED FOREIGN KEY RELATIONSHIPS (use these for fact↔dim joins — do NOT invent join columns):\n${lines}`;
      }
    } catch (err) {
      log.warn({ err }, `[${reqId}] Failed to load Neo4j relationships`);
    }

    const sourceContext = tablesText + relationshipsText;

    emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables, ${relationshipsText ? relationshipsText.split('\n').length - 2 : 0} relationships — designing bus matrix…` });

    // Send SSE keepalive comments every 20 seconds to prevent Azure / proxy timeout
    // during the (potentially long) AI generation phase.
    keepaliveInterval = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* connection already closed */ }
    }, 20_000);

    const { generateBusMatrixStreaming } = await import('../ai/AIService');

    let busMatrix: Awaited<ReturnType<typeof generateBusMatrixStreaming>>;
    const aiStart = Date.now();
    try {
      busMatrix = await generateBusMatrixStreaming(
        connection.name as string,
        sourceContext,
        (type, delta) => {
          if (clientDisconnected) return; // don't fight with a dead socket
          if (type === 'thinking') emit({ type: 'thinking', text: delta });
          else if (type === 'diag') emit({ type: 'diag', text: delta });
        },
      );
      log.info(`[${reqId}] AI call completed in ${Date.now() - aiStart}ms`);
    } catch (aiErr) {
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      const msg = aiErr instanceof Error ? aiErr.message : 'AI call failed';
      log.error({ err: aiErr }, `[${reqId}] AI call FAILED after ${Date.now() - aiStart}ms: ${msg}`);
      emit({ type: 'error', message: `AI design failed: ${msg}` });
      res.end();
      return;
    }

    if (keepaliveInterval) clearInterval(keepaliveInterval);
    log.info(`[${reqId}] Emitting 'done' (total ${Date.now() - startTs}ms, dims=${busMatrix.conformed_dimensions?.length ?? 0}, facts=${busMatrix.fact_tables?.length ?? 0})`);
    emit({ type: 'done', busMatrix });
  } catch (err) {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    log.error({ err }, `[${reqId}] Outer error after ${Date.now() - startTs}ms`);
    try {
      emit({ type: 'error', message: err instanceof Error ? err.message : 'Bus matrix design failed' });
    } catch { /* response already closed */ }
  }
  log.info(`[${reqId}] res.end() (total ${Date.now() - startTs}ms, clientDisconnected=${clientDisconnected})`);
  res.end();
});

// ---------------------------------------------------------------------------
// POST /api/products/build-bus-matrix — Persist a bus matrix design to DB
// Creates data products, star schemas, tables (with SQL), columns, relationships.
// ---------------------------------------------------------------------------

router.post('/build-bus-matrix', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const reqId = `bm-save-${Date.now().toString(36)}`;
  try {
    const db = reqDb(req);
    const { connectionId, busMatrix } = req.body as {
      connectionId: number;
      busMatrix: import('../ai/prompts/busMatrixPrompt').BusMatrixOutput;
    };
    if (!connectionId || !busMatrix) {
      res.status(400).json({ ok: false, error: 'connectionId and busMatrix required' });
      return;
    }

    // Pre-flight: recover from AI truncation (synthesize missing data_products
    // / relationships when the JSON-repair pass landed valid JSON but stripped
    // the trailing fields), THEN validate shape. Without recovery the user
    // loses 5-10 min of dim/fact design work on a truncation.
    const { recoverIncompleteBusMatrix } = await import('../services/busMatrixBuilder');
    const recovery = recoverIncompleteBusMatrix(busMatrix);
    if (recovery.recovered) {
      log.info(`[${reqId}] bus matrix truncation recovered: ${recovery.notes.join('; ')}`);
    }
    const validationErrors: string[] = [];
    if (!Array.isArray(busMatrix.conformed_dimensions)) validationErrors.push('conformed_dimensions missing or not an array');
    if (!Array.isArray(busMatrix.fact_tables)) validationErrors.push('fact_tables missing or not an array');
    if (!Array.isArray(busMatrix.data_products)) validationErrors.push('data_products missing or not an array');
    (busMatrix.data_products ?? []).forEach((dp, i) => {
      if (!dp.name) validationErrors.push(`data_products[${i}].name missing`);
      if (!Array.isArray(dp.owned_dimensions)) validationErrors.push(`data_products[${i}] "${dp.name}": owned_dimensions missing`);
      if (!Array.isArray(dp.fact_tables)) validationErrors.push(`data_products[${i}] "${dp.name}": fact_tables missing`);
      if (typeof dp.build_order !== 'number') validationErrors.push(`data_products[${i}] "${dp.name}": build_order missing`);
    });
    (busMatrix.conformed_dimensions ?? []).forEach((d, i) => {
      if (!d.table_name) validationErrors.push(`conformed_dimensions[${i}].table_name missing`);
      if (!Array.isArray(d.columns)) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": columns missing`);
      if (!Array.isArray(d.source_tables)) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": source_tables missing`);
      if (!d.transformation_sql) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql missing`);
    });
    (busMatrix.fact_tables ?? []).forEach((f, i) => {
      if (!f.table_name) validationErrors.push(`fact_tables[${i}].table_name missing`);
      if (!Array.isArray(f.columns)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": columns missing`);
      if (!Array.isArray(f.source_tables)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": source_tables missing`);
      if (!Array.isArray(f.dimensions_used)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": dimensions_used missing`);
      if (!f.transformation_sql) validationErrors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql missing`);
    });

    log.info(`[${reqId}] build-bus-matrix START: ${busMatrix.conformed_dimensions?.length ?? 0} dims, ${busMatrix.fact_tables?.length ?? 0} facts, ${busMatrix.data_products?.length ?? 0} products, ${validationErrors.length} validation errors`);

    if (validationErrors.length > 0) {
      log.error({ validationErrors: validationErrors.slice(0, 20) }, `[${reqId}] bus matrix failed validation`);
      res.status(400).json({
        ok: false,
        error: 'Bus matrix is incomplete — the AI output was likely truncated. Retry the design.',
        details: validationErrors.slice(0, 10),
      });
      return;
    }

    const tenantId = req.user?.tenantId;
    const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');

    // Wrap in a transaction — all-or-nothing to avoid partial state on failure
    const results = await db.transaction(async (trx) => {

    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);

    // Build lookup maps for dims and facts
    const dimByName = new Map(busMatrix.conformed_dimensions.map((d) => [d.table_name, d]));
    const factByName = new Map(busMatrix.fact_tables.map((f) => [f.table_name, f]));

    // Sort products by build_order
    const sortedProducts = [...busMatrix.data_products].sort((a, b) => a.build_order - b.build_order);

    const productIdByName = new Map<string, number>();
    const _results: Array<{ name: string; id: number; status: string }> = [];

    // Collect all source table names used across dims + facts for data_product_sources
    const allSourceTablesByProduct = new Map<string, Set<string>>();
    for (const dp of sortedProducts) {
      const srcSet = new Set<string>();
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (dim) dim.source_tables.forEach((s) => srcSet.add(s));
      }
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (fact) fact.source_tables.forEach((s) => srcSet.add(s));
      }
      allSourceTablesByProduct.set(dp.name, srcSet);
    }

    // Track which product owns which dim (for dependency resolution)
    const dimOwnerProduct = new Map<string, string>();
    for (const dp of sortedProducts) {
      for (const dimName of dp.owned_dimensions) {
        dimOwnerProduct.set(dimName, dp.name);
      }
    }

    for (const dp of sortedProducts) {
      // Create data_product row
      const [productRow] = await trx('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        created_by: req.user?.email || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productRow === 'object' ? (productRow as { id: number }).id : (productRow as number);
      productIdByName.set(dp.name, pid);

      // Record dependencies: for each fact's dimensions_used, if the dim is owned by another product, add dependency
      const depProductNames = new Set<string>();
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue; // dim_date is auto-injected, no dependency needed
          const owner = dimOwnerProduct.get(dimName);
          if (owner && owner !== dp.name) depProductNames.add(owner);
        }
      }
      for (const depName of depProductNames) {
        const sourceId = productIdByName.get(depName);
        if (sourceId) {
          await trx('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      // Create star schema for this product
      const allTablesInProduct = [...dp.owned_dimensions, ...dp.fact_tables];
      const primaryFact = dp.fact_tables[0] ? factByName.get(dp.fact_tables[0]) : null;

      const [schemaRow] = await trx('star_schemas').insert({
        data_product_id: pid,
        name: dp.name,
        description: dp.description,
        grain: primaryFact?.grain ?? 'Conformed dimensions',
        fact_table_type: primaryFact?.fact_table_type ?? 'transaction',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const schemaId = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      // Insert owned dimensions
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (!dim) {
          log.warn(`[build-bus-matrix] Product "${dp.name}": owned dimension "${dimName}" not found in conformed_dimensions — skipping`);
          continue;
        }

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: dim.table_name,
          display_name: dim.display_name,
          description: dim.description,
          table_role: 'dimension',
          // OWNER row — this product materialises the dim. Stubs in
          // downstream products are inserted with is_shared_dimension=true
          // in the fact-tables loop below.
          is_shared_dimension: false,
          dag_order: 0,
          transformation_sql: dim.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(dim.table_name, tableId);

        // Insert columns
        for (const col of dim.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }
      }

      // Insert fact tables
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) {
          log.warn(`[build-bus-matrix] Product "${dp.name}": fact table "${factName}" not found in fact_tables — skipping`);
          continue;
        }

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: fact.table_name,
          display_name: fact.display_name,
          description: fact.description,
          table_role: 'fact',
          is_shared_dimension: false,
          dag_order: 1,
          transformation_sql: fact.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(fact.table_name, tableId);

        for (const col of fact.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }

        // Also add referenced shared dims (from other products) as stub entries
        // so the star schema has complete info for querying
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          if (dp.owned_dimensions.includes(dimName)) continue; // Already added above
          const dim = dimByName.get(dimName);
          if (!dim || tableNameToId.has(dimName)) continue;

          const [stubRow] = await trx('product_tables').insert({
            star_schema_id: schemaId,
            table_name: dim.table_name,
            display_name: dim.display_name,
            description: dim.description,
            table_role: 'dimension',
            is_shared_dimension: true,
            dag_order: 0,
            transformation_sql: null, // Not built here — owned by another product
            transformation_status: 'draft',
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).returning('id');
          const stubId = typeof stubRow === 'object' ? (stubRow as { id: number }).id : (stubRow as number);
          tableNameToId.set(dim.table_name, stubId);

          // Insert dim columns as metadata (for query context)
          for (const col of dim.columns) {
            await trx('product_columns').insert({
              product_table_id: stubId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            });
          }
        }
      }

      // Auto-inject dim_date
      const dateRange = busMatrix.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };
      const isFirstBuilder = dp.build_order === 1;
      const [dimDateRow] = await trx('product_tables').insert({
        star_schema_id: schemaId,
        table_name: 'dim_date',
        display_name: 'Date',
        description: 'Auto-generated calendar dimension',
        table_role: 'dimension',
        // Only the first product in build order materializes dim_date.
        // All later products treat it as a conformed (shared) dimension and
        // load it from the owning product's parquet at run time.
        is_shared_dimension: !isFirstBuilder,
        dag_order: 0,
        transformation_sql: isFirstBuilder ? DIM_DATE_SQL(dateRange.start, dateRange.end) : null,
        transformation_status: 'draft',
        ai_draft: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const dimDateId = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await trx('product_columns').insert({
          product_table_id: dimDateId,
          column_name: col.column_name,
          data_type: col.data_type,
          display_name: col.display_name,
          description: col.description,
          column_role: col.column_role,
          transformation_expression: col.transformation_expression,
          scd_type: col.scd_type,
          sort_order: col.sort_order,
          ai_draft: false,
        });
      }

      // Save relationships for tables in this product
      for (const rel of busMatrix.relationships) {
        const fromId = tableNameToId.get(rel.from_table_name);
        const toId = tableNameToId.get(rel.to_table_name);
        if (fromId && toId) {
          await trx('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromId,
            from_column_name: rel.from_column_name,
            to_table_id: toId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // Populate data_product_sources
      const srcSet = allSourceTablesByProduct.get(dp.name);
      if (srcSet && srcSet.size > 0) {
        const sourceTblRows = await trx('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...srcSet])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await trx('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            })),
          );
        }
      }

      // Save KPIs for this product
      const productKpis = (busMatrix.proposed_kpis ?? []).filter((k) => k.product_name === dp.name);
      if (productKpis.length > 0) {
        await trx('product_kpis').insert(
          productKpis.map((k) => ({
            data_product_id: pid,
            name: k.name,
            description: k.description,
            formula_plain_text: k.formula_plain_text,
            formula_sql: k.formula_sql,
            ai_draft: true,
          })),
        );
      }

      // Mark as approved (ready to run)
      await trx('data_products').where({ id: pid }).update({
        status: 'approved',
        updated_at: new Date().toISOString(),
      });

      // Count tables actually inserted for this product
      const tableCount = await trx('product_tables').where({ star_schema_id: schemaId }).count('id as count').first();
      const count = Number(tableCount?.count ?? 0);
      log.info(`[build-bus-matrix] Product "${dp.name}" (id=${pid}): ${count} tables created (owned_dims: ${dp.owned_dimensions.length}, facts: ${dp.fact_tables.length})`);

      _results.push({ name: dp.name, id: pid, status: 'created' });
    }

    // Summary
    log.info(`[build-bus-matrix] Summary: AI designed ${busMatrix.conformed_dimensions?.length ?? 0} dims + ${busMatrix.fact_tables?.length ?? 0} facts → ${_results.length} products`);

    return _results;

    }); // end transaction

    log.info(`[${reqId}] build-bus-matrix SUCCESS: ${results.length} products created`);
    res.json({ ok: true, data: { products: results } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.code ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (err as any)?.detail ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const constraint = (err as any)?.constraint ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = (err as any)?.table ?? null;
    log.error({ code, detail, constraint, table, stack }, `[${reqId}] build-bus-matrix FAILED: ${msg}`);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: `Failed to save bus matrix: ${msg}`,
        details: { code, constraint, table, detail },
      });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-stream — SSE streaming version of /propose
// Streams Claude's thinking tokens live so the browser shows progress immediately.
// (LEGACY — kept for backward compat; new flow uses bus-matrix-stream)
// ---------------------------------------------------------------------------

router.post('/propose-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { emit({ type: 'error', message: 'connectionId required' }); res.end(); return; }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) { emit({ type: 'error', message: 'Connection not found' }); res.end(); return; }

    emit({ type: 'phase', text: `Reading schema for ${connection.name}…` });

    // Same data-gathering as /propose
    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables — asking Claude to plan the warehouse…` });

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await db('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure', 'example_values');
      const fkRels = await db('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');
      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));
      const bkCol = t.business_key_column as string | null;
      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: c.column_name === 'id' || c.column_name === bkCol,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    const existingProducts = await db('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateBusMatrixStreaming } = await import('../ai/AIService');

    const sourceTablesContextStream = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const proposal = await generateBusMatrixStreaming(
      connection.name as string,
      sourceTablesContextStream,
      (type, delta) => {
        if (type === 'thinking') emit({ type: 'thinking', text: delta });
      },
    );

    emit({ type: 'done', proposal });
  } catch (err) {
    log.error({ err }, '[products/propose-stream] Error');
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
  }
  res.end();
});

// POST /api/products/propose — AI auto-proposes all data products for a connection
// ---------------------------------------------------------------------------

router.post('/propose', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { res.status(400).json({ ok: false, error: 'connectionId required' }); return; }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }

    // Gather semantic context from Postgres + Neo4j
    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await db('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure', 'example_values');

      // Derive FK info from table_relationships (from_column_id → to source_tables)
      const fkRels = await db('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');

      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));

      // Heuristic: column named 'id' or matching business_key_column is PK
      const bkCol = t.business_key_column as string | null;

      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          const isPk = c.column_name === 'id' || c.column_name === bkCol;
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: isPk,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    // Existing products (so Claude doesn't recreate them)
    const existingProducts = await db('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateBusMatrixStreaming: generateBusMatrix } = await import('../ai/AIService');
    const sourceTablesContextProp = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const proposal = await generateBusMatrix(connection.name as string, sourceTablesContextProp, () => {});

    res.json({ ok: true, data: proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/build-proposed — persist + queue a full proposal
// ---------------------------------------------------------------------------

router.post('/build-proposed', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, proposal } = req.body as {
      connectionId: number;
      proposal: import('../ai/prompts/dataProductProposalPrompt').DataProductProposal;
    };
    if (!connectionId || !proposal) { res.status(400).json({ ok: false, error: 'connectionId and proposal required' }); return; }

    const tenantId = req.user?.tenantId;

    // Sort products by build_order so owners are created before dependents
    const sorted = [...proposal.data_products].sort((a, b) => a.build_order - b.build_order);

    // Map product name → DB id (populated as we insert)
    const productIdByName = new Map<string, number>();

    const results: Array<{ name: string; id: number; status: string }> = [];

    for (const dp of sorted) {
      // Create data_product row
      const [productId] = await db('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        created_by: req.user?.email || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productId === 'object' ? (productId as { id: number }).id : productId;
      productIdByName.set(dp.name, pid);

      // Record dependencies
      for (const dep of dp.depends_on) {
        const sourceId = productIdByName.get(dep.source_product_name);
        if (sourceId) {
          await db('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      // Create star schemas + tables
      for (const ss of dp.star_schemas) {
        const [schemaId] = await db('star_schemas').insert({
          data_product_id: pid,
          name: ss.name,
          description: ss.description,
          grain: ss.grain,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const ssid = typeof schemaId === 'object' ? (schemaId as { id: number }).id : schemaId;

        for (const tbl of ss.tables) {
          await db('product_tables').insert({
            star_schema_id: ssid,
            table_name: tbl.table_name,
            display_name: tbl.display_name,
            description: tbl.description,
            table_role: tbl.table_role,
            is_shared_dimension: tbl.is_shared_dimension,
            transformation_sql: null,          // generated later via AI Design
            transformation_status: 'draft',
            dag_order: tbl.dag_order,
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Populate data_product_sources so AI Design Star Schema can find source table context
      const allSourceTableNames = new Set<string>();
      for (const ss of dp.star_schemas) {
        for (const tbl of ss.tables) {
          for (const src of tbl.source_tables) {
            allSourceTableNames.add(src);
          }
        }
      }
      if (allSourceTableNames.size > 0) {
        const sourceTblRows = await db('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...allSourceTableNames])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await db('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            }))
          );
        }
      }

      results.push({ name: dp.name, id: pid, status: 'created' });
    }

    // Queue transformations in build_order (one job per product)
    try {
      const { getTransformationQueue } = await import('../jobs/queues');
      const tQueue = getTransformationQueue();
      if (tQueue) {
        for (const r of results) {
          await tQueue.add('transform', { productId: r.id, tenantId, triggeredBy: 'system' });
        }
      }
    } catch {
      // Redis not available — caller can trigger manually
    }

    res.json({ ok: true, data: { products: results } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Refine chat — per-product conversational editing.
//
// GET    /api/products/:id/refinements           — list (team-visible log)
// POST   /api/products/:id/refinements           — new chat message → AI proposal
// POST   /api/products/refinements/:id/approve   — apply the proposal
// POST   /api/products/refinements/:id/reject    — discard the proposal
// ---------------------------------------------------------------------------

router.get('/:id/refinements', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const { listRefinements } = await import('../services/refineService');
    const rows = await listRefinements(tenantId, Number(req.params.id));
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/:id/refinements', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const { message, focusedTableId } = req.body as { message: string; focusedTableId?: number | null };
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ ok: false, error: 'Message is required' });
      return;
    }

    const { createRefinement } = await import('../services/refineService');
    const row = await createRefinement(
      tenantId,
      Number(req.params.id),
      (req.user?.sub as number | undefined) ?? null,
      (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? null,
      message.trim(),
      focusedTableId ?? null,
    );
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

router.post('/refinements/:id/approve', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const userId = req.user?.sub as number | undefined;
    const userName = (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? '';
    if (!userId) { res.status(401).json({ ok: false, error: 'User id required' }); return; }

    const { approveRefinement } = await import('../services/refineService');
    const row = await approveRefinement(tenantId, Number(req.params.id), userId, userName);
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

router.post('/refinements/:id/reject', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const userId = req.user?.sub as number | undefined;
    const userName = (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? '';
    if (!userId) { res.status(401).json({ ok: false, error: 'User id required' }); return; }

    const { rejectRefinement } = await import('../services/refineService');
    const row = await rejectRefinement(tenantId, Number(req.params.id), userId, userName);
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// POST /api/products/refinements/:id/preview — run the proposed transformation
// against live data and return sample rows so the user can SEE the change
// before approving. A SQL error here is the point: it surfaces a bad AI
// proposal pre-commit instead of after a failed refresh.
router.post('/refinements/:id/preview', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response) => {
  let duckDb: Database | null = null;
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }

    const { getRefinementPreviewPlan } = await import('../services/refineService');
    const plan = await getRefinementPreviewPlan(tenantId, Number(req.params.id));
    if (!plan.previewable || !plan.sql || !plan.connectionId) {
      res.json({ ok: true, data: { previewable: false, reason: plan.reason ?? 'Not previewable' } });
      return;
    }

    duckDb = await buildConnectionWarehouseSession(reqDb(req), plan.connectionId);
    const inner = plan.sql.trim().replace(/;\s*$/, '');
    const rawRows = await duckDb.all(`SELECT * FROM (\n${inner}\n) AS _preview LIMIT 12`) as Record<string, unknown>[];
    const rows = rawRows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
      return out;
    });
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({
      ok: true,
      data: { previewable: true, rows, columns, targetColumn: plan.targetColumn ?? null, rowCount: rows.length },
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Preview failed' });
  } finally {
    if (duckDb) try { await duckDb.close(); } catch { /* ignore */ }
  }
});

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
          const { callClaude } = await import('../ai/AIService');
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

    const { callClaude } = await import('../ai/AIService');
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

    const { runProductTransformation } = await import('../services/transformationRunner');
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
    const { runProductTransformation } = await import('../services/transformationRunner');
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
