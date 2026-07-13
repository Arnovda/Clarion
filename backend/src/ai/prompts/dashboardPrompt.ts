import type { DashboardSpec } from '../../shared/contract';

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
| Two-dimension cross-tab (rows × cols) | pivot_table | data_table |

NEVER use pie_chart with more than 3 data points — use bar_chart instead.
NEVER use vertical_bar_chart for ranked categories — use bar_chart (horizontal).

━━━ WIDGET TYPES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

kpi_card — headline number with optional delta AND drill-through.
  SQL must return ONE row. Required column: "value". Optional: "delta" (% change as number, e.g. 12.5 for +12.5%), "delta_label" (string, e.g. "vs last month").
  Always compute delta against prior period using a WITH clause and INTERVAL date math.
  Always add "drillDownSql" — the detail query shown when the user clicks "View detail →". It returns the underlying records (no LIMIT) and uses the same date filter placeholders.
  { "id": "w_revenue", "type": "kpi_card", "title": "Total Revenue", "sql": "WITH curr AS (SELECT ROUND(SUM(amount),2) as val FROM orders WHERE order_date >= '{{date_filter_from}}' AND order_date <= '{{date_filter_to}}'), prev AS (SELECT ROUND(SUM(amount),2) as val FROM orders WHERE order_date >= CAST('{{date_filter_from}}' AS DATE) - INTERVAL '1 year' AND order_date <= CAST('{{date_filter_to}}' AS DATE) - INTERVAL '1 year') SELECT curr.val as value, ROUND((curr.val - prev.val) / NULLIF(prev.val,0) * 100, 1) as delta, 'vs prior year period' as delta_label FROM curr, prev", "drillDownSql": "SELECT id, customer_name, amount, order_date FROM orders WHERE order_date >= '{{date_filter_from}}' AND order_date <= '{{date_filter_to}}' ORDER BY order_date DESC LIMIT 500", "drillDownLabel": "Orders in period", "format": "currency", "colSpan": 1 }

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

top_list — ranked list. SQL returns "label" and "value". Prefer colSpan 2; use colSpan 3 if labels are long or >8 rows.
  { "id": "w_top", "type": "top_list", "title": "Top 10 Products by Units Sold", "sql": "...", "format": "number", "colSpan": 2 }

data_table — tabular detail. SQL returns multiple named columns. Always colSpan 4 (full width).
  { "id": "w_table", "type": "data_table", "title": "Recent Orders Detail", "sql": "...", "colSpan": 4 }

pivot_table — cross-tab matrix (rows × columns → values). Use when the user wants to compare a measure across TWO dimensions simultaneously (e.g. revenue by month × category, headcount by department × role). SQL MUST return exactly three columns: "row_label", "col_label", "value". Always colSpan 4 (full width). Cells are heat-mapped by intensity automatically. Row and column totals are added automatically.
  { "id": "w_pivot", "type": "pivot_table", "title": "Revenue by Month × Category", "sql": "SELECT strftime('%Y-%m', o.order_date) AS row_label, p.category AS col_label, ROUND(SUM(ol.quantity * ol.unit_price),2) AS value FROM order_lines ol JOIN orders o ON ol.order_id = o.id JOIN products p ON ol.product_id = p.id WHERE o.order_date >= '{{date_filter_from}}' AND o.order_date <= '{{date_filter_to}}' GROUP BY 1, 2 ORDER BY 1, 2", "format": "currency", "colSpan": 4 }

━━━ FILTER SPEC FORMAT (REQUIRED FIELDS) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Date range filter — use for any date/time column:
  { "id": "date_filter", "type": "date_range", "label": "Date Range", "table": "orders", "column": "order_date" }

Select filter — use for low-cardinality categorical columns (status, category, region, etc.):
  { "id": "status_filter", "type": "select", "label": "Order Status", "table": "orders", "column": "status", "allLabel": "All statuses" }

CRITICAL: Both filter types MUST include "table" and "column" — they are used to load dropdown options.
Never omit "table". Never omit "column". Never set them to null or undefined.
Use exactly the real table name and column name from the schema context provided.

