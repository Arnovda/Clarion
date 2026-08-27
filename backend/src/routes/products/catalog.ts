/**
 * Products router (1/9): product list + catalog-by-source view + dim
 * reverse-lineage (used-by). Split verbatim from routes/products.ts —
 * see ./index.ts for the order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth';
import { parsePagination, paginatedResponse } from '../../utils/paginate';
import { reqDb } from '../../db/reqDb';

const router = Router();

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
        // Same rule as build-overview's rowsTotal: NULL = nothing
        // materialised, 0 = built but every table empty ("waiting for
        // data") — the Subjects hub renders that state honestly instead
        // of "refreshed just now".
        db.raw(`(
          SELECT SUM(pt.row_count)
          FROM product_tables pt
          JOIN star_schemas ss ON pt.star_schema_id = ss.id
          WHERE ss.data_product_id = data_products.id
            AND pt.transformation_status = 'success'
        ) as rows_total`),
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
  tableName: string;       // technical name — /catalog?table= deep links match on it
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
            // Technical name too: /catalog?table=<name> deep links (dashboard
            // filter provenance) resolve against it — the display name alone
            // can't match a spec's `dim_item`.
            tableName: t.table_name,
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


export default router;
