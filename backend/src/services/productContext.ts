/**
 * Product Context Builder — builds semantic context from the product layer
 * (star schema tables) instead of the source layer for NL→SQL queries.
 *
 * When a connection has a data product with successfully run transformations,
 * this provides richer, cleaner context for the AI: properly modeled facts
 * and dimensions with clear grain, relationships, and KPI definitions.
 */

import fs from 'fs';
import path from 'path';
import { semanticDb } from '../db/knex';
import type { Knex } from 'knex';
import { isAzurePath, warehouseRoot } from './warehouse';

interface ProductTableRow {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  star_schema_name: string;
  grain: string | null;
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

/**
 * Scan a local product warehouse directory for pre-aggregated rollup tables.
 * Rollups are written by the transformation runner to `rollup_monthly_<fact_table>/`.
 * Returns an empty array for Azure paths or missing directories.
 */
function detectRollupTables(productDir: string): { name: string; factTable: string }[] {
  if (!productDir || isAzurePath(productDir) || !fs.existsSync(productDir)) return [];
  try {
    return fs.readdirSync(productDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('rollup_monthly_'))
      .map((e) => ({ name: e.name, factTable: e.name.replace('rollup_monthly_', '') }));
  } catch {
    return [];
  }
}

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
 */
export async function buildProductSemanticContext(
  connectionId: number,
  filterProductIds?: number[],
): Promise<ProductSemanticContext | null> {
  // Find data products for this connection
  let query = semanticDb('data_products')
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
  const schemas = await semanticDb('star_schemas')
    .whereIn('data_product_id', productIds);

  const schemaIds = schemas.map((s: { id: number }) => s.id);
  if (schemaIds.length === 0) return null;

  // Get all product tables with star schema info
  let tables: ProductTableRow[] = await semanticDb('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .whereIn('star_schemas.id', schemaIds)
    .where('product_tables.transformation_status', 'success')
    .select(
      'product_tables.id',
      'product_tables.table_name',
      'product_tables.display_name',
      'product_tables.description',
      'product_tables.table_role',
      'star_schemas.name as star_schema_name',
      'star_schemas.grain',
    );

  // Include shared dimensions from OTHER products for the same connection.
  // Dimensions (like dim_customer, dim_article) are often defined in one product
  // but referenced by fact tables in another. Without this, the AI sees fact tables
  // but no dimensions to join to and hallucinates column names.
  const existingTableNames = new Set(tables.map((t) => t.table_name));
  const allProductIds = (await semanticDb('data_products')
    .where({ connection_id: connectionId })
    .whereIn('status', ['approved', 'success'])
    .select('id')).map((p: { id: number }) => p.id);

  if (allProductIds.length > productIds.length) {
    const allSchemaIds = (await semanticDb('star_schemas')
      .whereIn('data_product_id', allProductIds)
      .select('id')).map((s: { id: number }) => s.id);

    const sharedDims: ProductTableRow[] = await semanticDb('product_tables')
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
  const columns: ProductColumnRow[] = await semanticDb('product_columns')
    .whereIn('product_table_id', tableIds)
    .andWhereRaw(`column_name NOT LIKE '\\_%' ESCAPE '\\'`)
    .orderBy(['sort_order', 'id']);

  // Get relationships
  const relationships: ProductRelRow[] = await semanticDb('product_relationships as pr')
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
  const kpis: ProductKpiRow[] = await semanticDb('product_kpis')
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

  // --- Detect pre-aggregated rollup tables (local warehouse only) ---
  const productSlugs = products.map(
    (p: { name: string }) => p.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
  );
  const rollupLines: string[] = [];
  for (const slug of productSlugs) {
    const productDir = path.resolve('./warehouse/product', slug);
    for (const rollup of detectRollupTables(productDir)) {
      rollupLines.push(
        `- ${rollup.name}: monthly pre-aggregation of ${rollup.factTable}. ` +
        `Contains: month (TIMESTAMP, first day of month), all dimension columns, SUM of all measures, _row_count. ` +
        `USE THIS table instead of ${rollup.factTable} for any monthly/quarterly/yearly time-series query.`,
      );
    }
  }
  const rollupSection = rollupLines.length > 0
    ? `\n\n## ROLLUP TABLES — always prefer for aggregate time-series queries\n${rollupLines.join('\n')}`
    : '';

  // --- Build catalog for entity matching ---
  const catalog = tables.map((t) => ({
    tableName: t.table_name,
    displayName: t.display_name ?? t.table_name,
    columnNames: columns
      .filter((c) => c.product_table_id === t.id)
      .map((c) => c.column_name),
  }));

  return {
    semanticContext: semanticContext + rollupSection,
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
  return warehouseRoot();
}
