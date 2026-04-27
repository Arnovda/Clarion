import { TableInfo, FkCandidate } from '../../connectors/BaseConnector';

export interface ColumnQualityStat {
  field_name: string;
  null_pct: number;
  distinct_count: number;
  row_count: number;
  top_values: Array<{ value: string; pct: number }>;
  min_value: string | null;
  max_value: string | null;
}

export interface TableQualityStat {
  table_name: string;
  row_count: number;
  columns: ColumnQualityStat[];
}

export const SCHEMA_DRAFT_SYSTEM = `You are a data cataloguing assistant. Given a database schema with table names, column names, data types, sample values, statistical quality hints, and PRE-DETECTED FOREIGN KEY CANDIDATES, generate business-friendly definitions for every table and column.

Your audience is a business owner who has never seen a database — write descriptions they would instantly understand.

━━━ TABLE DESCRIPTION RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Start with "Your..." or "Contains your..." to make it personal and relatable
- Include the approximate row count when available (e.g., "Your 119 products...", "Your 2,340 invoices...")
- Describe the business purpose, not the technical structure
- NEVER use: "dimension", "fact", "entity", "foreign key", "normalized", "denormalized", "schema", "cardinality", "surrogate", "attribute"
- Use plain language: "products", "customers", "orders", "invoices", "payments"
- Keep it to one sentence, max two
- Examples:
  - BAD: "Rich article dimension with product group hierarchy, VAT details, packaging and storage attributes."
  - GOOD: "Your product catalog with categories, pricing, and VAT details."
  - BAD: "Transaction fact table recording purchase order line items with quantities and amounts."
  - GOOD: "Your purchase orders — what you bought, how much, and from whom."

━━━ COLUMN DESCRIPTION RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Describe the business value, not the technical role
- NEVER use: "Primary key", "Foreign key", "Surrogate key", "Index", "Nullable", "VARCHAR", "INTEGER"
- Use instead: "Unique identifier for...", "Links to...", "The date when...", "Which supplier..."
- Keep it under 15 words
- Examples:
  - BAD: "Foreign key referencing the leverancier table"
  - GOOD: "Which supplier provides this product"
  - BAD: "VARCHAR column containing the article group classification code"
  - GOOD: "Category code for grouping similar products"

━━━ DISPLAY NAME RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Use plain business English, Title Case
- Strip technical prefixes: "dim_article" → "Products", "tbl_klanten" → "Customers"
- Don't use abbreviations unless universally known (VAT, ID are OK)
- Translate non-English table/column names to English display names

━━━ RELATIONSHIP DETECTION RULES (in order of priority) ━━━━━━━━━━━━━━━━━

1. PRE-DETECTED FKs with source "declared" are DECLARED in the database schema — ALWAYS include these. Confidence = 1.0.
2. PRE-DETECTED FKs with source "name_pattern" + high overlap_ratio (≥ 0.9) are near-certain — include these.
3. PRE-DETECTED FKs with source "ai_suggested" were identified by AI and verified with data overlap — include these.
4. PRE-DETECTED FKs with source "value_overlap" + high overlap_ratio (≥ 0.9) are strong candidates — include these.
5. For any remaining relationships YOU detect from the statistics (column naming patterns, cardinality matching), add them too — but ONLY if they don't duplicate a pre-detected one.
6. Prefer SPECIFIC column references (via_column + to_column) over vague guesses.

The statistical hints tell you:
- When distinct_count equals row_count and null_pct is ~0 → that column is almost certainly the PRIMARY KEY
- When a column's distinct_count in one table closely matches the row_count of another table → strong FOREIGN KEY signal; suggest a relationship
- Low-cardinality columns (few distinct values) are dimensions; high-range numeric columns are likely measures

For each table, determine its GRAIN — what does one row represent? Express it as a short phrase starting with "one row per" (e.g. "one row per order", "one row per line item", "one row per customer").

Return JSON only, no preamble, no explanation. You MUST use exactly this structure:

{
  "tables": [
    {
      "table_name": "orders",
      "display_name": "Sales Orders",
      "description": "Your sales orders — each order placed by a customer.",
      "grain": "one row per order",
      "suggested_relationships": [
        { "to_table": "customers", "via_column": "customer_id", "to_column": "id", "type": "many_to_one" }
      ]
    }
  ],
  "columns": [
    {
      "table_name": "orders",
      "column_name": "order_date",
      "display_name": "Order Date",
      "description": "When the customer placed this order",
      "is_dimension": true,
      "is_measure": false
    }
  ]
}

The "columns" array must be flat — one entry per column across all tables, NOT nested inside each table.`;

