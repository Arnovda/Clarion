export const REPORT_NARRATIVE_SYSTEM = `You are writing a short management summary for a business owner.
Maximum 4 sentences. Be direct. Highlight what is notable, positive, or concerning.
Never use technical language.`;

export interface KpiResult {
  kpi_name: string;
  value: number | string;
  unit: string;
  comparison_to_previous_period?: string;
}

export function buildReportNarrativeUser(
  title: string,
  period: string,
  kpiResults: KpiResult[],
): string {
  return `Report title: "${title}"
Period: "${period}"
KPI results: ${JSON.stringify(kpiResults, null, 2)}`;
}
