// ─── Domain reference data (extracted from dataviz skill) ──────────────────

const DOMAIN_REFERENCES: Record<string, string> = {
  finance: `
FINANCE DOMAIN — P&L, budget vs actuals, costs, margin, cashflow, expenses, variance:
Top KPI row: Revenue (vs budget + vs prior year) | Total Costs (vs budget) | Gross Margin % (vs budget) | Net Margin % | Cash Position (vs prior month)
Recommended charts:
- Revenue vs Budget: vertical_bar_chart per month — MOST IMPORTANT
- Margin trend: line_chart (gross margin % + net margin %) over time
- Variance summary: data_table (P&L lines vs budget with variance %)
Color: favorable variance = green, unfavorable = red. For cost: under budget = green, over = red.
Drill: Company → Business unit → Cost centre → GL account`,

  sales: `
SALES DOMAIN — sales revenue, customers, orders, products, reps, pipeline:
Top KPI row: Revenue (vs target + vs prior year) | Order Count (vs prior period) | Avg Order Value | Top Customer revenue
Recommended charts:
- Revenue trend: vertical_bar_chart per month — target visibility is critical
- Revenue by customer: bar_chart (horizontal sorted, top 10) with drilldown to orders
- Revenue by product/category: bar_chart (horizontal sorted) with drilldown
- Revenue mix over time: stacked_bar_chart (category per month)
Color: above target = green, near target = amber, below target = red`,

  procurement: `
PROCUREMENT DOMAIN — purchasing, suppliers, spend, POs, contracts, maverick:
Top KPI row: Total Spend (vs prior year) | Supplier Count | Avg PO Value | On-time delivery %
Recommended charts:
- Spend by category: bar_chart (horizontal sorted, largest first) with drilldown to suppliers
- Spend trend: vertical_bar_chart per month
- Top suppliers: bar_chart (horizontal sorted by spend)
- PO detail: data_table (PO#, supplier, value, date, status)
Color: on-contract = primary, maverick/off-contract = orange`,

  operations: `
OPERATIONS DOMAIN — production, OEE, downtime, throughput, quality, manufacturing:
Top KPI row: OEE % (vs 85% target) | Availability % | Performance % | Quality % | Output units (vs plan)
Recommended charts:
- Output vs Plan trend: vertical_bar_chart per day/week
- Downtime by cause: bar_chart (horizontal Pareto sorted by hours)
- Quality/defect trend: line_chart with reference line at target
- Downtime events: data_table (date, machine, cause, duration)
Color: green >= 85%, amber 65-85%, red < 65%`,

  hr: `
HR DOMAIN — headcount, employees, turnover, absenteeism, recruitment, workforce:
Top KPI row: Headcount FTE (vs plan) | New Hires (this period) | Leavers (this period) | Open Roles
Recommended charts:
- Headcount trend: line_chart (FTE per month)
- Headcount by department: bar_chart (horizontal, actual vs plan)
- Turnover trend: line_chart per month
- Employee list: data_table (name, department, start date, status)
Color: on/above plan = green, below plan = red`,

  projects: `
PROJECTS DOMAIN — project status, milestones, RAG, budget, resources, portfolio:
Top KPI row: Active Projects | On-time Rate % | Budget consumed % | High-severity Risks
Recommended charts:
- Project status: data_table (project, RAG, % complete, budget status, next milestone) — sort red first
- Budget vs actuals: bar_chart (horizontal, approved vs actual per project)
- Timeline/milestones: data_table (milestone, project, planned date, actual date, status)
Color: green = on track, amber = at risk, red = off track`,

  marketing: `
MARKETING DOMAIN — campaigns, leads, CAC, funnel, channels, conversions:
Top KPI row: Leads Generated (vs target) | Conversion Rate % | CAC | Revenue influenced
Recommended charts:
- Leads trend: stacked_bar_chart per month (stacked by channel)
- Leads by channel: bar_chart (horizontal sorted, higher is better)
- Campaign table: data_table (campaign, spend, leads, conversion %, ROI)
Color: use consistent color per channel across ALL charts`,
};

function detectDomain(request: string): string {
  const r = request.toLowerCase();
  if (/\b(revenue|sales|order|customer|product|deal|pipeline|quota|rep)\b/.test(r)) return DOMAIN_REFERENCES.sales;
  if (/\b(budget|p&l|cost|margin|cashflow|expense|variance|ebitda|profit|invoice)\b/.test(r)) return DOMAIN_REFERENCES.finance;
  if (/\b(supplier|procurement|purchase|po |purchasing|contract|maverick)\b/.test(r)) return DOMAIN_REFERENCES.procurement;
  if (/\b(oee|production|downtime|throughput|quality|defect|machine|shift|manufacturing)\b/.test(r)) return DOMAIN_REFERENCES.operations;
  if (/\b(headcount|employee|turnover|absentee|recruit|workforce|hire)\b/.test(r)) return DOMAIN_REFERENCES.hr;
  if (/\b(project|milestone|rag|portfolio|resource utiliz|gantt)\b/.test(r)) return DOMAIN_REFERENCES.projects;
  if (/\b(campaign|lead|cac|funnel|channel|conversion|marketing)\b/.test(r)) return DOMAIN_REFERENCES.marketing;
  return '';
}

