/**
 * Dashboard edit PLANNING prompt — decide what to change, don't do it.
 *
 * The refine path used to be one enormous call: the whole spec in, the whole
 * spec out. That put the cheap decision ("this sentence means: add one
 * filter") and the expensive execution ("here are twelve rewritten SQL
 * statements") in the same request, so every edit paid for both, took a
 * minute, and let a model rewrite eleven widgets nobody asked about.
 *
 * This prompt does the cheap half only, on a Haiku call, against a DIGEST of
 * the dashboard — widget ids, titles, types, and the columns each one returns,
 * but NOT their SQL. The SQL is the bulk of the token cost and none of it is
 * needed to decide which widgets a request is about. A twelve-widget dashboard
 * digests to a few hundred tokens.
 *
 * Output is a PLAN: an ordered list of structural operations. Most of them the
 * app then executes itself with no further AI call (services/dashboardEditOps);
 * the two that genuinely need a model — rewriting one widget's SQL, writing a
 * new widget — are scoped to that one widget and run in parallel.
 *
 * The escape hatch matters as much as the plan: a request the model cannot
 * express as ops ("rebuild this as an executive summary") returns
 * `strategy: "regenerate"`, and the caller falls back to the original
 * full-spec path. Guessing at a plan for a genuinely structural request would
 * be worse than the slow path it replaced.
 */

import type { DashboardSpec } from '../../shared/contract';
import { REQUIRED_WIDGET_COLUMNS } from '../../shared/widgetContracts';

export const EDIT_PLAN_SYSTEM =
`You plan edits to an existing BI dashboard. You do NOT write SQL here and you do NOT return a dashboard.
You read the user's request and the dashboard's structure, and you return the smallest list of operations that satisfies the request.

Return JSON only — no prose, no markdown fences:
{
  "strategy": "ops" | "regenerate",
  "summary": "one short sentence, in the user's own vocabulary, saying what you are about to do",
  "ops": [ ... ]
}

Use "regenerate" ONLY when the request changes what the dashboard IS (a different subject, a different audience, "start over", "rebuild this as X"). Everything else is "ops".

Operation types — emit ONLY these shapes:

{"op":"add_filter","filter":{"id":"customer","type":"select","label":"Customer","table":"dim_customer","column":"customer_name"}}
  Adds a dashboard-level filter. The app wires it into EVERY widget itself — do NOT list widgets, and do NOT ask for SQL edits to add a filter.
  "id" must be lower_snake_case. "column" must be a real column from the schema context. For a date window use "type":"date_range".
  Optionally add "widgetIds":[...] ONLY if the filter must apply to some widgets and not others.

{"op":"remove_filter","filterId":"customer"}
{"op":"set_filter_default","filterId":"invoice_date","defaultPreset":"last_30_days"}
  Presets: last_7_days last_30_days last_90_days last_3_months last_6_months last_12_months this_year all_time
{"op":"set_filter_default","filterId":"customer","defaultValue":"ACME NV"}

{"op":"remove_widget","widgetId":"w3"}
{"op":"retitle_widget","widgetId":"w3","title":"Revenue by region"}
{"op":"set_widget_type","widgetId":"w3","widgetType":"line_chart"}
{"op":"set_widget_format","widgetId":"w1","format":"currency"}     formats: currency number percentage
{"op":"set_widget_limit","widgetId":"w4","limit":20}               top-N / row count
{"op":"retitle_dashboard","title":"...","description":"..."}       only if the change shifts what the dashboard is about

{"op":"sql_edit","widgetId":"w3","instruction":"group by month instead of quarter"}
  Use ONLY when the widget's QUERY must change: different grouping, different measure, different sort, an added breakdown.
  The instruction is read by another model that sees ONLY this widget's SQL, so write it as a complete standalone sentence.

{"op":"add_widget","instruction":"a bar chart of revenue per sales channel"}
  A brand-new widget. Describe it in one sentence.

Rules:
- Emit the FEWEST ops that satisfy the request. A widget you do not name is left byte-identical, which is the point.
- NEVER emit an op for a widget the user did not ask you to change. "Slice by customer" is ONE add_filter op, not twelve sql_edits.
- Prefer a structural op over sql_edit whenever one exists. sql_edit is the expensive path.
- Only reference widgetIds that appear in the dashboard structure below.
- Only reference tables and columns that appear in the schema context.
- Keep the total widget count between 4 and 9.
- "summary" is shown to the user while the work runs. Write it in business language — never the words SQL, widget id, spec, or star schema.`;

/** One widget as the planner sees it — no SQL. */
interface WidgetDigest {
  id: string;
  title: string;
  type: string;
  /** The result columns this type is contractually required to return. */
  returns: string[];
  /** Filter ids this widget's SQL already references. */
  filters: string[];
}

/**
 * Compact structural digest of a dashboard.
 *
 * Deliberately omits every widget's `sql`. That is 90%+ of the spec's tokens
 * and contributes nothing to "which widgets does this sentence concern?" —
 * the title and type answer that. It also keeps the planner from trying to
 * edit SQL inline, which is the behaviour this whole split exists to prevent.
 */
export function buildSpecDigest(spec: DashboardSpec): {
  title: string;
  description: string;
  filters: Array<{ id: string; type: string; label: string; column: string }>;
  widgets: WidgetDigest[];
} {
  const filterIds = spec.filters.map((f) => f.id);
  return {
    title: spec.title,
    description: spec.description,
    filters: spec.filters.map((f) => ({ id: f.id, type: f.type, label: f.label, column: f.column })),
    widgets: spec.widgets.map((w) => ({
      id: w.id,
      title: w.title,
      type: w.type,
      returns: (REQUIRED_WIDGET_COLUMNS as Record<string, string[] | undefined>)[w.type] ?? [],
      filters: filterIds.filter((id) => w.sql.includes(`{{${id}`)),
    })),
  };
}

