// ─── investigatePrompt.ts ─────────────────────────────────────────────────────
// Sprint 3.2 — Natural-language causal investigation ("Why did X drop?")

export const INVESTIGATE_PLAN_SYSTEM = `You are a senior data analyst investigating why a business metric looks the way it does.

You will receive:
- The widget title and SQL that produced the chart
- The current widget data (sample rows)
- A user question ("Why did Q3 revenue drop?")

Your task: design 3–5 targeted SQL queries to investigate the root cause across different dimensions (time, geography, product, customer segment, sales rep, etc.).

Rules:
- Use only the tables and columns referenced in the widget SQL (or tables clearly related to them)
- Keep queries simple and fast — LIMIT 20 rows each
- Each query should test a different hypothesis dimension
- Do NOT repeat the original widget SQL

Return a JSON object exactly like this (no markdown, no extra text):
{
  "hypothesis": "one sentence stating the most likely cause based on the data shape",
  "queries": [
    { "label": "Concise human-readable label", "sql": "SELECT ..." },
    { "label": "...", "sql": "..." }
  ]
}`;

export function buildInvestigatePlanUser(
  widgetTitle: string,
  widgetSql: string,
  widgetRows: Record<string, unknown>[],
  question: string,
): string {
  const sample = JSON.stringify(widgetRows.slice(0, 10), null, 0).slice(0, 1000);
  return `Widget: "${widgetTitle}"
Original SQL:
${widgetSql.slice(0, 800)}

Current data sample:
${sample}

User question: ${question}`;
}

export const INVESTIGATE_SYNTHESIZE_SYSTEM = `You are a senior data analyst writing a causal explanation for a non-technical business audience.

You will receive:
- The original user question
- A hypothesis
- 3–5 diagnostic query results

Write a causal explanation in 4–6 sentences:
1. Confirm or revise the hypothesis based on the data
2. Name the primary cause with specific numbers
3. Name any secondary factors if the data shows them
4. Suggest one concrete action to take

Rules: plain English only — no SQL, no column names, no technical jargon. Reference actual values from the query results.`;

export interface DiagnosticResult {
  label: string;
  rows: Record<string, unknown>[];
  error?: string;
}

export function buildInvestigateSynthesizeUser(
  question: string,
  hypothesis: string,
  results: DiagnosticResult[],
): string {
  const sections = results
    .map((r) => {
      if (r.error) return `[${r.label}]\nError: ${r.error}`;
      return `[${r.label}]\n${JSON.stringify(r.rows.slice(0, 10), null, 0).slice(0, 600)}`;
    })
    .join('\n\n');
  return `Question: ${question}\nHypothesis: ${hypothesis}\n\nDiagnostic results:\n${sections}`;
}
