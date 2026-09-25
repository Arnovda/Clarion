/**
 * /api/lineage — column-level lineage, ALWAYS anchored on one table.
 *
 * The owner's definition: "a graph to really showcase which source tables
 * and columns feed which data products and columns, and also
 * transformations if there are any." The data has existed since migration
 * 17 — `column_lineage(product_column_id, source_table_name,
 * source_column_name, transformation_description)`, written by every build
 * path (busMatrixBuilder, design, build-proposed) — this endpoint is the
 * first read of it as lineage rather than as prompt context.
 *
 * Anchored on purpose (§2.4 "never render everything"): a global lineage
 * graph over every table × column is the same hairball the relationship
 * canvas was rebuilt to avoid. One anchor, one hop, both directions:
 *
 *   layer=source  → who consumes this source table, column by column
 *   layer=product → which source columns feed this product table, and how
 *
 * Scope notes that make this correct rather than merely plausible:
 *  - `column_lineage.source_table_name` is a NAME, not an id, and table
 *    names repeat across connections — so downstream matches are limited
 *    to products that belong to the source's connection (connection_id or
 *    a data_product_sources row), never to a bare name match.
 *  - Keys ARE shown (2026-09-25, owner: a table's keys belong in its
 *    lineage). This is a curator surface; what stays hidden is storage
 *    machinery — underscore-prefixed columns (`_row_hash`, `_clarion_*`),
 *    never the `is_technical` join keys.
 *  - The lineage is READ OFF THE TABLE'S CURRENT SQL
 *    (services/sqlColumnLineage.ts), so it follows every save on the SQL
 *    tab, the key upgrade and repairs — including CTEs, subqueries,
 *    SELECT *, unions and several columns combined into one. The stored
 *    `column_lineage` rows (written once, at build time) are only the
 *    fallback for a table whose SQL cannot be read, or a column the SQL
 *    does not name.
 *  - Every query filters tenant_id explicitly (the reqDb pool-race rule).
 *
 * admin+analyst: transformation expressions are SQL-shaped, and the
 * lineage view lives on the catalog's curator tabs.
 */
import type { ProvenanceRung } from '../shared/provenance';
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { deriveSqlLineage, type SourceCatalog, type SqlLineageResult } from '../services/sqlColumnLineage';
import type { Knex } from 'knex';

const router = Router();

interface SourceNode {
  tableId: number | null;          // null = named in lineage but no longer in the catalog
  tableName: string;
  displayName: string | null;
  columns: Array<{ id: number | null; name: string; displayName: string | null }>;
}

interface ProductNode {
  productId: number;
  productName: string;
  productTableId: number;
  tableName: string;
  displayName: string | null;
  tableRole: string | null;
  columns: Array<{
    id: number;
    name: string;
    displayName: string | null;
    transformation: string | null; // human-readable when we have it, else the expression
    /** A join key (`is_technical`): shown, marked as such. */
    technical: boolean;
  }>;
}

interface LineageEdge {
  sourceTable: string;
  sourceColumn: string;
  productTableId: number;
  productColumnId: number;
  transformation: string | null;
  /** Who asserted this thread (shared/provenance.ts); 'unknown' on rows older than the column. */
  provenance: ProvenanceRung;
}

/** Storage machinery (`_row_hash`, `_clarion_*`): never lineage. Keys are. */
const NOT_MACHINERY = `pc.column_name NOT LIKE '\\_%'`;

/**
 * The source tables a product's SQL may read, with their columns: every
 * source table of the given connections, plus any a product records in
 * data_product_sources (a subject built across sources). Explicit tenant
 * filters throughout.
 */
