/**
 * Product Context Builder — builds semantic context from the product layer
 * (star schema tables) instead of the source layer for NL→SQL queries.
 *
 * When a connection has a data product with successfully run transformations,
 * this provides richer, cleaner context for the AI: properly modeled facts
 * and dimensions with clear grain, relationships, and KPI definitions.
 */

import { semanticDb } from '../db/knex';
import type { Knex } from 'knex';
import { warehouseRoot, rollupViewName, gridViewName } from './warehouse';

interface ProductTableRow {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  star_schema_name: string;
  grain: string | null;
  /** Set by `publishRollup` when this fact has a monthly pre-aggregation. */
  rollup_path: string | null;
  rollup_row_count: number | string | null;
}

interface ProductColumnRow {
  id: number;
  product_table_id: number;
  column_name: string;
  data_type: string | null;
  display_name: string | null;
  description: string | null;
  column_role: string | null;
  fk_target_table: string | null;
  additivity: string | null;
  is_technical: boolean | null;
}

interface ProductRelRow {
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: string;
}

interface ProductKpiRow {
  name: string;
  description: string | null;
  formula_plain_text: string | null;
  formula_sql: string | null;
}

export interface ProductSemanticContext {
  semanticContext: string;
  relationshipContext: string;
  kpiFormulas: string;
  /** True if product layer was found and used */
  isProductLayer: boolean;
  /** For entity matching */
  catalog: { tableName: string; displayName: string; columnNames: string[] }[];
}

// Rollups used to be discovered by scanning the filesystem here. That scan
// bailed on `az://` paths and looked in the v1 local `./warehouse/product/<slug>`
// layout, while the default layout is v2 and production is Azure — so it
// returned empty in production for its entire life and the model never learned
// that a pre-aggregation existed. The location is now recorded on the
// product_tables row by `publishRollup` at write time and read back below.
// Do not reintroduce a path-derivation here.

/**
 * Check if a connection has a product layer (data product with successfully
 * transformed tables).
 */
