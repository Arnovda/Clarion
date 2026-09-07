/**
 * AI prompts for Kimball star schema design + SQL generation (single AI call).
 *
 * Optimized for token efficiency: one call produces schema, columns, AND
 * transformation SQL. dim_date is auto-injected by the runner (never AI-generated).
 *
 * Recommended thinking budget: 4000 tokens.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnLineage {
  source_table_name: string;
  source_column_name: string;
  transformation_description: string;
}

export interface ColumnDesign {
  column_name: string;
  data_type: string;
  display_name: string;
  description: string;
  column_role: 'surrogate_key' | 'natural_key' | 'foreign_key' | 'measure' | 'attribute' | 'degenerate_dimension';
  fk_target_table?: string;
  fk_target_column?: string;
  /**
   * When TRUE, this column is technical/infrastructure and must never
   * surface in end-user output (chat results, narratives, default sample
   * previews). It remains available for JOINs in NL→SQL.
   *
   * AI should set TRUE for:
   *   - UUID/GUID-shaped FK columns (account_id from a source like EO,
   *     where the user knows accounts by name, not by GUID)
   *   - Surrogate FK keys (`customer_key`, `account_key`) in facts
   *   - Internal infrastructure (`_row_hash`, etc.)
   *
   * AI should set FALSE for:
   *   - Business identifiers (invoice_number, sku, customer_code)
   *   - All measures, attributes, dates
   */
  is_technical?: boolean;
  transformation_expression: string;
  additivity?: 'additive' | 'semi_additive' | 'non_additive';
  scd_type: number;
  sort_order: number;
  lineage: ColumnLineage[];
}

export interface TableDesign {
  table_name: string;
  display_name: string;
  description: string;
  table_role: 'fact' | 'dimension' | 'bridge' | 'junk';
  dag_order: number;
  transformation_sql?: string;
  columns: ColumnDesign[];
}

export interface RelationshipDesign {
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: 'fact_to_dim' | 'dim_to_dim';
}

export interface StarSchemaDesign {
  name: string;
  description: string;
  grain: string;
  fact_table_type: 'transaction' | 'periodic_snapshot' | 'accumulating_snapshot' | 'factless';
  tables: TableDesign[];
  relationships: RelationshipDesign[];
}

export interface ProposedKpi {
  name: string;
  description: string;
  formula_plain_text: string;
  formula_sql: string;
  additivity: string;
}

/** Output from the combined design + SQL call. */
export interface StarSchemaDesignOutput {
  star_schema: StarSchemaDesign;         // singular — exactly 1 schema per product
  proposed_kpis: ProposedKpi[];
  dim_date_range: { start: string; end: string };
}

// Legacy compat — callers that still reference star_schemas (array) can adapt
export type { StarSchemaDesignOutput as StarSchemaDesignResult };


// ---------------------------------------------------------------------------
// Column Edit (surgical) — unchanged
// ---------------------------------------------------------------------------

export const COLUMN_EDIT_SYSTEM =
`You are a DuckDB SQL expert. The user wants to modify a single column's transformation expression in a star schema table. Return ONLY the updated transformation_expression — nothing else, no JSON wrapping, no explanation.

Rules:
- Output must be a valid DuckDB SQL expression
- It will be used inside a SELECT clause: SELECT {your_expression} AS {column_name}
- Use DuckDB syntax: strftime(col, fmt), CAST, extract, ILIKE, TRY_CAST, etc.
- Do NOT use SQLite functions`;

export function buildColumnEditUser(
  columnName: string,
  currentExpression: string,
  editRequest: string,
  tableContext: string,
): string {
  return `Column: ${columnName}
Current expression: ${currentExpression}
Table context: ${tableContext}

User's edit request: "${editRequest}"

Return ONLY the updated SQL expression.`;
}

// ---------------------------------------------------------------------------
// dim_date template — hardcoded, never AI-generated
// ---------------------------------------------------------------------------