async function loadSourceCatalog(
  db: Knex | Knex.Transaction,
  tenantId: number,
  connectionIds: number[],
  productIds: number[],
): Promise<SourceCatalog> {
  const conns = connectionIds.filter((c) => Number.isFinite(c));
  const prods = productIds.filter((p) => Number.isFinite(p));
  if (!conns.length && !prods.length) return new Map();
  const tables = (await db('source_tables')
    .where('tenant_id', tenantId)
    .where((qb) => {
      if (conns.length) qb.whereIn('connection_id', conns);
      if (prods.length) {
        qb.orWhereIn('id', db('data_product_sources')
          .where('tenant_id', tenantId)
          .whereIn('data_product_id', prods)
          .select('source_table_id'));
      }
    })
    .select('id', 'table_name')) as Array<{ id: number; table_name: string }>;
  const cols = tables.length
    ? ((await db('source_columns')
        .where('tenant_id', tenantId)
        .whereIn('table_id', tables.map((t) => t.id))
        .select('table_id', 'column_name')) as Array<{ table_id: number; column_name: string }>)
    : [];
  const byTable = new Map<number, Map<string, string>>();
  for (const c of cols) {
    let m = byTable.get(c.table_id);
    if (!m) { m = new Map(); byTable.set(c.table_id, m); }
    m.set(c.column_name.toLowerCase(), c.column_name);
  }
  const catalog: SourceCatalog = new Map();
  for (const t of tables) {
    // Same name on two connections: the first wins — the SQL names bare
    // tables, and within one product's session a name means one table.
    if (catalog.has(t.table_name.toLowerCase())) continue;
    catalog.set(t.table_name.toLowerCase(), { name: t.table_name, columns: byTable.get(t.id) });
  }
  return catalog;
}

/** How a derived column reads in the UI: the expression, or "Copied as-is". */
function derivedTransformation(d: { refs: unknown[]; transformation: string | null }): string | null {
  if (d.transformation) return d.transformation;
  return d.refs.length ? 'Copied as-is' : null;
}

