/**
 * Enterprise Bus Matrix prompt — designs ALL conformed dimensions and ALL fact
 * tables for an entire source system in one AI call, then groups them into
 * data products.
 *
 * This replaces the old two-step flow (propose → design per product) with a
 * single call that ensures dimensions are never duplicated and are always
 * designed with full richness.
 *
 * Recommended thinking budget: 8000 tokens (more tables to reason about).
 */

import { ColumnDesign } from './starSchemaPrompt';

// Re-export ColumnDesign so consumers don't need to import from two files
export type { ColumnDesign };

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface BusMatrixDimension {
  table_name: string;           // e.g. "dim_article"
  display_name: string;         // e.g. "Article"
  description: string;
  transformation_sql: string;   // Full DuckDB SELECT
  source_tables: string[];      // Which source tables feed this dim
  columns: ColumnDesign[];
}

export interface BusMatrixFact {
  table_name: string;           // e.g. "fact_sales_order_lines"
  display_name: string;         // e.g. "Sales Order Lines"
  description: string;          // MUST start with "One row per ..."
  grain: string;                // e.g. "One row per order line"
  fact_table_type: 'transaction' | 'periodic_snapshot' | 'accumulating_snapshot' | 'factless';
  transformation_sql: string;   // Full DuckDB SELECT
  source_tables: string[];      // Which source tables feed this fact
  dimensions_used: string[];    // e.g. ["dim_article", "dim_customer", "dim_date"]
  columns: ColumnDesign[];
}

export interface BusMatrixRelationship {
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: 'fact_to_dim' | 'dim_to_dim';
}

export interface BusMatrixProductGrouping {
  name: string;                 // e.g. "Sales", "Purchases", "Inventory"
  description: string;
  build_order: number;          // 1 = foundation (dims only), 2+ = domain (facts)
  fact_tables: string[];        // References to fact table names in this product
  owned_dimensions: string[];   // Dims this product "owns" (builds first)
}

export interface BusMatrixKpi {
  name: string;
  description: string;
  formula_plain_text: string;
  formula_sql: string;
  additivity: string;
  product_name: string;         // Which product this KPI belongs to
}

export interface BusMatrixOutput {
  rationale: string;            // 2-3 sentences explaining the design
  conformed_dimensions: BusMatrixDimension[];
  fact_tables: BusMatrixFact[];
  relationships: BusMatrixRelationship[];
  data_products: BusMatrixProductGrouping[];
  proposed_kpis: BusMatrixKpi[];
  dim_date_range: { start: string; end: string };
}

// ---------------------------------------------------------------------------
// Source context types (same as dataProductProposalPrompt for compat)
// ---------------------------------------------------------------------------