━━━ PERFORMANCE — USE ROLLUP TABLES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If the schema context lists any tables whose names begin with rollup_monthly_,
ALWAYS use them instead of the raw fact table for time-series and aggregate queries.
Rollup tables are 100–1000× smaller than fact tables and already contain SUMmed measures.
They expose: month (TIMESTAMP), dimension columns, measure columns (already summed), _row_count.
NEVER wrap rollup measures in an additional SUM — they are already aggregated per month.
Use the raw fact table ONLY for record-level detail (data_table widgets showing individual rows).

━━━ FILTER PLACEHOLDER RULES (CRITICAL) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every widget SQL affected by a filter MUST include the placeholder.

Date range filter (id = "date_filter"):
  Use {{date_filter_from}} and {{date_filter_to}}.
  Write: AND column >= '{{date_filter_from}}' AND column <= '{{date_filter_to}}'

Select filter (any select filter id, e.g. "status_filter"):
  Write: AND ('{{status_filter}}' = 'all' OR column = '{{status_filter}}')

Drill-down SQL: use {{drill_value}} as the clicked value placeholder.

━━━ HUMAN-READABLE LABELS — CRITICAL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The dashboard is consumed by business users. They cannot read codes, SKUs, or surrogate keys.
Every "label" column (the chart Y-axis / X-axis / category) MUST be a human-readable name.

• ALWAYS use the human-readable name column as the label, NEVER the code column.
  - GOOD: SELECT da.naam AS label, ...           (product name)
  - GOOD: SELECT c.customer_name AS label, ...
  - BAD:  SELECT da.artikelnr AS label, ...      (article number / SKU)
  - BAD:  SELECT c.customer_id AS label, ...
• If a code is genuinely needed (e.g. user explicitly asked for "the SKU"), include it AFTER the name in a data_table — never as the chart label.
• For "row_label" / "col_label" in pivot_tables, the same rule applies: prefer names over codes.
• "crossFilterKey" still uses the underlying SQL column name (before aliasing to "label").

━━━ FORMAT FIELD — MATCH IT TO THE MEASURE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Set "format" on every non-string widget so values render correctly:
• "currency"   — revenue, cost, profit, total, spend, budget, salary, invoice value, GMV. Renders as "€1.234,56".
• "percentage" — margin %, growth %, conversion %, on-time rate, utilisation, share. Renders as "43.5%".
• "number"     — counts (orders, customers, units), durations (days), scores. Renders as "1.234".

Default heuristic when "format" is omitted: large decimals → currency. This is WRONG for percentages.
ALWAYS set format='percentage' explicitly when the value is a rate / share / margin %, otherwise users see "€43,49" instead of "43.5%".

When SQL emits both an absolute and a percentage column in a data_table or pivot, name them so the
column header is unambiguous (e.g. gross_profit + gross_margin_pct). The frontend recognises the
_pct / _percent / _rate suffix and renders those columns as percentages even inside data tables.

━━━ CROSS-FILTER RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every non-kpi_card widget MUST declare "crossFilterKey": the SQL column name used as the main grouping dimension (the label column, before aliasing).
  Example: if SQL has "SELECT customer_name as label, ..." then crossFilterKey = "customer_name"
  Example: if SQL has "SELECT product_name as label, ..." then crossFilterKey = "product_name"

All non-kpi_card widget SQLs MUST include cross-filter receive placeholders for every relevant dimension used in the dashboard.
  Pattern: AND ('{{xf_<col>}}' = 'all' OR <col_expr> = '{{xf_<col>}}')
  Example: AND ('{{xf_customer_name}}' = 'all' OR o.customer_name = '{{xf_customer_name}}')
  Example: AND ('{{xf_status}}' = 'all' OR o.status = '{{xf_status}}')

This enables clicking a customer bar to instantly cross-filter all other charts to that customer's data.