export function buildSchemaDraftUser(
  sourceType: string,
  tables: TableInfo[],
  qualityStats?: TableQualityStat[],
  fkCandidates?: FkCandidate[],
  glossaryContext = '',
): string {
  const glossarySection = glossaryContext ? `${glossaryContext}\n\n` : '';
  const schemaSection = `${glossarySection}Source type: ${sourceType}
Schema: ${JSON.stringify(
    tables.map((t) => ({
      table_name: t.tableName,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        sample_values: c.sampleValues,
      })),
    })),
    null,
    2,
  )}`;

  const parts: string[] = [schemaSection];

  // FK candidates section
  const relevantFks = (fkCandidates ?? []).filter((fk) =>
    tables.some((t) => t.tableName === fk.fromTable || t.tableName === fk.toTable),
  );
  if (relevantFks.length > 0) {
    const fkLines = relevantFks.map((fk) => {
      const overlap = fk.overlapRatio !== undefined ? `, overlap: ${Math.round(fk.overlapRatio * 100)}%` : '';
      return `  ${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}  [source: ${fk.source}, confidence: ${fk.confidence}${overlap}]`;
    }).join('\n');
    parts.push(`\nPRE-DETECTED FOREIGN KEY CANDIDATES (include ALL of these in suggested_relationships, they are verified):\n${fkLines}`);
  }

  if (qualityStats && qualityStats.length > 0) {
    const statsSection = qualityStats.map((tbl) => {
      const colLines = tbl.columns.map((col) => {
        const nullInfo = col.null_pct > 0.001 ? `${Math.round(col.null_pct * 100)}% null` : '0% null';
        const distinctInfo = `${col.distinct_count} distinct`;
        const pct = tbl.row_count > 0 ? Math.round((col.distinct_count / tbl.row_count) * 100) : 0;

        const hints: string[] = [`${distinctInfo} (${pct}%)`, nullInfo];

        if (col.distinct_count === tbl.row_count && col.null_pct < 0.001) {
          hints.push('→ LIKELY PRIMARY KEY');
        } else if (col.null_pct < 0.05 && pct < 50 && col.distinct_count > 1) {
          hints.push('→ possible FOREIGN KEY');
        }

        if (col.top_values.length > 0 && col.distinct_count <= 20) {
          const vals = col.top_values.slice(0, 6)
            .map((v) => `${v.value}(${Math.round(v.pct * 100)}%)`)
            .join(', ');
          hints.push(`values: ${vals}`);
        } else if (col.min_value !== null && col.max_value !== null) {
          hints.push(`range ${col.min_value}–${col.max_value}`);
        }

        return `    ${col.field_name}: ${hints.join('; ')}`;
      }).join('\n');

      return `${tbl.table_name} (${tbl.row_count} rows):\n${colLines}`;
    }).join('\n\n');

    parts.push(`\nStatistical quality hints (use these to identify PKs, FKs, and relationships):\n${statsSection}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Relationship Re-Suggest Prompt — uses full semantic layer context
// ---------------------------------------------------------------------------

export const RELATIONSHIP_SUGGEST_SYSTEM = `You are a data modelling expert. You are given a fully enriched semantic layer with table definitions, column definitions (including business meaning, dimension/measure classification, statistical quality profiles), existing confirmed relationships, KPI formulas, and pre-detected FK candidates.

Your task: suggest ALL relationships (foreign key joins) between tables. Use every piece of context available, in priority order:

1. **PRE-DETECTED FK CANDIDATES** — these were verified during profiling with actual data overlap checks. Candidates with source "declared" are from the database schema itself. Include ALL of these.
2. **Statistical quality hints** — each column shows distinct_count, null_pct, and row_count. When distinct_count equals row_count and null_pct is ~0 → that column is almost certainly the PRIMARY KEY. When a column's distinct_count closely matches the row_count of another table → strong FOREIGN KEY signal.
3. **Column descriptions** — if a column is described as "references the customer" or "links to the product table", that's a relationship.
4. **Business keys** — columns marked as dimensions with matching names across tables (e.g. customer_id in orders → id in customers).
5. **Data types and naming patterns** — columns ending in _id, _code, _key that match primary keys in other tables.
6. **Grain definitions** — if a table's grain is "one row per order line" and another is "one row per order", they likely join on order_id.
7. **KPI formulas** — if a KPI references multiple tables, those tables must be joinable.
8. **Existing confirmed relationships** — keep these, do not contradict them. You may suggest additional ones.
9. **Sample values** — matching values across columns indicate a join.

For each relationship, specify:
- from_table: the table with the foreign key
- via_column: the FK column name in from_table
- to_table: the referenced table
- to_column: the PK/unique column in to_table
- type: "many_to_one", "one_to_many", or "many_to_many"
- reason: brief explanation of why this relationship exists

Return JSON only, no preamble:
{
  "relationships": [
    {
      "from_table": "order_lines",
      "via_column": "order_id",
      "to_table": "orders",
      "to_column": "id",
      "type": "many_to_one",
      "reason": "Each order line belongs to one order"
    }
  ]
}`;

export interface SemanticContext {
  tables: Array<{
    table_name: string;
    display_name: string;
    description: string;
    grain?: string;
    row_count?: number | null;
  }>;
  columns: Array<{
    table_name: string;
    column_name: string;
    display_name: string;
    description: string;
    data_type: string;
    is_dimension: boolean;
    is_measure: boolean;
    example_values: unknown[];
    // Quality stats from profiling
    distinct_count?: number | null;
    null_pct?: number | null;
    top_values?: unknown;
    min_value?: string | null;
    max_value?: string | null;
  }>;
  relationships: Array<{
    from_table: string;
    from_column: string | null;
    to_table: string;
    to_column: string | null;
    relationship_type: string;
    description: string | null;
  }>;
  kpis: Array<{
    name: string;
    description: string | null;
    formula_sql: string | null;
  }>;
  fkCandidates?: Array<{
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    source: string;
    confidence: number;
    overlapRatio: number | null;
  }>;
}

export interface RelationshipSuggestOutput {
  relationships: Array<{
    from_table: string;
    via_column: string;
    to_table: string;
    to_column: string;
    type: string;
    reason: string;
  }>;
}

export function buildRelationshipSuggestUser(ctx: SemanticContext): string {
  const parts: string[] = [];

  // Tables with descriptions, grain, and row counts
  const tableSection = ctx.tables.map((t) => {
    const rowInfo = t.row_count != null ? ` (${t.row_count} rows)` : '';
    const cols = ctx.columns
      .filter((c) => c.table_name === t.table_name)
      .map((c) => {
        const flags: string[] = [];
        if (c.is_dimension) flags.push('DIMENSION');
        if (c.is_measure) flags.push('MEASURE');
        const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';

        // Quality stats inline
        const stats: string[] = [];
        if (c.distinct_count != null) {
          const pct = t.row_count ? Math.round((c.distinct_count / t.row_count) * 100) : 0;
          stats.push(`${c.distinct_count} distinct (${pct}%)`);
          if (t.row_count && c.distinct_count === t.row_count && (c.null_pct ?? 0) < 0.001) {
            stats.push('LIKELY PRIMARY KEY');
          } else if ((c.null_pct ?? 0) < 0.05 && pct < 50 && c.distinct_count > 1) {
            stats.push('possible FK');
          }
        }
        if (c.null_pct != null && c.null_pct > 0.001) {
          stats.push(`${Math.round(c.null_pct * 100)}% null`);
        }
        if (c.min_value != null && c.max_value != null) {
          stats.push(`range ${c.min_value}–${c.max_value}`);
        }
        const topVals = Array.isArray(c.top_values) && c.top_values.length > 0 && (c.distinct_count ?? 999) <= 20
          ? c.top_values.slice(0, 6).map((v: any) => `${v.value ?? v}(${Math.round((v.pct ?? 0) * 100)}%)`).join(', ')
          : null;
        if (topVals) stats.push(`values: ${topVals}`);

        const statsStr = stats.length ? ` | ${stats.join('; ')}` : '';
        const samples = Array.isArray(c.example_values) && c.example_values.length
          ? ` samples: ${JSON.stringify(c.example_values.slice(0, 5))}`
          : '';
        return `    ${c.column_name} (${c.data_type})${flagStr}: ${c.description ?? c.display_name ?? ''}${statsStr}${samples}`;
      })
      .join('\n');
    return `Table: ${t.table_name}${rowInfo} — ${t.description ?? t.display_name ?? ''}\n  Grain: ${t.grain ?? 'unknown'}\n  Columns:\n${cols}`;
  }).join('\n\n');

  parts.push(tableSection);

  // Pre-detected FK candidates from profiling
  const fks = ctx.fkCandidates ?? [];
  if (fks.length > 0) {
    const fkLines = fks.map((fk) => {
      const overlap = fk.overlapRatio != null ? `, overlap: ${Math.round(fk.overlapRatio * 100)}%` : '';
      return `  ${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}  [source: ${fk.source}, confidence: ${(fk.confidence * 100).toFixed(0)}%${overlap}]`;
    }).join('\n');
    parts.push(`\nPRE-DETECTED FK CANDIDATES (verified during profiling — include ALL of these):\n${fkLines}`);
  }

  // Existing confirmed relationships
  if (ctx.relationships.length > 0) {
    const relLines = ctx.relationships.map((r) => {
      const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
      const to = r.to_column ? `${r.to_table}.${r.to_column}` : r.to_table;
      return `  ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
    }).join('\n');
    parts.push(`\nEXISTING CONFIRMED RELATIONSHIPS (keep these, suggest additional ones):\n${relLines}`);
  }

  // KPI formulas
  if (ctx.kpis.length > 0) {
    const kpiLines = ctx.kpis.map((k) => {
      return `  ${k.name}: ${k.description ?? ''}${k.formula_sql ? `\n    SQL: ${k.formula_sql}` : ''}`;
    }).join('\n');
    parts.push(`\nKPI DEFINITIONS (these imply table relationships):\n${kpiLines}`);
  }

  return parts.join('\n\n');
}

export interface SchemaDraftOutput {
  tables: Array<{
    table_name: string;
    display_name: string;
    description: string;
    grain?: string;        // e.g. "one row per order"
    suggested_relationships: Array<{
      to_table: string;
      via_column: string;   // column in the FROM table (the FK side)
      to_column: string;    // column in the TO table (the PK side)
      type: string;
    }>;
  }>;
  columns: Array<{
    table_name: string;
    column_name: string;
    display_name: string;
    description: string;
    is_dimension: boolean;
    is_measure: boolean;
  }>;
}
