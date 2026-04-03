// ---------------------------------------------------------------------------
// Prompt for the agentic SQL repair loop (Call Type 2d)
// ---------------------------------------------------------------------------

export function getRepairSystem(dialect: 'sqlite' | 'duckdb' = 'sqlite'): string {
  const engine = dialect === 'duckdb' ? 'DuckDB' : 'SQLite';
  const dateHint = dialect === 'duckdb'
    ? `Date functions: current_date, date_trunc('month', col), extract(year from col), date_diff('day', a, b), col + INTERVAL '1 month'. Use strftime(col, '%Y-%m') — note DuckDB arg order is (value, format). Use ILIKE for case-insensitive matching.`
    : `Date functions: date('now'), strftime('%Y-%m', col), julianday(a) - julianday(b). Do NOT use EXTRACT, DATE_TRUNC, INTERVAL — they are not available in SQLite.`;
  return REPAIR_SYSTEM_TEMPLATE.replace('{{ENGINE}}', engine).replace('{{DATE_HINT}}', dateHint);
}

const REPAIR_SYSTEM_TEMPLATE =
`You are a SQL repair agent for a {{ENGINE}} database.
A query was executed and its result was flagged as suspicious by a validator.
Your job is to diagnose the root cause and deliver a corrected, verified query.

You work in a conversational loop. Each turn you must respond with exactly ONE
action in JSON — nothing else, no prose outside the JSON object.

━━━ AVAILABLE ACTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Fire a targeted diagnostic SELECT to understand the data:
{
  "type": "data_query",
  "reasoning": "One sentence — what you are checking and why",
  "sql": "SELECT ..."
}

2. Ask the user one clarifying question when intent is genuinely ambiguous:
{
  "type": "clarification",
  "question": "Single clear question to the user"
}

3. Deliver the corrected SQL once you are confident about the problem:
{
  "type": "revised_sql",
  "reasoning": "Clear explanation: what was wrong + what you changed to fix it",
  "sql": "SELECT ...",
  "confidence": 0.95
}

━━━ DIAGNOSTIC QUERY RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- SELECT only — never INSERT, UPDATE, DELETE, DROP, etc.
- Keep queries short and targeted — one hypothesis per query
- Useful checks: COUNT(*) vs COUNT(DISTINCT key) to detect fan-out;
  DISTINCT status values; MIN/MAX of date or amount columns;
  sample rows from a suspect table; COUNT per join key to find 1-to-many issues

━━━ DUPLICATE ENTITY RULE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If a diagnostic query reveals that the same name (company, product, etc.) appears
in multiple rows with different primary keys, you MUST use the clarification action
before generating revised SQL. Show the user the distinguishing fields (id, city,
phone, VAT number, address) and ask which specific record they mean.
Never silently merge multiple records with the same name into one result.

━━━ SQL DIALECT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{{DATE_HINT}}

━━━ REVISED SQL RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Apply all SQL quality rules from the original generation
- Never aggregate from a header table when a line table exists
- Never join two un-aggregated fact tables directly
- Use CTEs (WITH blocks) for multi-step logic; name them semantically
- Double-check: does the grain of the revised query match what the question needs?
- Lower confidence proportionally to remaining uncertainty`;

/** Backward-compat: default SQLite dialect */
export const REPAIR_SYSTEM = getRepairSystem('sqlite');

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function buildRepairContext(
  question: string,
  originalSql: string,
  originalRows: Record<string, unknown>[],
  warning: string,
  semanticContext: string,
  relationshipContext: string,
): string {
  return `Original question: "${question}"

SQL that was executed:
${originalSql}

Suspicious result (first ${Math.min(originalRows.length, 10)} of ${originalRows.length} rows):
${JSON.stringify(originalRows.slice(0, 10), null, 2)}

Validation warning: "${warning}"

━━━ Schema context ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${semanticContext}

━━━ Table relationships ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${relationshipContext}

Please diagnose the problem. Start by running a diagnostic query if you need to
inspect the data, or deliver the corrected SQL if the issue is already clear.`;
}

export function buildRepairQueryResult(
  rows: Record<string, unknown>[],
  rowCount: number,
): string {
  return `Diagnostic query returned ${rowCount} rows.
First rows:
${JSON.stringify(rows.slice(0, 20), null, 2)}

Continue your investigation or provide the corrected SQL.`;
}

export function buildRepairClarificationAnswer(userAnswer: string): string {
  return `User answered: "${userAnswer}".
Now please proceed with your investigation.`;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type RepairAction =
  | { type: 'data_query';   reasoning: string; sql: string }
  | { type: 'clarification'; question: string }
  | { type: 'revised_sql';  reasoning: string; sql: string; confidence: number };
