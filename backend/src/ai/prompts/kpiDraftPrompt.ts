/**
 * KPI Draft Prompt — drafts a SQL formula + plain-English description for a
 * user-defined KPI on a data product.
 *
 * Input: the user's KPI name + (optional) plain-English description, plus
 * the product's tables/columns so Claude can ground references in real
 * schema. Output: structured JSON with `formula_sql` (DuckDB-compatible
 * SELECT expression) and `formula_plain_text` (one-line restatement).
 *
 * Why a separate prompt: KPI formulas are aggregate expressions over a
 * single FROM clause (typically a fact table). They don't need the full
 * NL→SQL machinery; a focused prompt produces tighter, more predictable
 * output.
 */

export interface KpiDraftProductContext {
  productName: string;
  productDescription: string | null;
  tables: Array<{
    tableName: string;
    tableRole: string;
    columns: Array<{
      columnName: string;
      dataType: string;
      columnRole: string | null;
      description: string | null;
    }>;
  }>;
  /** Existing KPI names — Claude is told to avoid duplicating them. */
  existingKpiNames: string[];
}

export const KPI_DRAFT_SYSTEM = `You draft a single KPI definition for a Kimball-style data product.

Output ONLY valid JSON matching this shape — no markdown, no commentary:
{
  "formula_sql": "<DuckDB SELECT expression that returns ONE numeric value>",
  "formula_plain_text": "<one-line restatement in plain English, no jargon>",
  "primary_table": "<the fact/dim table name this KPI reads from>",
  "confidence": "high" | "medium" | "low",
  "notes": "<brief note if anything is ambiguous, else empty string>"
}

Rules:
- formula_sql must be a single SELECT that returns ONE value. Wrap in
  COALESCE if division-by-zero is possible.
- Reference ONLY tables and columns that appear in the AVAILABLE SCHEMA.
  Never invent a column. If the user's request needs a column that does
  not exist, set confidence="low" and explain in notes.
- Prefer fact tables for measure aggregations (SUM/COUNT/AVG). Use dims
  only for filtering or grouping if the KPI requires it.
- Use lowercase SQL keywords; double-quote identifiers that contain
  uppercase, spaces, or special characters.
- Do not add trailing semicolons.
- formula_plain_text is for a business reader. Avoid SQL terms.
  Good: "Total revenue from completed orders"
  Bad:  "SUM of fact_sales.amount where status_id = 1"`;

export function buildKpiDraftUser(
  context: KpiDraftProductContext,
  kpiName: string,
  userDescription: string | null,
): string {
  const tableLines = context.tables.map((t) => {
    const cols = t.columns
      .map((c) => {
        const role = c.columnRole ? ` [${c.columnRole}]` : '';
        const desc = c.description ? ` — ${c.description}` : '';
        return `    ${c.columnName} (${c.dataType})${role}${desc}`;
      })
      .join('\n');
    return `  ${t.tableName} [${t.tableRole}]:\n${cols}`;
  }).join('\n\n');

  const existingBlock = context.existingKpiNames.length > 0
    ? `\nEXISTING KPIS (do not duplicate):\n  ${context.existingKpiNames.join(', ')}\n`
    : '';

  return [
    `PRODUCT: ${context.productName}`,
    context.productDescription ? `DESCRIPTION: ${context.productDescription}` : '',
    '',
    'AVAILABLE SCHEMA:',
    tableLines,
    existingBlock,
    'USER WANTS A KPI CALLED: ' + JSON.stringify(kpiName),
    userDescription ? `USER DESCRIPTION: ${userDescription}` : 'USER DESCRIPTION: (none — infer from the name)',
    '',
    'Draft the KPI definition now. Return only the JSON object.',
  ].filter(Boolean).join('\n');
}
