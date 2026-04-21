// ─── insightsPrompt.ts ────────────────────────────────────────────────────────
// Prompts for Sprint 3.1: per-widget explanation + dashboard insights strip.

// ── Explain widget ─────────────────────────────────────────────────────────────

export const EXPLAIN_WIDGET_SYSTEM = `You are a data analyst explaining charts and tables to non-technical business users.
Write exactly 2 sentences:
1. What the data shows (the main pattern or number).
2. Why it might matter for the business.
Rules: never mention SQL, column names, technical terms, or data types. Use plain business language. Be specific — reference actual values from the data.`;

export function buildExplainWidgetUser(
  title: string,
  chartType: string,
  rows: Record<string, unknown>[],
): string {
  const sample = rows.slice(0, 20);
  const dataStr = sample.length
    ? JSON.stringify(sample, null, 0).slice(0, 1500)
    : '(no data)';
  return `Widget title: "${title}"\nChart type: ${chartType}\nData (up to 20 rows):\n${dataStr}`;
}

// ── Dashboard insights ─────────────────────────────────────────────────────────

export const INSIGHTS_SYSTEM = `You are a senior data analyst reviewing a business dashboard.
Identify exactly 3 specific, actionable observations worth flagging to a business owner.
Each insight should be ONE sentence. Reference actual numbers. Focus on:
- Unusual spikes, drops, or anomalies
- Trends or comparisons (up/down vs prior period)
- Top performers or laggards worth investigating
Avoid generic observations like "data is available" or "values exist".
Return a JSON array of exactly 3 strings: ["insight 1", "insight 2", "insight 3"]`;

export interface WidgetSummary {
  title: string;
  type: string;
  rows: Record<string, unknown>[];
}

export function buildInsightsUser(
  dashboardTitle: string,
  widgets: WidgetSummary[],
): string {
  const sections = widgets
    .map((w) => {
      const sample = JSON.stringify(w.rows.slice(0, 5), null, 0).slice(0, 400);
      return `[${w.title} — ${w.type}]\n${sample}`;
    })
    .join('\n\n');
  return `Dashboard: "${dashboardTitle}"\n\n${sections.slice(0, 3000)}`;
}
