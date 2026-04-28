/**
 * Prompt for refining an existing data product based on a natural-language
 * instruction. Returns a structured proposal of metadata-only changes that
 * can be safely applied without re-materializing the warehouse.
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
    description: string | null;
    columns: Array<{
      id:           number;
      column_name:  string;
      display_name: string | null;
      description:  string | null;
      data_type:    string | null;
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
  summary:   string;
  changes:   RefineChange[];
  reasoning: string;
}

export const REFINE_PRODUCT_SYSTEM = `You are a data product editor. The user describes a change they'd like to make to an existing data product (a star schema with tables, columns, and KPIs). Your job is to produce a structured PROPOSAL of safe metadata edits that can be applied with one click.

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

If the user asks for something you cannot express as a metadata edit (e.g. "add a region column", "drop the customer table", "change the join condition"), emit a single \`note\` change explaining what they need to do manually (e.g. "This requires re-running the schema designer — go to the product page and re-prepare the data."). Do NOT silently skip the request.

# Style

- Be specific. If the user says "fix the customer description", use the actual column you'd change and a concrete new value.
- For new KPIs, write proper DuckDB SQL in formula_sql (e.g. \`SUM(amount)\` — not \`{measure}\` placeholders).
- Don't propose changes that aren't supported by the current schema (don't reference tables/columns that don't exist).
- Be concise in summary — one sentence explaining what the proposal does.

# Output format — strict JSON

Return ONLY this JSON. No markdown, no commentary, no leading text.

{
  "summary": "string — one-line description of the proposal",
  "changes": [ {...}, {...} ],
  "reasoning": "string — 1-3 sentences explaining your reasoning for these specific edits"
}

If you cannot find anything to change (the product looks correct given the instruction), return:

{
  "summary": "No changes needed.",
  "changes": [],
  "reasoning": "Explanation of why nothing should change."
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

function formatProduct(p: ProductSummary): string {
  const lines: string[] = [];
  lines.push(`Product: ${p.name} (id=${p.id})`);
  if (p.description) lines.push(`Description: ${p.description}`);
  lines.push('');

  lines.push('## Tables');
  for (const t of p.tables) {
    lines.push(`- table_id=${t.id} ${t.table_name}${t.description ? ` — ${t.description}` : ''}`);
    for (const c of t.columns) {
      const display = c.display_name ? ` "${c.display_name}"` : '';
      const desc = c.description ? ` — ${c.description}` : '';
      lines.push(`    - column_id=${c.id} ${c.column_name}${display} (${c.data_type ?? 'unknown'})${desc}`);
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