━━━ LAYOUT RULES — INVERTED PYRAMID ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Grid is 12 columns. colSpan maps: 1→3 cols (quarter), 2→6 cols (half), 3→9 cols, 4→12 cols (full).

CRITICAL: Every row MUST sum to exactly 12 columns. No gaps, no overflow.
  Valid row patterns: 1+1+1+1, 2+2, 2+1+1, 3+1, 4.
  INVALID: 2+1 (sums to 9, leaves a gap) — do not emit this.

Widget order is top-to-bottom, left-to-right. The grid auto-flows: plan widgets in rows.

Row 1: 4× kpi_card (colSpan 1 each) = 1+1+1+1 — ALWAYS first.
Row 2: Primary chart colSpan 2 + secondary chart colSpan 2 = 2+2. Use 2+2 whenever both widgets benefit from ≥6 cols (line charts, stacked bars, bar charts with >5 categories, top_list with long labels).
Row 3: EITHER another 2+2 row OR 3+1 (wide chart + small KPI/pie) OR 4 (full-width table/pivot).
Row 4 (optional): data_table OR pivot_table colSpan 4 = full width.

Widget width guidance:
  - top_list: colSpan 2 minimum (labels need room). colSpan 3 if >8 rows or long names.
  - pie_chart: colSpan 1 or 2. Never larger — pies waste space.
  - line_chart / stacked_bar_chart / combo_chart: prefer colSpan 2 or 3.
  - data_table: ALWAYS colSpan 4 (full width).
  - pivot_table: ALWAYS colSpan 4 (full width).
  - treemap_chart / radar_chart: colSpan 2 minimum.

Total: 6–9 widgets. KPI cards always first. data_table/pivot_table always last.

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
- stacked_bar_chart: ORDER BY label, series — required for correct rendering
- kpi_card delta: compute inline with a subquery or CTE comparing current vs prior period
- Use NULLIF in division to avoid divide-by-zero: / NULLIF(prev_value, 0)`;

const DASHBOARD_SQL_SQLITE = `
- Monthly labels: strftime('%Y-%m', date_column)
- Date filtering: date_column >= '2025-01-01'
- Current date: date('now')`;

const DASHBOARD_SQL_DUCKDB = `
CRITICAL — This is DuckDB, NOT PostgreSQL. These functions DO NOT EXIST in DuckDB and must NEVER be used:
  ✗ to_char()  → use strftime(date_column, '%Y-%m') instead
  ✗ to_date()  → use CAST(x AS DATE) or strptime(x, '%Y-%m-%d') instead
  ✗ EXTRACT(DOW FROM x) → use dayofweek(x)
  ✗ generate_series() for dates → use generate_series(DATE '2025-01-01', DATE '2025-12-31', INTERVAL '1 month')
  ✗ string_agg() → use list_aggr() or group_concat()
  ✗ || for string concat with non-strings → CAST both sides to VARCHAR first

