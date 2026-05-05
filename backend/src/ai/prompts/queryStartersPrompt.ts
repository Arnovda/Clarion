/**
 * Query Starters prompt — given a tenant's products + KPIs + dimensions,
 * propose 5-8 starter questions a typical business user might ask.
 *
 * The output replaces the hardcoded STARTERS list on the /query empty
 * state. Caches per-tenant for 24h so the AI cost is bounded.
 *
 * Design constraints:
 *   - Each question must be answerable from the provided schema.
 *     No "what's our churn rate" if there's no churn-related table.
 *   - Mix of "what" (state) and "why" (cause). The latter are good
 *     entry points to the Investigate feature.
 *   - Business voice; no SQL terms.
 *   - One sentence each. ≤ 80 chars per question.
 */

export interface QueryStartersContext {
  tenantName: string | null;
  products: Array<{
    productName: string;
    productDescription: string | null;
    kpis: Array<{ name: string; description: string | null }>;
    factTables: Array<{
      tableName: string;
      dimensions: string[];          // dimension column names
    }>;
  }>;
}

export interface QueryStarter {
  question: string;
  /** Short tag the UI can render — "trend", "compare", "rank", "why". */
  kind: 'trend' | 'compare' | 'rank' | 'why' | 'state';
}

export interface QueryStartersResult {
  starters: QueryStarter[];
}

export const QUERY_STARTERS_SYSTEM = `You propose 5-8 starter questions a business user could ask of a Clarion data product. Output ONLY valid JSON:

{
  "starters": [
    { "question": "<single sentence, ≤80 chars, business voice>",
      "kind": "trend" | "compare" | "rank" | "why" | "state" }
  ]
}

Hard rules:
- Each question must be answerable from PRODUCTS + KPIS + DIMENSIONS.
  Don't ask about a metric or dimension that isn't listed.
- Mix the kinds. A good starter set has 1-2 of each:
    trend    "How has gross margin moved over the last 6 months?"
    compare  "How does Beverages compare to Cleaning this quarter?"
    rank     "Which suppliers raised prices most this year?"
    why      "Why did margin drop last month?"
    state    "What was our gross margin last week?"
- Use the user's actual KPI + product names ("gross margin", not "the
  gross_margin metric"). Lowercase first word of each question.
- ≤ 80 chars per question. Punchy.
- 'why' questions are gold — they're the entry to the Investigate
  feature. Include at least one if the schema supports it.`;

export function buildQueryStartersUser(ctx: QueryStartersContext): string {
  if (ctx.products.length === 0) {
    return 'PRODUCTS: (none yet)\n\nReturn an empty starters array.';
  }

  const productLines = ctx.products.map((p) => {
    const kpis = p.kpis.length > 0
      ? '\n    KPIs: ' + p.kpis.map((k) => k.description ? `${k.name} (${k.description})` : k.name).join('; ')
      : '';
    const facts = p.factTables.length > 0
      ? '\n    Fact tables: ' + p.factTables.map((f) =>
          `${f.tableName}${f.dimensions.length ? ` [by ${f.dimensions.slice(0, 4).join(', ')}]` : ''}`,
        ).join('; ')
      : '';
    const desc = p.productDescription ? `\n    "${p.productDescription}"` : '';
    return `  ${p.productName}${desc}${kpis}${facts}`;
  }).join('\n\n');

  return [
    `TENANT: ${ctx.tenantName ?? 'this organisation'}`,
    '',
    'PRODUCTS:',
    productLines,
    '',
    'Propose 5-8 starter questions. Return JSON only.',
  ].join('\n');
}