router.get('/table', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }
    const layer = String(req.query.layer ?? '');
    const tableId = Number(req.query.tableId);
    if ((layer !== 'source' && layer !== 'product') || !Number.isFinite(tableId)) {
      res.status(400).json({ ok: false, error: 'layer (source|product) and tableId are required' });
      return;
    }

    if (layer === 'source') {
      const src = await db('source_tables')
        .where({ id: tableId, tenant_id: tenantId })
        .first('id', 'table_name', 'display_name', 'connection_id');
      if (!src) {
        res.status(404).json({ ok: false, error: 'Table not found' });
        return;
      }

      const srcCols = (await db('source_columns')
        .where({ table_id: src.id, tenant_id: tenantId })
        .select('id', 'column_name', 'display_name')
        .orderBy('id', 'asc')) as Array<{ id: number; column_name: string; display_name: string | null }>;

      // Downstream, read off the SQL of every product table that could read
      // this source (same scope as the stored rows: products of this
      // connection, or that record this table as a source). Copies of a
      // shared lookup are skipped — their original is the one definition.
      const productScope = (qb: Knex.QueryBuilder) => {
        qb.where('dp.connection_id', src.connection_id)
          .orWhereIn('dp.id', db('data_product_sources as dps')
            .join('source_tables as st', 'st.id', 'dps.source_table_id')
            .where('st.id', src.id)
            .select('dps.data_product_id'));
      };
      const candidates = (await db('product_tables as pt')
        .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .where('pt.tenant_id', tenantId)
        .whereNull('pt.source_product_table_id')
        .whereNotNull('pt.transformation_sql')
        .whereRaw('pt.transformation_sql ILIKE ?', [`%${src.table_name}%`])
        .where(productScope)
        .select(
          'pt.id as pt_id', 'pt.table_name as pt_name', 'pt.display_name as pt_display', 'pt.table_role',
          'pt.transformation_sql', 'dp.id as dp_id', 'dp.name as dp_name',
        )) as Array<{
          pt_id: number; pt_name: string; pt_display: string | null; table_role: string | null;
          transformation_sql: string; dp_id: number; dp_name: string;
        }>;
      const catalog = await loadSourceCatalog(db, tenantId, [src.connection_id], [...new Set(candidates.map((c) => c.dp_id))]);
      const derivedByTable = new Map<number, SqlLineageResult>();
      for (const c of candidates) derivedByTable.set(c.pt_id, deriveSqlLineage(c.transformation_sql, catalog));
      const candCols = candidates.length
        ? ((await db('product_columns as pc')
            .where('pc.tenant_id', tenantId)
            .whereIn('pc.product_table_id', candidates.map((c) => c.pt_id))
            .whereRaw(NOT_MACHINERY)
            .select('pc.id', 'pc.product_table_id', 'pc.column_name', 'pc.display_name', 'pc.is_technical')) as Array<{
              id: number; product_table_id: number; column_name: string; display_name: string | null; is_technical: boolean | null;
            }>)
        : [];

      const products = new Map<number, ProductNode>();
      const edges: LineageEdge[] = [];
      const srcLower = src.table_name.toLowerCase();
      /** product_column ids whose lineage the SQL answered — stored rows for them are stale. */
      const answered = new Set<number>();
      const candById = new Map(candidates.map((c) => [c.pt_id, c] as const));
      const nodeFor = (ptId: number, dpId: number, dpName: string, ptName: string, ptDisplay: string | null, role: string | null) => {
        let node = products.get(ptId);
        if (!node) {
          node = { productId: dpId, productName: dpName, productTableId: ptId, tableName: ptName, displayName: ptDisplay, tableRole: role, columns: [] };
          products.set(ptId, node);
        }
        return node;
      };
      for (const pc of candCols) {
        const derived = derivedByTable.get(pc.product_table_id);
        const d = derived?.parsed ? derived.columns.get(pc.column_name.toLowerCase()) : undefined;
        if (!d) continue;
        answered.add(pc.id);
        const fromHere = d.refs.filter((r) => r.table.toLowerCase() === srcLower);
        if (!fromHere.length) continue;
        const c = candById.get(pc.product_table_id)!;
        const node = nodeFor(c.pt_id, c.dp_id, c.dp_name, c.pt_name, c.pt_display, c.table_role);
        const transformation = derivedTransformation(d);
        if (!node.columns.some((x) => x.id === pc.id)) {
          node.columns.push({ id: pc.id, name: pc.column_name, displayName: pc.display_name, transformation, technical: !!pc.is_technical });
        }
        for (const r of fromHere) {
          edges.push({
            sourceTable: src.table_name, sourceColumn: r.column,
            productTableId: c.pt_id, productColumnId: pc.id,
            transformation, provenance: 'derived',
          });
        }
      }

      // Fallback: stored rows, for tables whose SQL could not be read and
      // columns the SQL did not name.
      const rows = (await db('column_lineage as cl')
        .join('product_columns as pc', 'pc.id', 'cl.product_column_id')
        .join('product_tables as pt', 'pt.id', 'pc.product_table_id')
        .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .where('cl.source_table_name', src.table_name)
        .where('cl.tenant_id', tenantId)
        .where('pt.tenant_id', tenantId)
        .whereNull('pt.source_product_table_id')
        .whereRaw(NOT_MACHINERY)
        .where(productScope)
        .select(
          'cl.source_column_name', 'cl.transformation_description', 'cl.provenance',
          'pc.id as pc_id', 'pc.column_name as pc_name', 'pc.display_name as pc_display',
          'pc.transformation_expression', 'pc.is_technical',
          'pt.id as pt_id', 'pt.table_name as pt_name', 'pt.display_name as pt_display', 'pt.table_role',
          'dp.id as dp_id', 'dp.name as dp_name',
        )) as Array<{
          source_column_name: string; transformation_description: string | null; provenance: string | null;
          pc_id: number; pc_name: string; pc_display: string | null;
          transformation_expression: string | null; is_technical: boolean | null;
          pt_id: number; pt_name: string; pt_display: string | null; table_role: string | null;
          dp_id: number; dp_name: string;
        }>;

      for (const r of rows) {
        if (answered.has(r.pc_id)) continue;
        const node = nodeFor(r.pt_id, r.dp_id, r.dp_name, r.pt_name, r.pt_display, r.table_role);
        const transformation = r.transformation_description ?? r.transformation_expression ?? null;
        if (!node.columns.some((c) => c.id === r.pc_id)) {
          node.columns.push({ id: r.pc_id, name: r.pc_name, displayName: r.pc_display, transformation, technical: !!r.is_technical });
        }
        edges.push({
          sourceTable: src.table_name,
          sourceColumn: r.source_column_name,
          productTableId: r.pt_id,
          productColumnId: r.pc_id,
          transformation,
          provenance: (r.provenance ?? 'unknown') as ProvenanceRung,
        });
      }

      // Only the source columns that actually feed something, plus a count of
      // the rest — forty untouched columns bury the answer (same reasoning as
      // the canvas's join-surface rendering).
      const fedNames = new Set(edges.map((e) => e.sourceColumn));
      const fedCols = srcCols.filter((c) => fedNames.has(c.column_name));
      // Lineage can name a column the catalog no longer has — keep the edge
      // honest by emitting the named column anyway.
      for (const name of fedNames) {
        if (!fedCols.some((c) => c.column_name === name)) {
          fedCols.push({ id: null as unknown as number, column_name: name, display_name: null });
        }
      }

      const sourceNode: SourceNode = {
        tableId: src.id,
        tableName: src.table_name,
        displayName: src.display_name,
        columns: fedCols.map((c) => ({ id: c.id ?? null, name: c.column_name, displayName: c.display_name })),
      };

      res.json({
        ok: true,
        data: {
          anchor: { layer: 'source', tableId: src.id, tableName: src.table_name, displayName: src.display_name },
          sources: [sourceNode],
          products: [...products.values()],
          edges,
          totalSourceColumns: srcCols.length,
        },
      });
      return;
    }

    // layer === 'product'
    const pt = await db('product_tables as pt')
      .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
      .join('data_products as dp', 'dp.id', 'ss.data_product_id')
      .where('pt.id', tableId)
      .where('pt.tenant_id', tenantId)
      .first(
        'pt.id', 'pt.table_name', 'pt.display_name', 'pt.table_role',
        'pt.transformation_sql', 'pt.source_product_table_id',
        'dp.id as dp_id', 'dp.name as dp_name', 'dp.connection_id as dp_connection_id',
      );
    if (!pt) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    // A copy of a shared lookup has no SQL of its own: its original's SQL is
    // the one that built the data it shows.
    let sql: string | null = pt.transformation_sql ?? null;
    const productIds = [pt.dp_id as number];
    const connectionIds = pt.dp_connection_id ? [pt.dp_connection_id as number] : [];
    if (pt.source_product_table_id) {
      const orig = await db('product_tables as pt')
        .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .where('pt.id', pt.source_product_table_id)
        .where('pt.tenant_id', tenantId)
        .first('pt.transformation_sql', 'dp.id as dp_id', 'dp.connection_id as dp_connection_id');
      if (orig) {
        sql = orig.transformation_sql ?? sql;
        productIds.push(orig.dp_id);
        if (orig.dp_connection_id) connectionIds.push(orig.dp_connection_id);
      }
    }

    const cols = (await db('product_columns as pc')
      .where('pc.product_table_id', pt.id)
      .where('pc.tenant_id', tenantId)
      .whereRaw(NOT_MACHINERY)
      .select('pc.id', 'pc.column_name', 'pc.display_name', 'pc.transformation_expression', 'pc.sort_order', 'pc.is_technical')
      .orderBy('pc.sort_order', 'asc')) as Array<{
        id: number; column_name: string; display_name: string | null;
        transformation_expression: string | null; sort_order: number; is_technical: boolean | null;
      }>;

    const catalog = await loadSourceCatalog(db, tenantId, connectionIds, productIds);
    const derived = deriveSqlLineage(sql, catalog);
    const derivedFor = (name: string) => (derived.parsed ? derived.columns.get(name.toLowerCase()) : undefined);

    // Stored rows only for the columns the SQL did not answer.
    const fallbackIds = cols.filter((c) => !derivedFor(c.column_name)).map((c) => c.id);
    const stored = fallbackIds.length
      ? ((await db('column_lineage')
          .where('tenant_id', tenantId)
          .whereIn('product_column_id', fallbackIds)
          .select('product_column_id', 'source_table_name', 'source_column_name', 'transformation_description', 'provenance')) as Array<{
            product_column_id: number; source_table_name: string;
            source_column_name: string; transformation_description: string | null; provenance: string | null;
          }>)
      : [];
    const lineage: Array<{
      product_column_id: number; source_table_name: string; source_column_name: string;
      transformation: string | null; provenance: ProvenanceRung;
    }> = [];
    const colById = new Map(cols.map((c) => [c.id, c] as const));
    for (const c of cols) {
      const d = derivedFor(c.column_name);
      if (!d) continue;
      const transformation = derivedTransformation(d);
      for (const r of d.refs) {
        lineage.push({
          product_column_id: c.id, source_table_name: r.table, source_column_name: r.column,
          transformation, provenance: 'derived',
        });
      }
    }
    for (const l of stored) {
      lineage.push({
        product_column_id: l.product_column_id,
        source_table_name: l.source_table_name,
        source_column_name: l.source_column_name,
        transformation: l.transformation_description ?? colById.get(l.product_column_id)?.transformation_expression ?? null,
        provenance: (l.provenance ?? 'unknown') as ProvenanceRung,
      });
    }

    // Resolve the named upstream tables/columns back to catalog rows where
    // they still exist (names can outlive a re-profile); an unresolved name
    // still renders — the lineage is the fact, the catalog link is a bonus.
    const upstreamNames = [...new Set(lineage.map((l) => l.source_table_name))];
    const srcTables = upstreamNames.length
      ? ((await db('source_tables')
          .where('tenant_id', tenantId)
          .whereIn('table_name', upstreamNames)
          .where((qb) => {
            if (connectionIds.length) qb.whereIn('connection_id', connectionIds);
            qb.orWhereIn('id', db('data_product_sources')
              .where('tenant_id', tenantId)
              .whereIn('data_product_id', productIds)
              .select('source_table_id'));
          })
          .select('id', 'table_name', 'display_name')) as Array<{ id: number; table_name: string; display_name: string | null }>)
      : [];
    const srcByName = new Map(srcTables.map((t) => [t.table_name, t] as const));
    const srcColRows = srcTables.length
      ? ((await db('source_columns')
          .where('tenant_id', tenantId)
          .whereIn('table_id', srcTables.map((t) => t.id))
          .select('id', 'table_id', 'column_name', 'display_name')) as Array<{
            id: number; table_id: number; column_name: string; display_name: string | null;
          }>)
      : [];
    const srcColByKey = new Map(srcColRows.map((c) => {
      const tbl = srcTables.find((t) => t.id === c.table_id);
      return [`${tbl?.table_name ?? ''}.${c.column_name}`, c] as const;
    }));

    const sources = new Map<string, SourceNode>();
    const edges: LineageEdge[] = [];
    for (const l of lineage) {
      const resolved = srcByName.get(l.source_table_name) ?? null;
      let node = sources.get(l.source_table_name);
      if (!node) {
        node = {
          tableId: resolved?.id ?? null,
          tableName: l.source_table_name,
          displayName: resolved?.display_name ?? null,
          columns: [],
        };
        sources.set(l.source_table_name, node);
      }
      if (!node.columns.some((c) => c.name === l.source_column_name)) {
        const sc = srcColByKey.get(`${l.source_table_name}.${l.source_column_name}`);
        node.columns.push({ id: sc?.id ?? null, name: l.source_column_name, displayName: sc?.display_name ?? null });
      }
      edges.push({
        sourceTable: l.source_table_name,
        sourceColumn: l.source_column_name,
        productTableId: pt.id,
        productColumnId: l.product_column_id,
        transformation: l.transformation,
        provenance: l.provenance,
      });
    }

    const productNode: ProductNode = {
      productId: pt.dp_id,
      productName: pt.dp_name,
      productTableId: pt.id,
      tableName: pt.table_name,
      displayName: pt.display_name,
      tableRole: pt.table_role,
      columns: cols.map((c) => {
        const d = derivedFor(c.column_name);
        const viaLineage = lineage.find((l) => l.product_column_id === c.id)?.transformation;
        return {
          id: c.id,
          name: c.column_name,
          displayName: c.display_name,
          transformation: d ? derivedTransformation(d) ?? d.transformation : (viaLineage ?? c.transformation_expression ?? null),
          technical: !!c.is_technical,
        };
      }),
    };

    res.json({
      ok: true,
      data: {
        anchor: { layer: 'product', tableId: pt.id, tableName: pt.table_name, displayName: pt.display_name },
        sources: [...sources.values()],
        products: [productNode],
        edges,
      },
    });
  } catch (err) { next(err); }
});

export default router;