DuckDB date functions:
- Monthly labels: strftime(date_column, '%Y-%m')  (NOTE: DuckDB argument order is value, format)
- Year: strftime(date_column, '%Y') or extract(year from date_column)
- Quarter: 'Q' || extract(quarter from date_column)
- Date filtering: date_column >= '2025-01-01'
- Date math: current_date - INTERVAL '3 months', date_trunc('month', date_column)
- Use ILIKE for case-insensitive text matching
- Use extract(year from date_column), extract(month from date_column)
- CRITICAL for kpi_card prior-period delta: do NOT subtract date placeholders from each other. Instead use INTERVAL:
  Current period: WHERE date_col >= '{{filter_from}}' AND date_col <= '{{filter_to}}'
  Prior year:     WHERE date_col >= CAST('{{filter_from}}' AS DATE) - INTERVAL '1 year' AND date_col <= CAST('{{filter_to}}' AS DATE) - INTERVAL '1 year'
  Prior month:    WHERE date_col >= CAST('{{filter_from}}' AS DATE) - INTERVAL '1 month' AND date_col <= CAST('{{filter_to}}' AS DATE) - INTERVAL '1 month'
  NEVER use (date - date) arithmetic with placeholders. Always use explicit INTERVAL subtraction.`;

export function getDashboardSystem(dialect: 'sqlite' | 'duckdb' = 'sqlite'): string {
  const sqlDialectRules = dialect === 'duckdb' ? DASHBOARD_SQL_DUCKDB : DASHBOARD_SQL_SQLITE;
  return DASHBOARD_SYSTEM + '\n' + sqlDialectRules;
}

export function buildDashboardUser(
  request: string,
  semanticContext: string,
  relationshipContext: string,
  glossaryContext = '',
): string {
  const domainRef = detectDomain(request);
  const domainSection = domainRef
    ? `\n\n━━━ Domain-specific guidance (apply these recommendations) ━━━\n${domainRef}`
    : '';
  const glossarySection = glossaryContext ? `\n\n${glossaryContext}` : '';
  return `User request: "${request}"${domainSection}${glossarySection}\n\n━━━ Schema context ━━━\n${semanticContext}\n\n━━━ Relationships ━━━\n${relationshipContext}`;
}

// The dashboard-spec types are part of the shared API contract (the backend
// generates + persists them, the frontend renders them). Canonical definitions
// live in shared/contract.ts; re-exported here so existing importers
// (AIService, routes/dashboards, outputSchemas) keep working unchanged.
export type { FilterSpec, WidgetSpec, DashboardSpec } from '../../shared/contract';

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
  glossaryContext = '',
): string {
  const glossarySection = glossaryContext ? `\n\n${glossaryContext}` : '';
  return `Dashboard request: "${request}"${glossarySection}\n\n━━━ Schema context ━━━\n${semanticContext}\n\n━━━ Relationships ━━━\n${relationshipContext}`;
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
- NEVER remove a widget unless the user EXPLICITLY asks to remove or delete it. "Change", "adjust", "modify", or "update" a widget means KEEP it and alter its properties — never drop it.
- Keep all widgets and filters the user did NOT mention
- If the user asks to change a chart type or layout (e.g. "grouped instead of stacked", "line instead of bar"), update the widget's type and/or SQL — do NOT replace or remove the widget
- For grouped vs stacked bar charts: use type "bar" for both. To switch between grouped and stacked, adjust the SQL to return separate columns per series (grouped) or a single stacked structure
- Apply the same SQL, layout, filter placeholder, and chart type rules as when generating from scratch
- If the user asks to "add" something, append the new widget in the correct position (KPI cards first, data_table last)
- If the user asks to "focus on" a different metric, replace the most relevant existing widget
- Always keep the total widget count between 4 and 9
- Update the dashboard title only if the change meaningfully shifts the dashboard's purpose
- CRITICAL: count the widgets in the input and count the widgets in your output. They must be equal unless the user asked to add or remove widgets.`;

export function buildRefineSpecUser(
  refinement: string,
  currentSpec: DashboardSpec,
  semanticContext: string,
  relationshipContext: string,
  glossaryContext = '',
): string {
  const glossarySection = glossaryContext ? `\n\n${glossaryContext}` : '';
  // Compact JSON (no pretty-print). Claude reads compact JSON fine and the
  // 2-space indent costs ~20% extra tokens on every refine call. The spec
  // can run 5–15K input tokens for a populated dashboard, so this is real.
  return `Refinement request: "${refinement}"${glossarySection}

Current dashboard spec:
${JSON.stringify(currentSpec)}

━━━ Schema context ━━━
${semanticContext}

━━━ Relationships ━━━
${relationshipContext}`;
}

// ---------------------------------------------------------------------------
// Validation prompt — fixes a spec based on actual query execution results
// ---------------------------------------------------------------------------

export interface WidgetExecutionResult {
  id: string;
  title: string;
  type: string;
  rowCount: number;
  error?: string;
  sampleRows: Record<string, unknown>[];
  semanticIssue?: string;
}

