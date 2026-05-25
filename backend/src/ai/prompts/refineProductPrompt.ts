/**
 * Prompt for refining data products based on a natural-language instruction.
 * Supports both single-product and cross-product (all products) mode.
 *
 * The AI thinks in Kimball dimensional modeling principles: star schemas,
 * conformed dimensions, grain, facts vs dimensions, business keys, etc.
 *
 * Supported change types (v1 — safe metadata edits):
 *   - update_table_description
 *   - update_column_description
 *   - update_column_display_name
 *   - update_kpi_description
 *   - update_kpi_formula        (formula_sql)
 *   - update_kpi_plain_text     (formula_plain_text)
 *   - add_kpi
 *   - note                      (free-text — for changes the model can't apply automatically)
 */

export interface ProductSummary {
  id:          number;
  name:        string;
  description: string | null;
  tables: Array<{
    id:          number;
    table_name:  string;
    table_role:  string | null;
    description: string | null;
    columns: Array<{
      id:           number;
      column_name:  string;
      display_name: string | null;
      description:  string | null;
      data_type:    string | null;
      column_role:  string | null;
    }>;
  }>;
  kpis: Array<{
    id:                  number;
    name:                string;
    description:         string | null;
    formula_plain_text:  string | null;
    formula_sql:         string | null;
  }>;
}

export type RefineChange =
  | { op: 'update_table_description';   table_id: number;  old_value: string | null; new_value: string }
  | { op: 'update_column_description';  column_id: number; old_value: string | null; new_value: string }
  | { op: 'update_column_display_name'; column_id: number; old_value: string | null; new_value: string }
  | { op: 'update_kpi_description';     kpi_id: number;    old_value: string | null; new_value: string }
  | { op: 'update_kpi_formula';         kpi_id: number;    old_value: string | null; new_value: string }
  | { op: 'update_kpi_plain_text';      kpi_id: number;    old_value: string | null; new_value: string }
  | { op: 'add_kpi'; name: string; description: string; formula_plain_text: string; formula_sql: string }
  | { op: 'note'; message: string };

export interface RefineProposal {
  target_product_id?: number;
  target_product_name?: string;
  summary:   string;
  changes:   RefineChange[];
  reasoning: string;
}

const KIMBALL_PREAMBLE = `You are a Kimball dimensional modeling expert and data product editor. You think in terms of star schemas: fact tables (transactional grain, measures, foreign keys to dimensions), dimension tables (descriptive attributes, business keys, slowly changing attributes), conformed dimensions (shared across facts), and business-meaningful KPIs.

When the user asks about filtering, slicing, or grouping data — think about which DIMENSION provides that capability and whether the fact table's grain supports the analysis. When they ask about metrics or totals — think about which FACT table holds the measures and what KPIs would express the business question.`;

export const REFINE_PRODUCT_SYSTEM = `${KIMBALL_PREAMBLE}

The user describes a change they'd like to make to an existing data product (a Kimball star schema with fact tables, dimension tables, and KPIs). Your job is to produce a structured PROPOSAL of safe metadata edits that can be applied with one click.

# Allowed change ops (METADATA ONLY)

You may ONLY emit these ops. Never propose schema changes (add/drop column, add/drop table) — those are out of scope.

- update_table_description       { op, table_id, old_value, new_value }
- update_column_description      { op, column_id, old_value, new_value }
- update_column_display_name     { op, column_id, old_value, new_value }
- update_kpi_description         { op, kpi_id, old_value, new_value }
- update_kpi_formula             { op, kpi_id, old_value, new_value }   -- formula_sql
- update_kpi_plain_text          { op, kpi_id, old_value, new_value }   -- formula_plain_text
- add_kpi                        { op, name, description, formula_plain_text, formula_sql }
- note                           { op, message }                         -- for things you can't do

# When to use 'note'

If the user asks for something you cannot express as a metadata edit — e.g. adding a column, adding a dimension table, changing a join, adding a filter to the transformation SQL — emit a \`note\` change with a Kimball-informed explanation of WHAT needs to change and WHY, so the user understands the dimensional modeling rationale. Examples:
- "To filter bank transactions by bank, the Finance product needs a dim_bank dimension table with the bank name as an attribute. Re-run 'Prepare my data' on the Finance product and ask it to add a bank dimension derived from the BankAccounts source table."
- "This requires adding a degenerate dimension column (order_number) to the fact table. Re-prepare the Sales product and include order_number as a degenerate dimension on fact_sales."

Do NOT silently skip the request. Always explain the Kimball reasoning.

# Style

- Be specific. If the user says "fix the customer description", use the actual column you'd change and a concrete new value.
- For new KPIs, write proper DuckDB SQL in formula_sql (e.g. \`SUM(amount)\` — not \`{measure}\` placeholders). Reference the actual fact table and dimension joins from the schema.
- Don't propose changes that aren't supported by the current schema (don't reference tables/columns that don't exist).
- Be concise in summary — one sentence explaining what the proposal does.
- Use Kimball terminology naturally: grain, conformed dimension, degenerate dimension, measure, business key, surrogate key, slowly changing, etc.

# Output format — strict JSON

Return ONLY this JSON. No markdown, no commentary, no leading text.

{
  "summary": "string — one-line description of the proposal",
  "changes": [ {...}, {...} ],
  "reasoning": "string — 1-3 sentences explaining your reasoning using Kimball dimensional modeling concepts"
}

If you cannot find anything to change (the product looks correct given the instruction), return:

{
  "summary": "No changes needed.",
  "changes": [],
  "reasoning": "Explanation of why nothing should change."
}`;

