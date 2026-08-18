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
 *  - `product_columns.is_technical` is the firewall that keeps `_row_hash`
 *    and friends out of every user/AI surface — this is one more such
 *    surface, so the filter applies here too.
 *  - Every query filters tenant_id explicitly (the reqDb pool-race rule).
 *
 * admin+analyst: transformation expressions are SQL-shaped, and the
 * lineage view lives on the catalog's curator tabs.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';

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
  }>;
}

interface LineageEdge {
  sourceTable: string;
  sourceColumn: string;
  productTableId: number;
  productColumnId: number;
  transformation: string | null;
}

const NOT_TECHNICAL = `(pc.is_technical = false OR pc.is_technical IS NULL)`;

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

      // Downstream: lineage rows naming this table, limited to products that
      // actually belong to this connection — a bare name match would pull in
      // another connection's identically-named table.
      const rows = (await db('column_lineage as cl')
        .join('product_columns as pc', 'pc.id', 'cl.product_column_id')
        .join('product_tables as pt', 'pt.id', 'pc.product_table_id')
        .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
        .join('data_products as dp', 'dp.id', 'ss.data_product_id')
        .where('cl.source_table_name', src.table_name)
        .where('cl.tenant_id', tenantId)
        .where('pt.tenant_id', tenantId)
        .whereRaw(NOT_TECHNICAL)
        .where((qb) => {
          qb.where('dp.connection_id', src.connection_id)
            .orWhereIn('dp.id', db('data_product_sources as dps')
              .join('source_tables as st', 'st.id', 'dps.source_table_id')
              .where('st.id', src.id)
              .select('dps.data_product_id'));
        })
        .select(
          'cl.source_column_name', 'cl.transformation_description',
          'pc.id as pc_id', 'pc.column_name as pc_name', 'pc.display_name as pc_display',
          'pc.transformation_expression',
          'pt.id as pt_id', 'pt.table_name as pt_name', 'pt.display_name as pt_display', 'pt.table_role',
          'dp.id as dp_id', 'dp.name as dp_name',
        )) as Array<{
          source_column_name: string; transformation_description: string | null;
          pc_id: number; pc_name: string; pc_display: string | null;
          transformation_expression: string | null;
          pt_id: number; pt_name: string; pt_display: string | null; table_role: string | null;
          dp_id: number; dp_name: string;
        }>;

      const products = new Map<number, ProductNode>();
      const edges: LineageEdge[] = [];
      for (const r of rows) {
        let node = products.get(r.pt_id);
        if (!node) {
          node = {
            productId: r.dp_id, productName: r.dp_name,
            productTableId: r.pt_id, tableName: r.pt_name,
            displayName: r.pt_display, tableRole: r.table_role, columns: [],
          };
          products.set(r.pt_id, node);
        }
        const transformation = r.transformation_description ?? r.transformation_expression ?? null;
        if (!node.columns.some((c) => c.id === r.pc_id)) {
          node.columns.push({ id: r.pc_id, name: r.pc_name, displayName: r.pc_display, transformation });
        }
        edges.push({
          sourceTable: src.table_name,
          sourceColumn: r.source_column_name,
          productTableId: r.pt_id,
          productColumnId: r.pc_id,
          transformation,
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
        'dp.id as dp_id', 'dp.name as dp_name', 'dp.connection_id as dp_connection_id',
      );
    if (!pt) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    const cols = (await db('product_columns as pc')
      .where('pc.product_table_id', pt.id)
      .where('pc.tenant_id', tenantId)
      .whereRaw(NOT_TECHNICAL)
      .select('pc.id', 'pc.column_name', 'pc.display_name', 'pc.transformation_expression', 'pc.sort_order')
      .orderBy('pc.sort_order', 'asc')) as Array<{
        id: number; column_name: string; display_name: string | null;
        transformation_expression: string | null; sort_order: number;
      }>;

    const lineage = cols.length
      ? ((await db('column_lineage')
          .where('tenant_id', tenantId)
          .whereIn('product_column_id', cols.map((c) => c.id))
          .select('product_column_id', 'source_table_name', 'source_column_name', 'transformation_description')) as Array<{
            product_column_id: number; source_table_name: string;
            source_column_name: string; transformation_description: string | null;
          }>)
      : [];

    // Resolve the named upstream tables/columns back to catalog rows where
    // they still exist (names can outlive a re-profile); an unresolved name
    // still renders — the lineage is the fact, the catalog link is a bonus.
    const upstreamNames = [...new Set(lineage.map((l) => l.source_table_name))];
    const srcTables = upstreamNames.length && pt.dp_connection_id
      ? ((await db('source_tables')
          .where('tenant_id', tenantId)
          .where('connection_id', pt.dp_connection_id)
          .whereIn('table_name', upstreamNames)
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

    const colById = new Map(cols.map((c) => [c.id, c] as const));
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
      const pc = colById.get(l.product_column_id);
      edges.push({
        sourceTable: l.source_table_name,
        sourceColumn: l.source_column_name,
        productTableId: pt.id,
        productColumnId: l.product_column_id,
        transformation: l.transformation_description ?? pc?.transformation_expression ?? null,
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
        const viaLineage = lineage.find((l) => l.product_column_id === c.id)?.transformation_description;
        return {
          id: c.id,
          name: c.column_name,
          displayName: c.display_name,
          transformation: viaLineage ?? c.transformation_expression ?? null,
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