export async function hasProductLayer(connectionId: number): Promise<boolean> {
  const product = await semanticDb('data_products')
    .where({ connection_id: connectionId })
    .whereIn('status', ['approved', 'success'])
    .first();

  if (!product) return false;

  // Check if there are any successfully transformed tables
  const successTable = await semanticDb('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .where({ 'star_schemas.data_product_id': product.id })
    .where('product_tables.transformation_status', 'success')
    .first();

  return !!successTable;
}

/**
 * Build semantic context from the product layer for a connection.
 * Returns formatted strings ready to inject into AI prompts.
 *
 * `trx`: optional. When provided (typically `reqDb(req)` from an
 * authenticated request), all internal queries run on that connection
 * and inherit its tenant context. When omitted, queries run on
 * `semanticDb` directly — which, under the non-bypass `databridge_app`
 * role, will return zero rows for `data_products` and the function will
 * incorrectly return null, causing the AI to fall back to source-layer
 * naming and generating SQL against tables that the product-layer
 * connector hasn't registered. This is exactly how the May 24 2026
 * dashboard-generation failure surfaced (every widget "SalesInvoices
 * does not exist" because the AI got source context but the connector
 * served product tables). Always pass the request trx in authenticated
 * routes; the optional shape is only kept for any legacy unauthenticated
 * caller.
 */
export async function buildProductSemanticContext(
  connectionId: number,
  filterProductIds?: number[],
  trx?: Knex | Knex.Transaction,
): Promise<ProductSemanticContext | null> {
  const db = trx ?? semanticDb;

  // Find data products for this connection
  let query = db('data_products')
    .where({ connection_id: connectionId })
    .whereIn('status', ['approved', 'success']);

  // Optionally filter to specific product IDs
  if (filterProductIds && filterProductIds.length > 0) {
    query = query.whereIn('id', filterProductIds);
  }

  const products = await query;

  if (products.length === 0) return null;

  const productIds = products.map((p: { id: number }) => p.id);

  // Get all star schemas
  const schemas = await db('star_schemas')
    .whereIn('data_product_id', productIds);

  const schemaIds = schemas.map((s: { id: number }) => s.id);
  if (schemaIds.length === 0) return null;

  // Get all product tables with star schema info
  let tables: ProductTableRow[] = await db('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .whereIn('star_schemas.id', schemaIds)
    .where('product_tables.transformation_status', 'success')
    .select(
      'product_tables.id',
      'product_tables.table_name',
      'product_tables.display_name',
      'product_tables.description',
      'product_tables.table_role',
      'product_tables.rollup_path',
      'product_tables.rollup_row_count',
      'star_schemas.name as star_schema_name',
      'star_schemas.grain',
    );

  // Include shared dimensions from OTHER products for the same connection.
  // Dimensions (like dim_customer, dim_article) are often defined in one product
  // but referenced by fact tables in another. Without this, the AI sees fact tables
  // but no dimensions to join to and hallucinates column names.
  const existingTableNames = new Set(tables.map((t) => t.table_name));
  const allProductIds = (await db('data_products')
    .where({ connection_id: connectionId })
    .whereIn('status', ['approved', 'success'])
    .select('id')).map((p: { id: number }) => p.id);

  if (allProductIds.length > productIds.length) {
    const allSchemaIds = (await db('star_schemas')
      .whereIn('data_product_id', allProductIds)
      .select('id')).map((s: { id: number }) => s.id);

    const sharedDims: ProductTableRow[] = await db('product_tables')
      .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
      .whereIn('star_schemas.id', allSchemaIds)
      .where('product_tables.transformation_status', 'success')
      .whereIn('product_tables.table_role', ['dimension', 'bridge'])
      .whereNotIn('product_tables.table_name', [...existingTableNames])
      .select(
        'product_tables.id',
        'product_tables.table_name',
        'product_tables.display_name',
        'product_tables.description',
        'product_tables.table_role',
        'product_tables.rollup_path',
        'product_tables.rollup_row_count',
        'star_schemas.name as star_schema_name',
        'star_schemas.grain',
      );

    // Deduplicate by table_name (pick the first match)
    for (const dim of sharedDims) {
      if (!existingTableNames.has(dim.table_name)) {
        tables.push(dim);
        existingTableNames.add(dim.table_name);
      }
    }
  }

  if (tables.length === 0) return null;

  const tableIds = tables.map((t) => t.id);

  // Get all columns INCLUDING is_technical ones — the AI needs the
  // technical FK columns (account_id GUID, customer_key, etc.) to build
  // JOIN clauses. The prompt rules then forbid the AI from putting
  // is_technical columns in SELECT (they appear as JOIN-only annotated
  // in the schema string downstream).
  //
  // The ONLY columns we filter out entirely are pure infrastructure
  // (`_row_hash`, future `_valid_from` / `_valid_to` / `_is_current`).
  // These start with an underscore by convention and the AI never needs
  // to reference them — they're SCD machinery, not data.
  const columns: ProductColumnRow[] = await db('product_columns')
    .whereIn('product_table_id', tableIds)
    .andWhereRaw(`column_name NOT LIKE '\\_%' ESCAPE '\\'`)
    .orderBy(['sort_order', 'id']);

  // Get relationships
  const relationships: ProductRelRow[] = await db('product_relationships as pr')
    .join('product_tables as ft', 'pr.from_table_id', 'ft.id')
    .join('product_tables as tt', 'pr.to_table_id', 'tt.id')
    .whereIn('pr.star_schema_id', schemaIds)
    .select(
      'ft.table_name as from_table_name',
      'pr.from_column_name',
      'tt.table_name as to_table_name',
      'pr.to_column_name',
      'pr.relationship_type',
    );

  // Get KPIs
  const kpis: ProductKpiRow[] = await db('product_kpis')
    .whereIn('data_product_id', productIds);

  // --- Format semantic context ---
  // Compact column line. Goal: every char carries semantic load.
  //   measure:   revenue (DECIMAL) [m,additive]: Sales amount
  //   dim FK:    customer_key (BIGINT) →dim_customer: Customer FK
  //   dim attr:  customer_name (VARCHAR): Customer name
  //   no type:   <field> : description (skip "(unknown)")
  //   no desc:   <field> (no trailing ": ")
  // Default role is dimension/attribute — only mark measures explicitly,
  // since that's what affects aggregation choice. FK arrow implies dim
  // semantics so we don't repeat [dimension] there. Saves ~30% on column
  // lines for a typical product context block, which is the dominant
  // payload of NL→SQL.
  const semanticContext = tables.map((t) => {
    const cols = columns
      .filter((c) => c.product_table_id === t.id)
      // Business columns first, JOIN-only (is_technical) columns last
      // so the AI sees the user-facing identifiers as the natural
      // SELECT candidates.
      .sort((a, b) => Number(a.is_technical ?? false) - Number(b.is_technical ?? false))
      .map((c) => {
        const typePart = c.data_type ? ` (${c.data_type})` : '';
        const isMeasure = c.column_role === 'measure';
        const measureTag = isMeasure
          ? (c.additivity ? ` [m,${c.additivity}]` : ' [m]')
          : '';
        const fkNote = c.fk_target_table ? ` →${c.fk_target_table}` : '';
        // [JOIN-ONLY] tag for is_technical columns. The NL→SQL prompt
        // explicitly forbids putting these in SELECT — they're for
        // JOIN clauses only. Makes the firewall visible at every
        // column-mention rather than a separate rule the AI has to
        // remember.
        const technicalTag = c.is_technical ? ' [JOIN-ONLY]' : '';
        const descPart = c.description ? `: ${c.description}` : '';
        return `    ${c.column_name}${typePart}${measureTag}${fkNote}${technicalTag}${descPart}`;
      })
      .join('\n');

    const grainNote = t.grain ? `, grain: ${t.grain}` : '';
    const descPart = t.description ? ` — ${t.description}` : '';
    return `Table ${t.table_name} (${t.table_role}${grainNote})${descPart}\n  Columns:\n${cols}`;
  }).join('\n\n');

  // --- Format relationship context ---
  const relationshipContext = relationships.length
    ? relationships
        .map((r) => `- ${r.from_table_name}.${r.from_column_name} → ${r.to_table_name}.${r.to_column_name} (${r.relationship_type})`)
        .join('\n')
    : 'Star schema relationships are defined by foreign key columns in fact tables.';

  // --- Format KPI formulas ---
  const kpiFormulas = kpis.length
    ? kpis
        .map((k) => `${k.name}:\n  Business definition: ${k.formula_plain_text ?? k.name}\n  SQL formula: ${k.formula_sql ?? '(not yet defined)'}`)
        .join('\n\n')
    : 'No KPIs defined yet.';

  // --- Pre-aggregated rollup tables, as recorded at write time ---
  const rollupLines: string[] = tables
    .filter((t) => t.rollup_path)
    .map((t) => {
      const rollupName = rollupViewName(t.table_name);
      const rows = Number(t.rollup_row_count);
      const size = Number.isFinite(rows) && rows > 0 ? ` ~${rows.toLocaleString('en-GB')} rows.` : '';
      return `- ${rollupName}: monthly pre-aggregation of ${t.table_name}.${size} ` +
        `Contains: month (TIMESTAMP, first day of month), all dimension columns, SUM of all measures, _row_count. ` +
        `USE THIS table instead of ${t.table_name} for any monthly/quarterly/yearly time-series query.`;
    });
  const rollupSection = rollupLines.length > 0
    ? `\n\n## ROLLUP TABLES — always prefer for aggregate time-series queries\n${rollupLines.join('\n')}`
    : '';

  // --- Managed grids: tables the user maintains inside Clarion ---
  // Tenant-level (not connection-scoped) on purpose; the views are registered
  // by createProductConnector in every product-layer session, so advertising
  // them here is the other half of the fix-both-or-neither pair. Tenancy is
  // enforced by RLS on the passed trx, same as every query above.
  const gridRows: Array<{
    slug: string; name: string; kind: string; description: string | null;
    row_count: number;
    columns: Array<{ key: string; name: string; type: string; link?: { table: string; column: string } | null }>;
  }> = await db('managed_grids')
    .whereNotNull('warehouse_path')
    .select('slug', 'name', 'kind', 'description', 'row_count', 'columns');

  const gridLines = gridRows.map((g) => {
    const gcols = Array.isArray(g.columns) ? g.columns : [];
    const cols = gcols
      .map((c) => `${c.key} (${c.type.toUpperCase()}${c.name !== c.key ? `, "${c.name}"` : ''})`)
      .join(', ');
    const rows = Number(g.row_count);
    const size = Number.isFinite(rows) && rows > 0 ? ` ~${rows.toLocaleString('en-GB')} rows.` : ' (empty).';
    const desc = g.description ? ` ${g.description}` : '';
    // Linked columns are the join contract: the user DECLARED what the
    // column contains, so the model never has to guess the join.
    const joins = gcols
      .filter((c) => c.link)
      .map((c) => `JOIN ${gridViewName(g.slug)}.${c.key} = ${c.link!.table}.${c.link!.column}`)
      .join('; ');
    const joinHint = joins ? ` ${joins}.` : '';
    return `- ${gridViewName(g.slug)} ("${g.name}", ${g.kind}):${desc} Columns: ${cols}.${joinHint}${size}`;
  });
  const gridSection = gridLines.length > 0
    ? `\n\n## YOUR TABLES — data the user maintains directly in Clarion (budgets, mappings, lists)\n` +
      `These are ordinary tables; JOIN them freely with the tables above (e.g. budget vs actuals).\n` +
      gridLines.join('\n')
    : '';

  // --- Build catalog for entity matching ---
  const catalog = tables.map((t) => ({
    tableName: t.table_name,
    displayName: t.display_name ?? t.table_name,
    columnNames: columns
      .filter((c) => c.product_table_id === t.id)
      .map((c) => c.column_name),
  }));
  for (const g of gridRows) {
    catalog.push({
      tableName: gridViewName(g.slug),
      displayName: g.name,
      columnNames: (Array.isArray(g.columns) ? g.columns : []).map((c) => c.key),
    });
  }

  return {
    semanticContext: semanticContext + rollupSection + gridSection,
    relationshipContext,
    kpiFormulas,
    isProductLayer: true,
    catalog,
  };
}

/**
 * Get a "warehouse path" for a connection's product layer.
 *
 * This is mostly a cache-key for `createProductConnector` — the actual
 * data access uses explicit `tablePaths` from the catalog, so the
 * returned string only needs to be stable + env-aware. Returns the
 * canonical warehouse root (`az://<container>` in Azure mode, the
 * resolved local `./warehouse` path otherwise).
 *
 * Returns null when the connection has no successfully materialised
 * product table — a sentinel that callers use to decide whether to
 * route the query against the source-layer connector instead.
 */
export async function getProductWarehousePath(connectionId: number, trx?: Knex | Knex.Transaction): Promise<string | null> {
  const db = trx ?? semanticDb;

  // "Has any table been materialised?" — cheap existence probe. We don't
  // care about WHICH table; the catalog returns concrete URIs per-table
  // via `listProductTablesByConnection` when the connector is built.
  const hasAny = await db('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .join('data_products', 'star_schemas.data_product_id', 'data_products.id')
    .where('data_products.connection_id', connectionId)
    .where('product_tables.transformation_status', 'success')
    .whereNotNull('product_tables.delta_path')
    .first();

  if (!hasAny) return null;

  // Tenant-aware root so per-tenant-container mode resolves to the tenant's own
  // container (and so the connector cache key can't collide across tenants).
  // RLS already scopes `db`, so this row is the current tenant's connection.
  const conn = await db('connections').where({ id: connectionId }).select('tenant_id').first();
  const tenantId = conn?.tenant_id != null ? Number(conn.tenant_id) : undefined;
  return warehouseRoot(tenantId);
}