// ─── Main dashboard generation prompt ───────────────────────────────────────

export const DASHBOARD_SYSTEM = `You are a senior business intelligence designer and SQL expert.
Given a user's request and database schema, generate a complete dashboard specification as JSON.
Return JSON only — no prose, no markdown fences, no explanation outside the JSON object.

━━━ OUTPUT FORMAT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "title": "Insight-driven title — state what you see, not just what data is shown",
  "description": "One sentence describing what this dashboard answers",
  "filters": [...],
  "widgets": [...]
}

━━━ CHART TYPE DECISION LOGIC ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Goal | Use | NEVER use |
|---|---|---|
| Trend over continuous time | line_chart | bar for dense time series |
| Monthly / quarterly totals to compare | vertical_bar_chart | line_chart |
| Rank categories by value | bar_chart (horizontal) | vertical bar with rotated labels |
| Composition over time | stacked_bar_chart | pie_chart |
| Part of whole (<=3 slices ONLY) | pie_chart | — |
| Part of whole (>3 slices) | bar_chart horizontal | NEVER pie_chart |
| Single KPI headline | kpi_card | — |
| Ranked list with values | top_list or bar_chart | pie_chart |
| Record-level detail | data_table | — |

NEVER use pie_chart with more than 3 data points — use bar_chart instead.
NEVER use vertical_bar_chart for ranked categories — use bar_chart (horizontal).

━━━ WIDGET TYPES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

kpi_card — headline number with optional delta. SQL must return ONE row.
  Required column: "value". Optional: "delta" (% change as number, e.g. 12.5 for +12.5%), "delta_label" (string, e.g. "vs last month").
  Always try to compute delta against prior period using a subquery.
  { "id": "w_revenue", "type": "kpi_card", "title": "Total Revenue", "sql": "SELECT ROUND(SUM(amount),2) as value, ROUND((SUM(amount) - prev.prev_val) / NULLIF(prev.prev_val,0) * 100, 1) as delta, 'vs prior month' as delta_label FROM orders, (SELECT ROUND(SUM(amount),2) as prev_val FROM orders WHERE order_date >= '{{date_filter_from}}' AND order_date <= '{{date_filter_to}}') prev WHERE order_date >= '{{date_filter_from}}' AND order_date <= '{{date_filter_to}}'", "format": "currency", "colSpan": 1 }

vertical_bar_chart — monthly/quarterly time series. SQL returns "label" (period string) and "value", ordered chronologically. Optional "target" column for a reference line.
  { "id": "w_monthly", "type": "vertical_bar_chart", "title": "Monthly Revenue — 2025 vs Prior Year", "sql": "SELECT strftime('%Y-%m', order_date) as label, ROUND(SUM(amount),2) as value FROM orders WHERE order_date >= '{{date_filter_from}}' AND order_date <= '{{date_filter_to}}' GROUP BY 1 ORDER BY 1", "format": "currency", "colSpan": 2 }

bar_chart — horizontal sorted bar for categorical ranking. SQL returns "label" and "value", sorted DESC.
  { "id": "w_customers", "type": "bar_chart", "title": "Top Customers by Revenue", "sql": "SELECT customer_name as label, ROUND(SUM(amount),2) as value FROM orders WHERE order_date >= '{{date_filter_from}}' AND order_date <= '{{date_filter_to}}' GROUP BY 1 ORDER BY 2 DESC LIMIT 10", "drillDownSql": "SELECT product as label, ROUND(SUM(amount),2) as value FROM orders WHERE customer_name = '{{drill_value}}' GROUP BY 1 ORDER BY 2 DESC", "drillDownLabel": "Orders for {{drill_value}}", "format": "currency", "colSpan": 2 }

stacked_bar_chart — composition over time or across categories. SQL returns "label", "series", "value". ORDER BY label, series.
  { "id": "w_stacked", "type": "stacked_bar_chart", "title": "Revenue Mix by Category per Month", "sql": "SELECT strftime('%Y-%m', o.order_date) as label, p.category as series, ROUND(SUM(ol.quantity * ol.unit_price),2) as value FROM order_lines ol JOIN orders o ON ol.order_id = o.id JOIN products p ON ol.product_id = p.id WHERE o.order_date >= '{{date_filter_from}}' AND o.order_date <= '{{date_filter_to}}' GROUP BY 1, 2 ORDER BY 1, 2", "format": "currency", "colSpan": 2 }

line_chart — continuous trend over time. SQL returns "label" and "value", ordered by label.
  { "id": "w_avg", "type": "line_chart", "title": "Avg Order Value Trend", "sql": "...", "colSpan": 2 }

pie_chart — ONLY <=3 slices. SQL returns "label" and "value".
  { "id": "w_status", "type": "pie_chart", "title": "Orders by Status (Active vs Fulfilled vs Cancelled)", "sql": "...", "colSpan": 1 }

top_list — ranked list. SQL returns "label" and "value".
  { "id": "w_top", "type": "top_list", "title": "Top 10 Products by Units Sold", "sql": "...", "format": "number", "colSpan": 1 }

data_table — tabular detail. SQL returns multiple named columns. Always colSpan 3.
  { "id": "w_table", "type": "data_table", "title": "Recent Orders Detail", "sql": "...", "colSpan": 3 }

━━━ FILTER PLACEHOLDER RULES (CRITICAL) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every widget SQL affected by a filter MUST include the placeholder.

Date range filter (id = "date_filter"):
  Use {{date_filter_from}} and {{date_filter_to}}.
  Write: AND column >= '{{date_filter_from}}' AND column <= '{{date_filter_to}}'

Select filter (any select filter id, e.g. "category_filter"):
  Write: AND ('{{category_filter}}' = 'all' OR column = '{{category_filter}}')

Drill-down SQL: use {{drill_value}} as the clicked value placeholder.

━━━ LAYOUT RULES — INVERTED PYRAMID ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Row 1: 3–4 kpi_card widgets (colSpan 1 each) — ALWAYS first, most important metrics
Row 2: Primary chart (the main story) — colSpan 2 + supporting metric colSpan 1
Row 3: Secondary chart — colSpan 2 + another supporting view colSpan 1
Row 4 (optional): data_table colSpan 3 — evidence and drill-through detail

Total: 6–9 widgets. KPI cards always first. data_table always last if present.
Max 3 colSpan-1 widgets per row. Charts: prefer colSpan 2.

━━━ TITLE RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write titles that state the INSIGHT, not the description:
  GOOD: "Top Customers by Revenue — Last 12 Months"
  GOOD: "Monthly Revenue vs Prior Year"
  BAD:  "Revenue by Customer"
  BAD:  "Orders Chart"

━━━ SQL RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Always ROUND monetary values: ROUND(SUM(col), 2)
- Exclude bad records: WHERE status NOT IN ('cancelled', 'voided', 'returned') when applicable
- Use the most granular table for measures (order_lines for revenue, not orders header)
- Monthly labels: strftime('%Y-%m', date_column)
- stacked_bar_chart: ORDER BY label, series — required for correct rendering
- kpi_card delta: compute inline with a subquery or CTE comparing current vs prior period
- Use NULLIF in division to avoid divide-by-zero: / NULLIF(prev_value, 0)`;

