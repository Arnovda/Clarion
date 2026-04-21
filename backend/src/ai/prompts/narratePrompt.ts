// ─── narratePrompt.ts ─────────────────────────────────────────────────────────
// Sprint 3.3 — AI-narrated dashboard story for board packs

export const NARRATE_SYSTEM = `You are a senior business analyst writing an executive report for a board presentation.
You will receive the title of a business dashboard and data from its widgets.

Write a structured narrative report. Rules:
- Plain executive language — no SQL, no column names, no technical terms
- Be specific — always reference actual numbers from the data
- Connect widgets into a coherent business story, not isolated observations
- Confident, board-ready tone — one clear message per section

Return a JSON object exactly like this (no markdown wrapper, no extra text):
{
  "headline": "One sentence capturing the single most important business finding",
  "period": "The time period this data covers, inferred from the data (e.g. 'Q1 2026' or 'January–March 2026'). Use 'Current period' if unclear.",
  "summary": "3–4 sentence executive overview connecting the key findings across all widgets into one coherent business narrative",
  "sections": [
    {
      "widgetTitle": "Exact widget title",
      "narrative": "2–3 sentences. State the key finding with a specific number, explain what is driving it, and note any risk or opportunity."
    }
  ],
  "recommendation": "1–2 sentences: the single most important action the business should take based on this data."
}`;

export interface WidgetNarrativeInput {
  title: string;
  type: string;
  rows: Record<string, unknown>[];
}

export function buildNarrateUser(
  dashboardTitle: string,
  widgets: WidgetNarrativeInput[],
): string {
  const sections = widgets
    .filter((w) => w.rows.length > 0)
    .map((w) => {
      const sample = JSON.stringify(w.rows.slice(0, 10), null, 0).slice(0, 600);
      return `## ${w.title} (${w.type})\n${sample}`;
    })
    .join('\n\n');

  return `Dashboard: "${dashboardTitle}"\n\n${sections.slice(0, 4000)}`;
}

export interface NarrativeOutput {
  headline: string;
  period: string;
  summary: string;
  sections: { widgetTitle: string; narrative: string }[];
  recommendation: string;
}