export const REFINE_CROSS_PRODUCT_SYSTEM = `${KIMBALL_PREAMBLE}

The user has MULTIPLE data products (each a Kimball star schema). They are asking a question or requesting a change WITHOUT specifying which product. Your job is to:

1. Determine which product(s) the request applies to based on the table names, column names, measures, and business domain of each product.
2. Produce a structured PROPOSAL of safe metadata edits targeting the correct product.

# Allowed change ops (METADATA ONLY)

You may ONLY emit these ops. Never propose schema changes (add/drop column, add/drop table) — those are out of scope.

- update_table_description       { op, table_id, old_value, new_value }
- update_column_description      { op, column_id, old_value, new_value }
- update_column_display_name     { op, column_id, old_value, new_value }
- update_kpi_description         { op, kpi_id, old_value, new_value }
- update_kpi_formula             { op, kpi_id, old_value, new_value }   -- formula_sql
- update_kpi_plain_text          { op, kpi_id, old_value, new_value }   -- formula_plain_text
- add_kpi                        { op, name, description, formula_plain_text, formula_sql }
- note                           { op, message }                         -- for things you can't do

# When to use 'note'

If the user asks for something you cannot express as a metadata edit — e.g. adding a column, adding a dimension table, changing a join, adding a filter to the transformation SQL — emit a \`note\` change with a Kimball-informed explanation naming the SPECIFIC product and WHAT needs to change. Examples:
- "To filter bank transactions by bank, the Finance product needs a dim_bank dimension table. Re-run 'Prepare my data' on the Finance product and ask it to add a bank dimension from the BankAccounts source table."
- "The Sales product's fact_sales table doesn't include order_number. Re-prepare Sales and add it as a degenerate dimension."

Do NOT silently skip the request. Always explain the Kimball reasoning.

# Style

- Be specific with table/column IDs from the schemas below.
- For new KPIs, write proper DuckDB SQL referencing the actual schema.
- Be concise in summary — one sentence.
- Use Kimball terminology naturally.

# Output format — strict JSON

Return ONLY this JSON. No markdown, no commentary, no leading text.

{
  "target_product_id": <number — the id of the product this proposal targets>,
  "target_product_name": "<string — the name of the product>",
  "summary": "string — one-line description of the proposal",
  "changes": [ {...}, {...} ],
  "reasoning": "string — 1-3 sentences explaining your reasoning using Kimball dimensional modeling concepts"
}

If the request is ambiguous and could apply to multiple products, set target_product_id to the most likely one and explain in reasoning why you chose it and what the alternatives are.

If you cannot find anything to change, return:

{
  "target_product_id": <most relevant product id>,
  "target_product_name": "<name>",
  "summary": "No changes needed.",
  "changes": [],
  "reasoning": "Explanation."
}`;

export function buildRefineProductUser(
  product: ProductSummary,
  instruction: string,
): string {
  return `# Current product

${formatProduct(product)}

# User's instruction

"${instruction}"

Return the JSON proposal.`;
}

export function buildRefineCrossProductUser(
  products: ProductSummary[],
  instruction: string,
): string {
  const sections = products.map((p) => formatProduct(p)).join('\n\n---\n\n');
  return `# All data products (${products.length} total)

${sections}

# User's instruction

"${instruction}"

Determine which product this targets and return the JSON proposal.`;
}

function formatProduct(p: ProductSummary): string {
  const lines: string[] = [];
  lines.push(`Product: ${p.name} (id=${p.id})`);
  if (p.description) lines.push(`Description: ${p.description}`);
  lines.push('');

  lines.push('## Tables');
  for (const t of p.tables) {
    const role = t.table_role ? ` [${t.table_role}]` : '';
    lines.push(`- table_id=${t.id} ${t.table_name}${role}${t.description ? ` — ${t.description}` : ''}`);
    for (const c of t.columns) {
      const display = c.display_name ? ` "${c.display_name}"` : '';
      const desc = c.description ? ` — ${c.description}` : '';
      const cRole = c.column_role ? ` [${c.column_role}]` : '';
      lines.push(`    - column_id=${c.id} ${c.column_name}${display} (${c.data_type ?? 'unknown'})${cRole}${desc}`);
    }
  }

  lines.push('');
  lines.push('## KPIs');
  if (p.kpis.length === 0) {
    lines.push('(none)');
  } else {
    for (const k of p.kpis) {
      lines.push(`- kpi_id=${k.id} ${k.name}${k.description ? ` — ${k.description}` : ''}`);
      if (k.formula_plain_text) lines.push(`    plain: ${k.formula_plain_text}`);
      if (k.formula_sql) lines.push(`    sql:   ${k.formula_sql}`);
    }
  }

  return lines.join('\n');
}
