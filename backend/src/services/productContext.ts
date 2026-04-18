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

  // Get all columns
  const columns: ProductColumnRow[] = await semanticDb('product_columns')
    .whereIn('product_table_id', tableIds)
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
  const semanticContext = tables.map((t) => {
    const cols = columns
      .filter((c) => c.product_table_id === t.id)
      .map((c) => {
        const roleBadge = c.column_role ? ` [${c.column_role}]` : '';
        const addBadge = c.additivity ? ` {${c.additivity}}` : '';
        const fkNote = c.fk_target_table ? ` → ${c.fk_target_table}` : '';
        return `    ${c.column_name} (${c.data_type ?? 'unknown'})${roleBadge}${addBadge}${fkNote}: ${c.description ?? ''}`;
      })
      .join('\n');

    const grainNote = t.grain ? ` (grain: ${t.grain})` : '';
    const roleNote = ` [${t.table_role}]`;
    return `Table: ${t.table_name}${roleNote}${grainNote} — ${t.description ?? ''}\n  Columns:\n${cols}`;
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

  // --- Build catalog for entity matching ---
  const catalog = tables.map((t) => ({
    tableName: t.table_name,
    displayName: t.display_name ?? t.table_name,
    columnNames: columns
      .filter((c) => c.product_table_id === t.id)
      .map((c) => c.column_name),
  }));

  return {
    semanticContext,
    relationshipContext,
    kpiFormulas,
    isProductLayer: true,
    catalog,
  };
}

/**
 * Get the warehouse path for the product layer of a connection.
 * Returns the product directory path or null if not available.
 */
export async function getProductWarehousePath(connectionId: number, trx?: Knex | Knex.Transaction): Promise<string | null> {
  const db = trx ?? semanticDb;
  const product = await db('data_products')
    .where({ connection_id: connectionId })
    .whereIn('status', ['approved', 'success'])
    .first();

  if (!product) return null;

  // Check if any tables have been materialized
  const materializedTable = await db('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .where({ 'star_schemas.data_product_id': product.id })
    .where('product_tables.transformation_status', 'success')
    .whereNotNull('product_tables.delta_path')
    .first();

  if (!materializedTable) return null;

  // The product warehouse is the parent of the table's delta path
  // e.g., ./warehouse/product/finance/  (parent of ./warehouse/product/finance/dim_customer/)
  const productSlug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `./warehouse/product/${productSlug}`;
}