export function buildDashboardUser(
  request: string,
  semanticContext: string,
  relationshipContext: string,
): string {
  const domainRef = detectDomain(request);
  const domainSection = domainRef
    ? `\n\n━━━ Domain-specific guidance (apply these recommendations) ━━━\n${domainRef}`
    : '';
  return `User request: "${request}"${domainSection}\n\n━━━ Schema context ━━━\n${semanticContext}\n\n━━━ Relationships ━━━\n${relationshipContext}`;
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
  type: 'kpi_card' | 'bar_chart' | 'vertical_bar_chart' | 'stacked_bar_chart' | 'line_chart' | 'pie_chart' | 'top_list' | 'data_table';
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

// ---------------------------------------------------------------------------
// Spec refinement prompt — modifies an existing dashboard spec
// ---------------------------------------------------------------------------

export const REFINE_SPEC_SYSTEM =
`You are a senior BI designer editing an existing dashboard specification.
The user describes a change they want. Apply ONLY what they asked for — preserve everything else.
Return the complete updated DashboardSpec as JSON only — no prose, no markdown fences.

Rules:
- Keep all widgets and filters the user did NOT ask to change
- Apply the same SQL, layout, filter placeholder, and chart type rules as when generating from scratch
- If the user asks to "add" something, append the new widget in the correct position (KPI cards first, data_table last)
- If the user asks to "remove" something, drop that widget entirely
- If the user asks to "change" a chart type, swap the type and adjust SQL column names if needed
- If the user asks to "focus on" a different metric, replace the most relevant existing widget
- Always keep the total widget count between 4 and 9
- Update the dashboard title if the change meaningfully shifts the dashboard's purpose`;

export function buildRefineSpecUser(
  refinement: string,
  currentSpec: DashboardSpec,
  semanticContext: string,
  relationshipContext: string,
): string {
  return `Refinement request: "${refinement}"

Current dashboard spec:
${JSON.stringify(currentSpec, null, 2)}

━━━ Schema context ━━━
${semanticContext}

━━━ Relationships ━━━
${relationshipContext}`;
}