export interface SourceTableContext {
  table_name: string;
  display_name: string;
  description: string;
  domain: string;
  columns: Array<{
    column_name: string;
    data_type: string;
    description: string;
    is_primary_key: boolean;
    is_foreign_key: boolean;
    fk_references?: string;
    example_values?: unknown;
  }>;
  relationships: Array<{
    to_table: string;
    via_column: string;
    type: string;
  }>;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function BUS_MATRIX_SYSTEM(sourceContext: string, currentDate: string): string {
  return `You are an expert Kimball data warehouse architect and DuckDB SQL engineer. Your task: design the complete enterprise bus matrix for a source system — ALL conformed dimensions, ALL fact tables, and their transformation SQL — in a single response.

Current date: ${currentDate}

━━━ SOURCE SCHEMA (use ONLY these exact column names — character for character) ━━━

${sourceContext}

━━━ CRITICAL: COLUMN NAME RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Use ONLY the exact column names listed above. NEVER translate, expand, or abbreviate.
- If source has "artikelnr", write "artikelnr" — NOT "artikelnummer" or "article_number".
- If source has "naam", write "naam" — NOT "name" or "naam_nl".
- If source has "groep_id", write "groep_id" — NOT "artikelgroep_id" or "group_id".
- Copy every column name character-for-character. Any deviation causes a runtime crash.

━━━ BUS MATRIX DESIGN PRINCIPLES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The bus matrix identifies:
1. ALL conformed dimensions — designed ONCE with FULL richness, shared across all fact tables
2. ALL business process fact tables — each with a declared grain
3. Which dimensions apply to which facts (the matrix)
4. How to group these into logical data products

**Design ALL dimensions first, then ALL facts, then group into products.**

━━━ STRUCTURAL CONSTRAINTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Each conformed dimension appears EXACTLY ONCE — never duplicated across products.
- A dimension must include ALL relevant attributes from ALL source tables that describe that entity.
  Example: dim_article must include data from artikelen, artikelgroepen, btw_tarieven — not just an ID.
- Maximum 15 tables total across the entire bus matrix (dims + facts).
- At most 1 junk dimension per fact table (include it as a regular dimension).
- Do NOT include dim_date — it is auto-generated by the system.
  But DO reference it: fact table FKs should point to dim_date.date_key (INTEGER, YYYYMMDD format).
  In fact SQL, compute date keys as: TRY_CAST(strftime(TRY_CAST(date_col AS DATE), '%Y%m%d') AS INTEGER)
  Use COALESCE(..., -1) for nullable date FKs.

━━━ KIMBALL METHODOLOGY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Dimensions:**
- Surrogate keys: every dim gets {entity}_key as INTEGER via ROW_NUMBER(). Keep natural key too.
- Denormalize lookups: fold classification/lookup tables INTO their parent dimension
  (customer_groups → dim_customer, product_categories → dim_product, btw_tarieven → dim_article).
  Only separate if the lookup has its own independent facts.
- Flatten hierarchies: no snowflaking — one flat dimension table per entity.
- SCD: default Type 1 (overwrite). Only Type 2 if history tracking is confirmed needed.
- Include ALL descriptive attributes — dimensions should be RICH, not just IDs.

**Facts:**
- Grain: declare "One row per ..." for each fact. Every column must be true to the grain.
- Fact table types: transaction, periodic_snapshot, accumulating_snapshot, factless.
- Measures: classify as additive, semi-additive, or non-additive.
  For ratios: store numerator + denominator as additive columns.
- FKs in facts: named to match target dim's surrogate key. Use COALESCE(dim_key, -1) for unknowns.
- Degenerate dims: transaction/document numbers stay in the fact as plain columns.
- Never place text attributes in fact tables — move them to dimensions.
- Role-playing dims: when one dim appears multiple times (order_date, ship_date),
  create separate FK aliases all pointing to dim_date.

**Data Products (groupings):**
- Product names: plain business nouns (Sales, Purchases, Inventory, Articles, HR).
  FORBIDDEN: "Dimension", "Analytics", "Domain", "Data", "Master", "Hub", "Fact", "360".
- build_order 1: products that only own dimensions (foundation/reference data).
- build_order 2+: products that own fact tables.
- 3-6 products is ideal. Group related facts together (e.g. orders + invoices → Sales).
- owned_dimensions: dims that this product "builds" (typically build_order 1 products).
- Every dimension must appear in exactly one product's owned_dimensions.

━━━ DuckDB SQL RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Each table needs a standalone SELECT statement (no CREATE TABLE). Source tables are pre-loaded as views.

- Dimensions execute FIRST; facts execute SECOND (after dims are materialized as views)
- Fact SQL can JOIN to materialized dims to resolve natural keys → surrogate keys
- ALWAYS use TRY_CAST (not CAST) for type conversions — source data has 'None', 'null', '', 'N/A'
- Use NULLIF(TRIM(CAST(col AS VARCHAR)), '') before TRY_CAST for string→number conversions
- strftime(value, format) — DuckDB arg order (not format, value)
- extract(year FROM col), extract(month FROM col) for date parts

━━━ OUTPUT FORMAT — Return ONLY valid JSON ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "rationale": "2-3 sentence explanation of the bus matrix design",
  "conformed_dimensions": [
    {
      "table_name": "dim_article",
      "display_name": "Article",
      "description": "Conformed article dimension with product hierarchy and pricing",
      "transformation_sql": "SELECT ROW_NUMBER() OVER (ORDER BY a.artikel_id) AS article_key, a.artikel_id, ... FROM artikelen a LEFT JOIN artikelgroepen ag ON ...",
      "source_tables": ["artikelen", "artikelgroepen", "btw_tarieven"],
      "columns": [
        {
          "column_name": "article_key",
          "data_type": "INTEGER",
          "display_name": "Article Key",
          "description": "Surrogate key",
          "column_role": "surrogate_key",
          "transformation_expression": "ROW_NUMBER() OVER (ORDER BY a.artikel_id)",
          "scd_type": 1,
          "sort_order": 0,
          "lineage": [{"source_table_name": "artikelen", "source_column_name": "artikel_id", "transformation_description": "Surrogate from natural key"}]
        }
      ]
    }
  ],
  "fact_tables": [
    {
      "table_name": "fact_sales_order_lines",
      "display_name": "Sales Order Lines",
      "description": "One row per sales order line item",
      "grain": "One row per sales order line",
      "fact_table_type": "transaction",
      "transformation_sql": "SELECT COALESCE(da.article_key, -1) AS article_key, ... FROM verkooporder_regels r LEFT JOIN dim_article da ON ...",
      "source_tables": ["verkooporders", "verkooporder_regels"],
      "dimensions_used": ["dim_article", "dim_customer", "dim_date"],
      "columns": [...]
    }
  ],
  "relationships": [
    {"from_table_name": "fact_sales_order_lines", "from_column_name": "article_key", "to_table_name": "dim_article", "to_column_name": "article_key", "relationship_type": "fact_to_dim"}
  ],
  "data_products": [
    {
      "name": "Articles",
      "description": "Article master data with hierarchy and pricing",
      "build_order": 1,
      "fact_tables": [],
      "owned_dimensions": ["dim_article"]
    },
    {
      "name": "Sales",
      "description": "Sales orders and invoices",
      "build_order": 2,
      "fact_tables": ["fact_sales_order_lines"],
      "owned_dimensions": []
    }
  ],
  "proposed_kpis": [
    {"name": "Total Revenue", "description": "Sum of line totals", "formula_plain_text": "Sum of line_total", "formula_sql": "SUM(fact_sales_order_lines.line_total)", "additivity": "additive", "product_name": "Sales"}
  ],
  "dim_date_range": {"start": "2020-01-01", "end": "2027-12-31"}
}`;
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildBusMatrixUser(
  connectionName: string,
  _sourceContext: string,  // Already in system prompt
): string {
  return `Design the complete Kimball enterprise bus matrix for: "${connectionName}"

Requirements:
- Design ALL conformed dimensions with FULL column details and transformation SQL
- Design ALL fact tables with grains, columns, and transformation SQL
- Group into logical data products (3-6 products)
- Every dimension designed ONCE — never duplicated
- Dimensions must be RICH (all relevant attributes from all source tables), not just IDs
- Do NOT include dim_date (auto-generated by system)
- Use ONLY the exact source column names from the schema above
- Return only valid JSON`;
}
