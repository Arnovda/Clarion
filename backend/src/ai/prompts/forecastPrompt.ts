// ---------------------------------------------------------------------------
// Forecast Prompt — instructs Claude to detect forecast intent and generate
// the historical SQL + forecast parameters needed for time-series prediction.
// ---------------------------------------------------------------------------

export interface ForecastQueryOutput {
  type: 'forecast';
  historicalSql: string;
  dateColumn: string;
  valueColumn: string;
  groupBy?: string;
  forecastPeriods: number;
  periodUnit: 'day' | 'week' | 'month' | 'quarter' | 'year';
  confidence: number;
  explanation: string;
  tables_used: string[];
}

export const FORECAST_KEYWORDS = [
  'predict', 'forecast', 'will be', 'next quarter', 'next month', 'next year',
  'next week', 'expect', 'project', 'projection', 'trend going forward',
  'future', 'going to be', 'estimated', 'estimation', 'outlook',
  'projected', 'anticipated', 'upcoming', 'trajectory',
];

/**
 * Lightweight heuristic check — returns true if the question likely asks
 * for a prediction/forecast. Used as a gate before calling the AI.
 */
export function isForecastQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return FORECAST_KEYWORDS.some((kw) => q.includes(kw));
}

export const FORECAST_SYSTEM = (
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
  currentDate: string,
  dialect: 'sqlite' | 'duckdb',
) => {
  const dateFnHint = dialect === 'duckdb'
    ? `Use DuckDB date functions: date_trunc, date_part, interval arithmetic, CURRENT_DATE.`
    : `Use SQLite date functions: date(), strftime(), julianday(). NEVER use EXTRACT, DATE_TRUNC, etc.`;

  return `You are a forecasting assistant for a business intelligence tool.
Your job is to:
1. Understand the user's forecasting/prediction question
2. Generate SQL to fetch the HISTORICAL time-series data needed as input for a statistical forecast
3. Identify the date column, value column, and any grouping
4. Suggest how many future periods to forecast and the time unit

━━━ SCHEMA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${semanticContext}

Relationships:
${relationshipContext}

KPI formulas:
${kpiFormulas}

━━━ DATE CONTEXT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Current date: ${currentDate}
${dateFnHint}

━━━ RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. The SQL you write must fetch HISTORICAL aggregated time-series data.
   - It should return rows with a date/period column and a numeric value column.
   - Group by the appropriate time period (day/week/month/quarter/year).
   - ORDER BY the date column ascending.
   - Include enough historical data for a meaningful forecast (at least 6 periods).

2. The date column in the result should be a string in a parseable format
   (e.g., '2026-01', '2026-Q1', '2026-01-15', '2026-W03').

3. For "forecastPeriods", pick a sensible number based on the question:
   - "next quarter" = 1 quarter
   - "next 6 months" = 6 months
   - "rest of this year" = remaining months in the year
   - If unspecified, default to 3 periods of the same unit as the historical grouping.

4. For "periodUnit", match the granularity of the historical data grouping.

5. The "explanation" should be a 1-2 sentence plain-language description of
   what the forecast will show, suitable for a business user.

6. Set confidence between 0 and 1:
   - High (>0.8) when the schema clearly has the date + value columns needed
   - Medium (0.5-0.8) when you're making reasonable assumptions about columns
   - Low (<0.5) when the question is vague or the schema doesn't clearly support it

━━━ OUTPUT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return exactly this JSON shape — nothing else:
{
  "type": "forecast",
  "historicalSql": "SELECT strftime('%Y-%m', order_date) as period, SUM(total) as value FROM orders GROUP BY period ORDER BY period",
  "dateColumn": "period",
  "valueColumn": "value",
  "groupBy": null,
  "forecastPeriods": 3,
  "periodUnit": "month",
  "confidence": 0.85,
  "explanation": "Based on your monthly revenue trend, here is the projected revenue for the next 3 months.",
  "tables_used": ["orders"]
}`;
};

export function buildForecastUser(question: string): string {
  return `Question: "${question}"`;
}
