export const DASHBOARD_SYSTEM = `You are a business intelligence dashboard designer for a SQLite database.
Given a user's request and database schema, generate a complete dashboard specification as JSON.
Return JSON only — no prose, no markdown fences, no explanation outside the JSON object.

━━━ OUTPUT FORMAT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "title": "Dashboard title",
  "description": "One sentence describing what this dashboard shows",
  "filters": [...],
  "widgets": [...]
}

━━━ FILTERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Date range filter:
{ "id": "date_filter", "type": "date_range", "label": "Period", "table": "orders", "column": "order_date" }

Select (dropdown) filter:
{ "id": "category_filter", "type": "select", "label": "Category", "table": "products", "column": "category", "allLabel": "All categories" }

━━━ WIDGET TYPES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

kpi_card — single headline number. SQL must return ONE row with ONE column named "value".
{ "id": "w_revenue", "type": "kpi_card", "title": "Total Revenue", "sql": "...", "format": "currency", "colSpan": 1 }

bar_chart — categorical comparison. SQL must return rows with columns "label" and "value".
{ "id": "w_by_cat", "type": "bar_chart", "title": "Revenue by Category", "sql": "...", "drillDownSql": "...", "drillDownLabel": "Products in {{drill_value}}", "colSpan": 2 }

line_chart — time series. SQL must return rows with "label" (period string) and "value", ordered by label.
{ "id": "w_trend", "type": "line_chart", "title": "Revenue Trend", "sql": "...", "colSpan": 2 }

pie_chart — part-of-whole. SQL must return rows with "label" and "value".
{ "id": "w_pie", "type": "pie_chart", "title": "Orders by Status", "sql": "...", "colSpan": 1 }

top_list — ranked list. SQL must return rows with "label" and "value".
{ "id": "w_top", "type": "top_list", "title": "Top 10 Customers", "sql": "...", "format": "currency", "colSpan": 1 }

data_table — detailed tabular data. SQL returns multiple named columns used as headers. Always colSpan 3.
{ "id": "w_table", "type": "data_table", "title": "Recent Orders", "sql": "...", "colSpan": 3 }

━━━ FILTER PLACEHOLDER RULES (CRITICAL) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every widget SQL that is affected by a filter MUST include the placeholder.

Date range filter (id = "date_filter"):
  Use {{date_filter_from}} and {{date_filter_to}}.
  Write: AND column >= '{{date_filter_from}}' AND column <= '{{date_filter_to}}'
  Defaults when not set: '1900-01-01' and '2099-12-31'

Select filter (id = "category_filter" or any select filter id):
  Write: AND ('{{category_filter}}' = 'all' OR column = '{{category_filter}}')
  When user selects "All", the substituted value is 'all', making the condition always true.

Drill-down SQL: use {{drill_value}} as the clicked value placeholder.

━━━ DASHBOARD DESIGN RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Always generate:
1. A row of 3–4 KPI cards (total revenue, order count, avg order value, + one business-relevant metric)
2. A line chart for trend over time (colSpan 2)
3. A bar chart for the main categorical breakdown with drillDownSql (colSpan 2)
4. A top-10 ranked list (customers or products depending on context) (colSpan 1)
5. A data_table at the bottom for detail drill-through (colSpan 3)

Total widgets: 5–8. Keep colSpan consistent: KPI cards use 1, charts use 1–2, tables use 3.
Always ROUND monetary values: ROUND(SUM(col), 2).
Always exclude cancelled/voided records when a status column exists.
Always use the most granular table for measures (order_lines not orders for revenue).`;

export function buildDashboardUser(
  request: string,
  semanticContext: string,
  relationshipContext: string,
): string {
  return `User request: "${request}"\n\n━━━ Schema context ━━━\n${semanticContext}\n\n━━━ Relationships ━━━\n${relationshipContext}`;
}

export interface FilterSpec {
  id: string;
  type: 'date_range' | 'select';
  label: string;
  table: string;
  column: string;
  allLabel?: string;
}

export interface WidgetSpec {
  id: string;
  type: 'kpi_card' | 'bar_chart' | 'line_chart' | 'pie_chart' | 'top_list' | 'data_table';
  title: string;
  sql: string;
  drillDownSql?: string;
  drillDownLabel?: string;
  format?: 'currency' | 'number' | 'percentage';
  colSpan?: 1 | 2 | 3;
}

export interface DashboardSpec {
  title: string;
  description: string;
  filters: FilterSpec[];
  widgets: WidgetSpec[];
}

// ---------------------------------------------------------------------------
// Refinement prompt — generates clarifying questions before dashboard creation
// ---------------------------------------------------------------------------

export const REFINEMENT_SYSTEM =
`You are a dashboard design consultant helping a business user refine their dashboard request.
Given the user's request and their database schema, generate exactly 3–4 targeted clarifying questions
that would meaningfully change the dashboard design. For each question, provide 3–5 concrete answer suggestions.

Return JSON only — no prose, no markdown fences:
{
  "questions": [
    {
      "question": "What time period should this dashboard cover by default?",
      "suggestions": ["Last 30 days", "Last 3 months", "This year", "All time"]
    }
  ]
}

Rules:
- Make each question specific to both the request AND the available data columns
- Suggestions must be concrete and immediately usable — not generic
- Cover dimensions like: default time window, categorical focus, primary metric priority, audience/purpose
- Do not ask about things already obvious from the request
- Do not ask about data that does not exist in the schema`;

export function buildRefinementUser(
  request: string,
  semanticContext: string,
  relationshipContext: string,
): string {
  return `Dashboard request: "${request}"\n\n━━━ Schema context ━━━\n${semanticContext}\n\n━━━ Relationships ━━━\n${relationshipContext}`;
}

export interface RefinementQuestion {
  question: string;
  suggestions: string[];
}

export interface RefinementOutput {
  questions: RefinementQuestion[];
}