export const DIM_DATE_SQL = (start: string, end: string) => `SELECT
  TRY_CAST(strftime(d, '%Y%m%d') AS INTEGER) AS date_key,
  d::DATE AS full_date,
  extract(year FROM d)::INTEGER AS year,
  extract(quarter FROM d)::INTEGER AS quarter,
  extract(month FROM d)::INTEGER AS month,
  strftime(d, '%B') AS month_name,
  extract(isodow FROM d)::INTEGER AS day_of_week,
  strftime(d, '%A') AS day_name,
  CASE WHEN extract(isodow FROM d) IN (6,7) THEN true ELSE false END AS is_weekend,
  extract(year FROM d)::INTEGER AS fiscal_year,
  extract(quarter FROM d)::INTEGER AS fiscal_quarter
FROM generate_series(DATE '${start}', DATE '${end}', INTERVAL '1 day') AS t(d)`;

export const DIM_DATE_COLUMNS: ColumnDesign[] = [
  { column_name: 'date_key', data_type: 'INTEGER', display_name: 'Date Key', description: 'Surrogate key (YYYYMMDD)', column_role: 'surrogate_key', transformation_expression: "TRY_CAST(strftime(d, '%Y%m%d') AS INTEGER)", scd_type: 1, sort_order: 0, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'full_date', data_type: 'DATE', display_name: 'Date', description: 'Full calendar date', column_role: 'natural_key', transformation_expression: "d::DATE", scd_type: 1, sort_order: 1, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'year', data_type: 'INTEGER', display_name: 'Year', description: 'Calendar year', column_role: 'attribute', transformation_expression: "extract(year FROM d)::INTEGER", scd_type: 1, sort_order: 2, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'quarter', data_type: 'INTEGER', display_name: 'Quarter', description: 'Calendar quarter (1-4)', column_role: 'attribute', transformation_expression: "extract(quarter FROM d)::INTEGER", scd_type: 1, sort_order: 3, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'month', data_type: 'INTEGER', display_name: 'Month', description: 'Month number (1-12)', column_role: 'attribute', transformation_expression: "extract(month FROM d)::INTEGER", scd_type: 1, sort_order: 4, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'month_name', data_type: 'VARCHAR', display_name: 'Month Name', description: 'Full month name', column_role: 'attribute', transformation_expression: "strftime(d, '%B')", scd_type: 1, sort_order: 5, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'day_of_week', data_type: 'INTEGER', display_name: 'Day of Week', description: 'ISO day of week (1=Mon, 7=Sun)', column_role: 'attribute', transformation_expression: "extract(isodow FROM d)::INTEGER", scd_type: 1, sort_order: 6, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'day_name', data_type: 'VARCHAR', display_name: 'Day Name', description: 'Full day name', column_role: 'attribute', transformation_expression: "strftime(d, '%A')", scd_type: 1, sort_order: 7, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'is_weekend', data_type: 'BOOLEAN', display_name: 'Weekend?', description: 'True if Saturday or Sunday', column_role: 'attribute', transformation_expression: "CASE WHEN extract(isodow FROM d) IN (6,7) THEN true ELSE false END", scd_type: 1, sort_order: 8, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'fiscal_year', data_type: 'INTEGER', display_name: 'Fiscal Year', description: 'Fiscal year (same as calendar)', column_role: 'attribute', transformation_expression: "extract(year FROM d)::INTEGER", scd_type: 1, sort_order: 9, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
  { column_name: 'fiscal_quarter', data_type: 'INTEGER', display_name: 'Fiscal Quarter', description: 'Fiscal quarter (same as calendar)', column_role: 'attribute', transformation_expression: "extract(quarter FROM d)::INTEGER", scd_type: 1, sort_order: 10, lineage: [{ source_table_name: 'generated', source_column_name: 'calendar_spine', transformation_description: 'Generated — calendar spine' }] },
];