export function buildEditPlanUser(
  refinement: string,
  spec: DashboardSpec,
  semanticContext: string,
  relationshipContext: string,
): string {
  return `User request: "${refinement}"

━━━ Dashboard structure (no SQL — you are planning, not writing queries) ━━━
${JSON.stringify(buildSpecDigest(spec))}

━━━ Schema context ━━━
${semanticContext}

━━━ Relationships ━━━
${relationshipContext}`;
}

// ---------------------------------------------------------------------------
// Scoped single-widget SQL edit
// ---------------------------------------------------------------------------

/**
 * Rewrite ONE widget's SQL against ONE instruction.
 *
 * The whole point is the blast radius: this call sees one statement and
 * returns one statement, so it cannot touch a widget it was not asked about,
 * and several of them run in parallel — the wall clock for "change three
 * charts" is one call, not three.
 */
export const WIDGET_SQL_EDIT_SYSTEM =
`You edit ONE SQL query for ONE dashboard widget. Return JSON only — no prose, no markdown fences:
{"sql":"...", "title":"...", "note":"..."}

- "sql" is the complete rewritten query. Required.
- "title" is the widget's new name — include it ONLY if the edit changes what the widget shows. Omit otherwise.
- "note" is one short business-language sentence saying what you changed. Required.

Rules:
- A single SELECT statement (a leading WITH is fine). No DDL, no multiple statements, no semicolon-separated scripts.
- The query MUST return exactly the column aliases the widget type requires — they are listed below. A missing or misnamed alias renders as a blank card, not an error, so this is the one thing you cannot get wrong.
- PRESERVE every {{placeholder}} already in the query. They are dashboard filters; dropping one silently unfilters the widget. Keep them in the same clause and the same form.
- Date-range filters appear as {{id_from}} / {{id_to}}; select filters as ('{{id}}' = 'all' OR col = '{{id}}'). Never rewrite these into literals.
- Change only what the instruction asks for. Keep the existing tables, joins and filters otherwise.
- Only reference tables and columns that appear in the schema context.`;

export function buildWidgetSqlEditUser(
  instruction: string,
  widget: { id: string; title: string; type: string; sql: string },
  requiredColumns: string[],
  semanticContext: string,
  relationshipContext: string,
): string {
  const cols = requiredColumns.length
    ? requiredColumns.map((c) => `"${c}"`).join(', ')
    : 'any named columns (this widget renders a plain table)';
  return `Instruction: "${instruction}"

Widget: "${widget.title}" (type: ${widget.type})
Required result columns: ${cols}

Current SQL:
${widget.sql}

━━━ Schema context ━━━
${semanticContext}

━━━ Relationships ━━━
${relationshipContext}`;
}

export interface WidgetSqlEditOutput {
  sql: string;
  title?: string;
  note: string;
}

export interface EditPlanOutput {
  strategy: 'ops' | 'regenerate';
  summary: string;
  ops?: unknown[];
}

// ---------------------------------------------------------------------------
// Scoped single-widget generation (the plan's add_widget op)
// ---------------------------------------------------------------------------

/**
 * Generate ONE new widget. Same blast-radius argument as the SQL edit: adding
 * a card must not be an excuse to regenerate the twelve that already exist.
 */
export const ADD_WIDGET_SYSTEM =
`You design ONE new widget for an existing BI dashboard. Return JSON only — no prose, no markdown fences:
{"widget":{"id":"...","type":"...","title":"...","sql":"...","format":"currency|number|percentage (optional)","crossFilterKey":"col (optional)"},"note":"..."}

- "id": a new lower_snake_case id not in the taken list below.
- "type": one of kpi_card, bar_chart, vertical_bar_chart, stacked_bar_chart, line_chart, pie_chart, top_list, data_table, combo_chart, radar_chart, treemap_chart, pivot_table, scatter_chart, bullet_chart.
- "note": one short business-language sentence describing the new widget.

SQL rules:
- A single SELECT statement (a leading WITH is fine).
- Return exactly the column aliases the chosen type requires:
  kpi_card: value · bar/vertical_bar/line/pie/top_list/radar/treemap/combo: label, value · stacked_bar: label, series, value · pivot_table: row_label, col_label, value · scatter: label, x, y · bullet: label, value, target · data_table: any named columns.
- Wire in the dashboard's EXISTING filters listed below, using their placeholder forms verbatim: a date_range filter as  col BETWEEN '{{id_from}}' AND '{{id_to}}'  and a select filter as  ('{{id}}' = 'all' OR col = '{{id}}') . A new widget that ignores the dashboard's filters is a bug.
- Only reference tables and columns from the schema context.`;

export function buildAddWidgetUser(
  instruction: string,
  spec: DashboardSpec,
  semanticContext: string,
  relationshipContext: string,
): string {
  const filters = spec.filters.map((f) =>
    `- id "${f.id}" (${f.type}) on ${f.table}.${f.column} — "${f.label}"`).join('\n') || '(none)';
  return `Widget to create: "${instruction}"

Dashboard title: "${spec.title}"
Taken widget ids: ${spec.widgets.map((w) => w.id).join(', ')}
Existing dashboard filters (wire ALL of them into the new widget's SQL):
${filters}

━━━ Schema context ━━━
${semanticContext}

━━━ Relationships ━━━
${relationshipContext}`;
}

export interface AddWidgetOutput {
  widget: {
    id: string;
    type: string;
    title: string;
    sql: string;
    format?: 'currency' | 'number' | 'percentage';
    crossFilterKey?: string;
  };
  note: string;
}
