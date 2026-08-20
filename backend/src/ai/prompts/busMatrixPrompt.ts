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
- HARD CAP: 20 tables total (dims + facts). Going over the cap risks output truncation
  which CORRUPTS THE BUILD. Typically 5-7 dimensions and 7-12 facts.
  Prioritise complete coverage of all business processes — but MERGE aggressively
  before adding tables. Sales orders + sales invoices → one fact_sales. Purchase
  orders + purchase invoices → one fact_purchases. Aging receivables/payables →
  fold into the relevant transaction fact as snapshot columns, do NOT split.
  When in doubt, merge.
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
- EMPTY TABLES: some tables are annotated with their row count from the last
  analysis. NEVER design a fact table whose source tables are ALL marked
  "NO ROWS" — it would materialise empty and the topic would answer nothing.
  Leave that subject area out entirely. An empty LOOKUP table may still feed
  a dimension when a populated fact references it. Tables without a row-count
  annotation were not measured — treat them as populated.

**Data Products (groupings):**
- Product names: plain business nouns (Sales, Purchases, Inventory, Articles, HR).
  FORBIDDEN: "Dimension", "Analytics", "Domain", "Data", "Master", "Hub", "Fact", "360".
- build_order 1: products that only own dimensions (foundation/reference data).
- build_order 2+: products that own fact tables.
- Pick whatever number of products makes sense for end users — fewer is better when the grouping stays logical. Group related facts together (e.g. orders + invoices → Sales). Do not split for the sake of splitting; do not lump unrelated processes together. The test is: would a business user looking at this product expect to find these facts here?
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

━━━ COLUMN CONSISTENCY (CRITICAL — most common failure mode) ━━━━━━━━━━━━