// ---------------------------------------------------------------------------
// Semantic alignment check — does the SQL's grouping/output match the title?
// Cheap Haiku call. Runs in parallel per widget after execution succeeds.
// ---------------------------------------------------------------------------

export const SEMANTIC_CHECK_SYSTEM =
`You are a BI quality reviewer. Given a chart's title and 3 sample rows of its data,
decide if the data clearly matches what the title promises.

Look for OBVIOUS mismatches only:
- Title says "by Product" but labels are dates/months
- Title says "Revenue" but values are counts (small integers like 1, 2, 5)
- Title says "Top Customers" but labels are product names
- Title says "Monthly" but there is only one row / labels are not dates

DO NOT flag:
- Minor wording differences
- Different aggregations that are still plausible
- Missing data (empty results — handled elsewhere)
- Anything you are unsure about — err toward "ok"

Return JSON only, no markdown:
{ "ok": true }  OR
{ "ok": false, "issue": "One short sentence explaining the mismatch." }`;

export function buildSemanticCheckUser(
  title: string,
  chartType: string,
  sampleRows: Record<string, unknown>[],
): string {
  // Compact JSON — Haiku call, but the rule applies: 3 rows × pretty-print
  // adds tokens for no benefit.
  return `Title: "${title}"
Chart type: ${chartType}
Sample rows (first 3):
${JSON.stringify(sampleRows.slice(0, 3))}

Does the data match what the title promises? Return JSON.`;
}

export const VALIDATE_DASHBOARD_SYSTEM =
`You are a senior BI engineer doing a post-generation validation pass on a dashboard spec.
You have just received execution results for every widget — actual row counts, errors, and sample data.
Your job is to fix the spec so every widget shows meaningful, correct data.
Return the complete fixed DashboardSpec as JSON only — no prose, no markdown fences.

━━━ FIX RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. SQL ERROR → Rewrite the SQL to fix the error. Common causes: wrong column name, wrong table name, invalid syntax, missing JOIN. Use only tables/columns from the schema context.

2. ZERO ROWS → Diagnose why. Either:
   a. Date filter too restrictive — relax it (widen the range or remove the date filter from this widget)
   b. Wrong table or column — rewrite SQL using the schema
   c. Filter placeholder not correctly applied — check the WHERE clause
   If you cannot fix it, replace the widget with a different metric that WILL have data.

3. PIE CHART WITH >3 ROWS → Convert type to "bar_chart" (horizontal). Keep the same SQL and format.

4. KPI CARD WITH WRONG COLUMNS → Fix SQL so it returns a "value" column (and optionally "delta", "delta_label").

5. STACKED BAR WITH MISSING "series" COLUMN → Fix SQL to return label, series, value.

6. WIDGET WITH NULL/UNDEFINED VALUES → Add COALESCE or NULLIF guards.

7. SEMANTIC MISMATCH (semanticIssue present) → Rewrite the SQL so the GROUP BY column and the returned "label" match what the title promises. Example: title says "Revenue by Product Group" but SQL groups by strftime('%Y-%m', order_date) → rewrite to GROUP BY product_group. Use the schema context to find the correct column. Keep the title unchanged.

PRESERVE: Keep all filter specs, widget order, colSpan, titles, and drillDownSql unless broken.
Only change what is broken. Do not invent new widgets or remove working widgets.`;

export function buildValidateUser(
  currentSpec: DashboardSpec,
  executionResults: WidgetExecutionResult[],
  semanticContext: string,
  relationshipContext: string,
): string {
  // Compact JSON for both the spec and the execution results. Validate is
  // the heaviest dashboard call (spec + every widget's sample rows) — pretty-
  // printing adds ~25% on a per-call basis with no information change.
  return `Dashboard spec to validate:
${JSON.stringify(currentSpec)}

━━━ Execution results ━━━
${JSON.stringify(executionResults)}

━━━ Schema context ━━━
${semanticContext}

━━━ Relationships ━━━
${relationshipContext}

Fix every widget that has an error or 0 rows. Return the corrected full DashboardSpec JSON.`;
}