Every column referenced in a fact's JOIN ON, WHERE, or SELECT clause when
qualified by a dim alias (e.g. \`dc.source_system\`, \`da.article_key\`)
MUST exist in that dim's \`columns[]\` list. If you reference it, define it.

Specifically forbidden patterns that crash the build:
- \`LEFT JOIN dim_customer dc ON f.klant_id = dc.klant_id AND dc.source_system = 'klanten'\`
  ↳ ONLY valid if dim_customer has a \`source_system\` column in its columns[].
  ↳ Otherwise drop the AND clause entirely and just join on the natural key.
- Filtering on a column that exists in the SOURCE table but you didn't carry into the dim.
- Joining to a dim using a natural-key column you renamed in the dim's SELECT.

When a single conformed dim is fed by multiple source tables (e.g. klanten + customers):
  → EITHER include \`source_system\` (and any other distinguishing columns) in the dim's
    columns[] AND in its transformation_sql SELECT, then filter on it in fact JOINs;
  → OR pick one source as primary, omit \`source_system\` from the dim entirely, AND
    do not reference it in any fact's JOIN/WHERE.
Do NOT do half of one and half of the other — that is the #1 cause of "Binder Error:
column does not exist" failures. The fact SQL must only reference columns you actually
defined on the dim.

━━━ OUTPUT SIZE — CRITICAL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your output MUST be complete valid JSON. Truncated output is fatal — the build
will corrupt and the user loses 5-10 minutes of design work. The fields
data_products, relationships, proposed_kpis, and dim_date_range come AFTER
conformed_dimensions and fact_tables in the JSON, so they are the first
casualty of a token-budget overrun. Budget aggressively:

- Keep transformation_sql concise: use short table aliases (a, b, c), no comments in SQL.
- Keep column descriptions to one short sentence (< 12 words).
- OMIT the lineage[] field unless the column transformation is non-trivial.
  Surrogate keys, direct passthrough columns, and simple CASTs do NOT need lineage.
- Do NOT add extra whitespace or pretty-print. Compact JSON is fine.
- If you find yourself approaching 20 tables, MERGE rather than ADD. A complete
  16-table design beats a truncated 24-table one.

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
// Extension prompt — design ONE additional topic next to an existing build
// ---------------------------------------------------------------------------

/**
 * A reusable existing dimension, summarised for the extension prompt: the
 * model must JOIN these by their real column names, never redefine them.
 */
export interface ExistingDimContext {
  table_name: string;
  display_name: string;
  description: string;
  columns: Array<{ column_name: string; data_type: string; column_role: string | null }>;
}

export function BUS_MATRIX_EXTEND_SYSTEM(
  sourceContext: string,
  existingDims: ExistingDimContext[],
  forbiddenTableNames: string[],
  currentDate: string,
): string {
  const dimsText = existingDims.length === 0
    ? '(none built yet — you may create the dimensions this subject needs)'
    : existingDims.map((d) => {
        const cols = d.columns
          .map((c) => `    ${c.column_name} (${c.data_type})${c.column_role ? ` [${c.column_role}]` : ''}`)
          .join('\n');
        return `${d.table_name} — ${d.display_name}: ${d.description}\n${cols}`;
      }).join('\n\n');

  return `You are an expert Kimball data warehouse architect and DuckDB SQL engineer. An enterprise bus matrix has ALREADY been built for this source. Your task: design EXACTLY ONE additional data product (one new subject area) that slots in NEXT TO the existing build without touching it.

Current date: ${currentDate}

━━━ SOURCE SCHEMA (use ONLY these exact column names — character for character) ━━━

${sourceContext}

━━━ EXISTING SHARED DIMENSIONS (REUSE these — never redefine them) ━━━━━━━━

${dimsText}

━━━ EXTENSION RULES (each one is enforced in code — violations fail the build) ━━━

1. Output EXACTLY ONE entry in data_products. Its name is given in the user
   message — use it verbatim. Set build_order: 2.
2. REUSE the existing dimensions above wherever they cover a concept your
   fact needs: name them in dimensions_used, point fact FK columns at their
   real key columns, and JOIN them in fact SQL using ONLY the column names
   listed above. Do NOT include a reused dimension in conformed_dimensions
   or owned_dimensions — it already exists.
3. conformed_dimensions may contain ONLY genuinely NEW dimensions — concepts
   no existing dimension covers. Name them dim_<singular_english_noun>.
4. NEVER use any of these table names (they already exist): ${forbiddenTableNames.join(', ') || '(none)'}
5. Do NOT include dim_date — it is auto-generated. Reference it as usual:
   fact FKs point to dim_date.date_key (INTEGER YYYYMMDD), computed as
   TRY_CAST(strftime(TRY_CAST(date_col AS DATE), '%Y%m%d') AS INTEGER),
   COALESCE(..., -1) when nullable.
6. EMPTY TABLES: never design a fact whose source tables are ALL marked
   "NO ROWS". An empty lookup may still feed a dimension.
7. Keep it focused: 1-3 fact tables, only the new dimensions this subject
   really needs. This is one subject, not a redesign.
8. Propose 2-4 KPIs for the new product (product_name = the given name).

━━━ KIMBALL + DuckDB RULES (same as the original build) ━━━━━━━━━━━━━━━━━━

- Grain: every fact declares "One row per ...". Surrogate keys via ROW_NUMBER()
  for NEW dims only. ALWAYS TRY_CAST, never CAST. strftime(value, format).
- Every column referenced through a dim alias in fact SQL MUST exist on that
  dim — for reused dims that means the column lists printed above, exactly.
- Facts JOIN reused dims to resolve natural keys → surrogate keys, e.g.
  LEFT JOIN dim_item di ON TRIM(CAST(s.Item AS VARCHAR)) = TRIM(CAST(di.item_id AS VARCHAR))
  (adjust to the real key columns above).

━━━ OUTPUT FORMAT — the SAME JSON shape as the original bus matrix ━━━━━━━

{
  "rationale": "...",
  "conformed_dimensions": [ /* NEW dims only — often empty */ ],
  "fact_tables": [ /* the new subject's facts */ ],
  "relationships": [ /* fact → dim links, including links to REUSED dims */ ],
  "data_products": [ { "name": "<given>", "description": "...", "build_order": 2, "fact_tables": [...], "owned_dimensions": [ /* NEW dims only */ ] } ],
  "proposed_kpis": [...],
  "dim_date_range": {"start": "2020-01-01", "end": "2027-12-31"}
}

Return ONLY valid JSON. Keep transformation_sql concise (short aliases, no
comments); omit lineage[] for trivial columns.`;
}

export function buildBusMatrixExtendUser(
  connectionName: string,
  productName: string,
  description: string,
  focus: string | undefined,
  entities: string[],
): string {
  return `Extend the existing build for "${connectionName}" with ONE new data product.

Product name (use verbatim): "${productName}"
What it is about: ${description}${focus ? `\nWhat the user most wants to see: ${focus}` : ''}
Source tables to build it from: ${entities.join(', ')}

Requirements:
- Design ONLY this one product; reuse existing dimensions per the rules above
- Use ONLY exact source column names from the schema
- Return only valid JSON`;
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
- Group into logical data products (fewer is better as long as the grouping is intuitive for business users)
- Every dimension designed ONCE — never duplicated
- Dimensions must be RICH (all relevant attributes from all source tables), not just IDs
- Do NOT include dim_date (auto-generated by system)
- Use ONLY the exact source column names from the schema above
- Return only valid JSON`;
}
