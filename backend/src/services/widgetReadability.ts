/**
 * Widget readability gate — the check that runs AFTER the validity check.
 *
 * The /generate validation pass already proves a widget's SQL executes,
 * returns rows and returns the columns its type reads (shared/widgetContracts).
 * None of that says the chart can be READ. A pie with 40 slices, a stacked bar
 * with 19 series (the palette has 6 colours — the 7th series is drawn in the
 * 1st colour again), a KPI card whose SQL returns 200 rows, a bar chart whose
 * labels are raw timestamps, a count rendered as "€450,00": every one of those
 * executes without error and is wrong on screen. VisEval's finding, in one
 * line: readability fails even when execution passes.
 *
 * This module is DETERMINISTIC and PURE — rules over a row profile, no model,
 * no I/O — so every rule is pinned by a test and every threshold is a named
 * constant that agrees with the renderer it protects (each constant says which
 * component decided it). Two kinds of fix come out of it:
 *
 *   - `set_type` / `set_format` — a spec edit that costs no model call. A pie
 *     with 12 slices becomes a horizontal bar; a count with no `format` gets
 *     `format: 'number'` so the axis stops saying €. Applied in place by
 *     `applyReadabilityFixes`, then the widget is re-assessed against the SAME
 *     profile, because a swap can make a different rule fire (12 slices → bar
 *     → fine; 60 slices → bar → still too many → the SQL rule below).
 *   - `sql` — the query has to change (top-N + "Other", fewer series, a
 *     formatted period, an aggregate). That goes to the repair model as a
 *     `readabilityIssue` beside the existing `contractIssue`, with the exact
 *     rewrite pattern in the instruction.
 *
 * The profile is computed from EVERY row the validation execution returned
 * (bounded at PROFILE_MAX_ROWS), not the 3 sample rows the repair prompt
 * sees — distinct counts and label lengths are meaningless on a 3-row sample.
 * Values never leave this module except as counts, lengths and ONE example of
 * the longest label; the rows themselves are policy-filtered upstream.
 *
 * Keep the LIMITS in step with frontend/app/dashboards/components/
 * ChartWidgets.tsx and EChartsWidgets.tsx — each constant names its source.
 */

import type { WidgetSpec } from '../shared/contract';
import { REQUIRED_WIDGET_COLUMNS } from '../shared/widgetContracts';

type WidgetType = WidgetSpec['type'];
type WidgetFormat = NonNullable<WidgetSpec['format']>;

// ---------------------------------------------------------------------------
// Limits — every number here is the renderer's, not a taste.
// ---------------------------------------------------------------------------

export const READABILITY_LIMITS = {
  /** dashboardPrompt.ts: "pie_chart — ONLY <=3 slices"; the old inline rule in the route. */
  PIE_MAX_SLICES: 3,
  /** A slice this dominant leaves nothing to compare — the others are hairlines. */
  PIE_DOMINANT_SHARE: 0.97,
  /** BarChartWidget: height = min(n*36+48, 320) → past 15 bars each is < 18px tall. */
  BAR_MAX_CATEGORIES: 15,
  /** VerticalBarChartWidget: categorical labels on a 240px-high x-axis collide past ~8, or when long. */
  VBAR_MAX_CATEGORICAL: 8,
  VBAR_MAX_CATEGORICAL_LABEL_LEN: 12,
  /** Three years of months; beyond that a vertical bar is a picket fence and a line reads. */
  VBAR_MAX_PERIODS: 36,
  /** chart-theme.ts PALETTE.series has 6 colours; `SERIES_COLORS[i % 6]` REUSES them past that. */
  STACKED_MAX_SERIES: 6,
  STACKED_MAX_LABELS: 24,
  /** A line through one point is a dot. */
  LINE_MIN_POINTS: 2,
  /** TreemapWidget truncates tile names at 14 chars; past 20 tiles the small ones have no label at all. */
  TREEMAP_MAX_TILES: 20,
  RADAR_MIN_AXES: 3,
  RADAR_MAX_AXES: 8,
  SCATTER_MAX_POINTS: 150,
  /** EChartsWidgets BulletChartWidget: `data.rows.slice(0, 12)` — rows past 12 are silently dropped. */
  BULLET_MAX_ROWS: 12,
  /** PivotTableWidget: past ~12 columns the table scrolls sideways and the totals column is off-screen. */
  PIVOT_MAX_COLS: 12,
  PIVOT_MAX_ROWS: 60,
  DATA_TABLE_MAX_COLS: 12,
  /** Any chart: a label this long is a sentence, not a name. */
  LABEL_MAX_LEN: 40,
  /** Rows profiled per widget; the true row count is kept regardless. */
  PROFILE_MAX_ROWS: 20_000,
} as const;

// ---------------------------------------------------------------------------
// Row profile
// ---------------------------------------------------------------------------

export interface ColumnProfile {
  /** Column name as returned. */
  name: string;
  /** Lower-cased name — the contract columns are matched case-insensitively. */
  key: string;
  nonNull: number;
  distinct: number;
  maxLen: number;
  /** One example of the longest value, cut to 60 chars — for the message, never the data. */
  longest: string;
  numeric: number;
  integer: number;
  negative: number;
  /** Integers in 1900..2100 — a year, which the € heuristic would render as "€2.025,00". */
  yearLike: number;
  /** Date instances or 'YYYY-MM-DDT…' strings — raw timestamps on an axis. */
  isoTimestamp: number;
  /** Values that read as a period: 2025, 2025-01, 2025-01-31, 2025-Q1, Jan 2025, W12, … */
  period: number;
  min: number | null;
  max: number | null;
  sum: number;
  /** Order of the numeric values in row order — a ranking must be 'desc' (or 'asc' for a bottom-N). */
  monotonic: 'asc' | 'desc' | 'flat' | 'none';
}

export interface RowProfile {
  /** True row count of the result. */
  rowCount: number;
  /** Rows actually profiled (<= PROFILE_MAX_ROWS). */
  scanned: number;
  columns: ColumnProfile[];
  /** Distinct (label, series) pairs when both columns exist — fewer than rows means duplicates. */
  labelSeriesPairs: number | null;
  /** Distinct (row_label, col_label) pairs when both exist. */
  pivotPairs: number | null;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const MONTH_RE = '(jan|feb|mar|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec|mrt)[a-z]*\\.?';
const PERIOD_RES: RegExp[] = [
  /^\d{4}$/,                                   // 2025
  /^\d{4}[-/.]\d{1,2}$/,                        // 2025-01
  /^\d{1,2}[-/.]\d{4}$/,                        // 01-2025
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/,            // 2025-01-31
  /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/,          // 31-01-2025
  /^\d{4}[-\s]?q[1-4]$/i,                       // 2025-Q1
  /^q[1-4]([-\s]?\d{4})?$/i,                    // Q1 2025
  /^h[12]([-\s]?\d{4})?$/i,                     // H1 2025
  /^\d{4}[-\s]?w\d{1,2}$/i,                     // 2025-W12
  /^w(eek)?\s?\d{1,2}$/i,                       // W12 / Week 12
  new RegExp(`^${MONTH_RE}([-\\s']?\\d{2,4})?$`, 'i'),  // Jan / Jan 2025 / jan-25
  new RegExp(`^\\d{4}[-\\s]${MONTH_RE}$`, 'i'),         // 2025 Jan
];

export function isPeriodLabel(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (ISO_TIMESTAMP_RE.test(t)) return true;
  return PERIOD_RES.some((re) => re.test(t));
}

function valueText(v: unknown): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function numberOf(v: unknown, text: string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && NUMERIC_RE.test(text.trim())) return Number(text);
  return null;
}

/**
 * Profile a result set. O(rows x columns), bounded at PROFILE_MAX_ROWS; the
 * distinct counts use one Set per column, which at 20k rows is a few MB at
 * worst. Handles values the way they arrive from both DuckDB paths — Date
 * instances in-process, ISO strings from the child runner's JSON hop, BigInt
 * already converted to Number.
 */
export function profileRows(rows: Array<Record<string, unknown>>): RowProfile {
  const rowCount = rows.length;
  const scanned = Math.min(rowCount, READABILITY_LIMITS.PROFILE_MAX_ROWS);
  const names = rowCount > 0 ? Object.keys(rows[0]) : [];
  const columns: ColumnProfile[] = names.map((name) => ({
    name, key: name.toLowerCase(), nonNull: 0, distinct: 0, maxLen: 0, longest: '',
    numeric: 0, integer: 0, negative: 0, yearLike: 0, isoTimestamp: 0, period: 0,
    min: null, max: null, sum: 0, monotonic: 'flat',
  }));
  const sets = names.map(() => new Set<string>());
  const prev: Array<number | null> = names.map(() => null);
  const asc = names.map(() => true);
  const desc = names.map(() => true);
  const findKey = (k: string) => columns.findIndex((col) => col.key === k);
  const labelIdx = findKey('label');
  const seriesIdx = findKey('series');
  const rowIdx = findKey('row_label');
  const colIdx = findKey('col_label');
  const pairs = labelIdx >= 0 && seriesIdx >= 0 ? new Set<string>() : null;
  const pivot = rowIdx >= 0 && colIdx >= 0 ? new Set<string>() : null;

  for (let i = 0; i < scanned; i++) {
    const row = rows[i];
    for (let j = 0; j < names.length; j++) {
      const v = row[names[j]];
      if (v === null || v === undefined || v === '') continue;
      const col = columns[j];
      const text = valueText(v);
      col.nonNull++;
      sets[j].add(text);
      if (text.length > col.maxLen) { col.maxLen = text.length; col.longest = text.slice(0, 60); }
      if (v instanceof Date || ISO_TIMESTAMP_RE.test(text)) col.isoTimestamp++;
      if (isPeriodLabel(text)) col.period++;
      const n = numberOf(v, text);
      if (n !== null) {
        col.numeric++;
        if (Number.isInteger(n)) { col.integer++; if (n >= 1900 && n <= 2100) col.yearLike++; }
        if (n < 0) col.negative++;
        col.min = col.min === null ? n : Math.min(col.min, n);
        col.max = col.max === null ? n : Math.max(col.max, n);
        col.sum += n;
        const p = prev[j];
        if (p !== null) { if (n > p) desc[j] = false; if (n < p) asc[j] = false; }
        prev[j] = n;
      }
    }
    if (pairs) pairs.add(`${valueText(row[names[labelIdx]])}|${valueText(row[names[seriesIdx]])}`);
    if (pivot) pivot.add(`${valueText(row[names[rowIdx]])}|${valueText(row[names[colIdx]])}`);
  }
  columns.forEach((col, j) => {
    col.distinct = sets[j].size;
    col.monotonic = col.numeric < 2 || (asc[j] && desc[j]) ? 'flat' : desc[j] ? 'desc' : asc[j] ? 'asc' : 'none';
  });
  return { rowCount, scanned, columns, labelSeriesPairs: pairs ? pairs.size : null, pivotPairs: pivot ? pivot.size : null };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type ReadabilityFix =
  | { kind: 'set_type'; type: WidgetType }
  | { kind: 'set_format'; format: WidgetFormat }
  | { kind: 'sql'; instruction: string };

export type ReadabilityCode =
  | 'pie_too_many_slices' | 'pie_negative' | 'pie_dominant'
  | 'too_many_categories' | 'categorical_on_vertical' | 'too_many_periods'
  | 'too_many_series' | 'too_many_labels' | 'series_on_line' | 'categorical_on_line' | 'single_point'
  | 'duplicate_labels' | 'raw_timestamps' | 'long_labels' | 'all_null'
  | 'kpi_many_rows' | 'unsorted_ranking' | 'negative_area'
  | 'too_few_axes' | 'too_many_axes' | 'too_many_points' | 'rows_dropped'
  | 'too_many_columns' | 'too_many_rows' | 'count_as_currency' | 'rate_as_currency';

export interface ReadabilityFinding {
  /** Stable code — for logs, tests and the repair rule. */
  code: ReadabilityCode;
  /** One plain sentence for the person: what cannot be read. No SQL, no jargon. */
  message: string;
  fix: ReadabilityFix;
}

const colOf = (p: RowProfile, key: string): ColumnProfile | undefined => p.columns.find((x) => x.key === key);

/** Share of non-null labels that read as a period (time axis). */
function periodShare(col: ColumnProfile): number {
  return col.nonNull === 0 ? 0 : Math.min(col.nonNull, col.period + col.yearLike) / col.nonNull;
}
/** Share of non-null labels that are neither numbers nor periods — names. */
function categoricalShare(col: ColumnProfile): number {
  if (col.nonNull === 0) return 0;
  const cat = col.nonNull - Math.max(col.period, col.numeric);
  return Math.max(0, cat) / col.nonNull;
}
const isTimeAxis = (col: ColumnProfile) => periodShare(col) >= 0.8;
const isCategorical = (col: ColumnProfile) => categoricalShare(col) >= 0.8;

const TOP_N_SQL = (n: number) =>
  `keep the top ${n} by value and fold the rest into ONE "Other" row. Pattern: ` +
  `WITH src AS (<the current query without its final ORDER BY / LIMIT>), ranked AS (SELECT label, value, ROW_NUMBER() OVER (ORDER BY value DESC) AS rn FROM src) ` +
  `SELECT label, value FROM (SELECT label, value, rn FROM ranked WHERE rn <= ${n} UNION ALL SELECT 'Other' AS label, SUM(value) AS value, ${n + 1} AS rn FROM ranked WHERE rn > ${n} HAVING COUNT(*) > 0) AS t ORDER BY rn. ` +
  `Keep every {{placeholder}} exactly as it is.`;

const TOP_N_SERIES_SQL = (n: number) =>
  `keep the ${n} largest series by total and fold the rest into ONE "Other" series. Pattern: ` +
  `WITH src AS (<the current query without its final ORDER BY / LIMIT>), totals AS (SELECT series, ROW_NUMBER() OVER (ORDER BY SUM(value) DESC) AS rn FROM src GROUP BY series) ` +
  `SELECT s.label, CASE WHEN t.rn <= ${n} THEN s.series ELSE 'Other' END AS series, SUM(s.value) AS value FROM src s JOIN totals t USING (series) GROUP BY 1, 2 ORDER BY 1, 2. ` +
  `Keep every {{placeholder}} exactly as it is.`;

const PERIOD_SQL =
  `format the period in SQL instead of returning a raw timestamp: strftime(<date column>, '%Y-%m') for months, ` +
  `strftime(<date column>, '%Y-%m-%d') for days, or CAST(<date column> AS DATE). Keep the ORDER BY chronological.`;

/** Title says count; values are whole numbers >= 100 → the € heuristic would fire. */
const COUNT_WORDS = /\b(number of|count|aantal|orders?|invoices?|facturen|customers?|klanten|units?|qty|quantity|items?|products?|headcount|employees?|medewerkers|tickets?|shipments?|deliveries|transactions?|lines?|calls?|visits?|users?|projects?)\b/i;
const MONEY_WORDS = /\b(value|revenue|amount|sales|cost|costs|spend|price|margin|profit|turnover|omzet|bedrag|kosten|waarde|budget|salary|salaris|invoice value|gmv|eur|euro)\b|€/i;
const RATE_WORDS = /(%|\bpercent(age)?\b|\bpct\b|\bratio\b|\bshare of\b|\bconversion\b|\butili[sz]ation\b|\bon-time rate\b|\bhit rate\b)/i;

/**
 * Assess ONE widget against the profile of its own rows. Pure. Returns the
 * findings in the order they should be acted on — spec fixes first, then the
 * SQL ones. Widgets whose type carries no readability rule (data_table with
 * few columns, a healthy KPI) return [].
 */
export function assessReadability(widget: WidgetSpec, p: RowProfile): ReadabilityFinding[] {
  const out: ReadabilityFinding[] = [];
  const L = READABILITY_LIMITS;
  const type = widget.type;
  if (p.rowCount === 0) return out; // zero rows is the validity pass's finding, not ours
  const label = colOf(p, 'label');
  const value = colOf(p, 'value');
  const series = colOf(p, 'series');
  const n = p.rowCount;
  const valueAllNull = !!value && value.nonNull === 0;

  // ── format: a count or a rate with no format renders as euros ─────────────
  if (!widget.format && value && value.numeric > 0) {
    if (RATE_WORDS.test(widget.title)) {
      // "%" wins over a money word in the same title: "Gross margin %" is a rate.
      out.push({ code: 'rate_as_currency', message: 'The title says this is a rate, but the values would be shown as amounts.', fix: { kind: 'set_format', format: 'percentage' } });
    } else if (!MONEY_WORDS.test(widget.title) && COUNT_WORDS.test(widget.title) && value.integer === value.numeric && (value.max ?? 0) >= 100) {
      out.push({ code: 'count_as_currency', message: 'These are counts, but without a format the chart would show them as € amounts.', fix: { kind: 'set_format', format: 'number' } });
    }
  }

  // ── kpi_card ─────────────────────────────────────────────────────────────
  if (type === 'kpi_card') {
    if (n > 1) {
      out.push({ code: 'kpi_many_rows', message: `This card's query returns ${n} rows, but a KPI shows exactly one number — only the first row is displayed.`, fix: { kind: 'sql', instruction: `Aggregate to ONE row (SUM / COUNT / AVG over the whole filtered set, or the one row the title names). The query returns ${n} rows.` } });
    } else if (valueAllNull) {
      out.push({ code: 'all_null', message: 'The value is empty.', fix: { kind: 'sql', instruction: 'The "value" column is NULL — add COALESCE(…, 0), fix the join, or pick a measure that has data.' } });
    }
    return out;
  }

  // ── data_table ───────────────────────────────────────────────────────────
  if (type === 'data_table') {
    if (p.columns.length > L.DATA_TABLE_MAX_COLS) {
      out.push({ code: 'too_many_columns', message: `${p.columns.length} columns — the table scrolls sideways and nothing can be compared at a glance.`, fix: { kind: 'sql', instruction: `Return at most ${L.DATA_TABLE_MAX_COLS} columns: keep the ones that answer the title, drop ids, technical and duplicate columns.` } });
    }
    const iso = p.columns.filter((col) => col.nonNull > 0 && col.isoTimestamp / col.nonNull >= 0.5);
    if (iso.length) {
      const names = iso.map((x) => x.name).join(', ');
      out.push({ code: 'raw_timestamps', message: `Column${iso.length > 1 ? 's' : ''} ${names} show${iso.length > 1 ? '' : 's'} raw timestamps.`, fix: { kind: 'sql', instruction: `${names}: ${PERIOD_SQL}` } });
    }
    return out;
  }

  // ── pivot_table ──────────────────────────────────────────────────────────
  if (type === 'pivot_table') {
    const col = colOf(p, 'col_label');
    const row = colOf(p, 'row_label');
    if (col && col.distinct > L.PIVOT_MAX_COLS) {
      out.push({ code: 'too_many_columns', message: `${col.distinct} columns across — the table scrolls sideways and the totals are off-screen.`, fix: { kind: 'sql', instruction: `Put the longer dimension on rows (swap row_label and col_label) or keep the top ${L.PIVOT_MAX_COLS - 2} col_label values by total and fold the rest into 'Other'.` } });
    }
    if (row && row.distinct > L.PIVOT_MAX_ROWS) {
      out.push({ code: 'too_many_rows', message: `${row.distinct} rows — too many to scan.`, fix: { kind: 'sql', instruction: `Use a coarser grain for row_label (months instead of days, groups instead of items) or keep the top ${L.PIVOT_MAX_ROWS} rows by total.` } });
    }
    return out;
  }

  // ── scatter_chart (label / x / y — no "value" column) ───────────────────
  if (type === 'scatter_chart') {
    if (n > L.SCATTER_MAX_POINTS) {
      out.push({ code: 'too_many_points', message: `${n} points — a cloud, not a pattern.`, fix: { kind: 'sql', instruction: `${n} rows for a scatter: aggregate to a coarser entity or ORDER BY y DESC LIMIT ${L.SCATTER_MAX_POINTS}.` } });
    }
    return out;
  }

  // ── every label/value chart ──────────────────────────────────────────────
  if (!label || !value) return out; // the contract check owns missing columns

  if (valueAllNull) {
    out.push({ code: 'all_null', message: 'Every value is empty — there is nothing to draw.', fix: { kind: 'sql', instruction: 'The "value" column is NULL in every row — add COALESCE(…, 0), fix the join, or pick a measure that has data.' } });
    return out;
  }

  const timeAxis = isTimeAxis(label);
  const categorical = isCategorical(label);
  const rawTimestamps = label.nonNull > 0 && label.isoTimestamp / label.nonNull >= 0.5;
  const singleSeries = !series || series.distinct <= 1;

  if (rawTimestamps) {
    out.push({ code: 'raw_timestamps', message: `The labels are raw timestamps (e.g. "${label.longest}").`, fix: { kind: 'sql', instruction: `The "label" column returns raw timestamps: ${PERIOD_SQL}` } });
  }

  if (singleSeries && type !== 'stacked_bar_chart' && label.distinct < p.scanned) {
    const dupes = p.scanned - label.distinct;
    out.push({ code: 'duplicate_labels', message: `The same label appears more than once (${dupes} duplicate${dupes > 1 ? 's' : ''} across ${n} rows) — bars for one name are split.`, fix: { kind: 'sql', instruction: `${label.distinct} distinct labels over ${n} rows: the GROUP BY is missing a column or a join fans out. Aggregate to exactly one row per label.` } });
  }

  if (label.maxLen > L.LABEL_MAX_LEN) {
    out.push({ code: 'long_labels', message: `Labels run to ${label.maxLen} characters (e.g. "${label.longest}…") and cannot fit beside the chart.`, fix: { kind: 'sql', instruction: `Use a shorter identifying column for "label" (a code or short name) — the longest label is ${label.maxLen} characters.` } });
  }

  switch (type) {
    case 'pie_chart': {
      if (value.negative > 0) {
        out.push({ code: 'pie_negative', message: 'A pie cannot show negative values.', fix: { kind: 'set_type', type: 'bar_chart' } });
      } else if (n > L.PIE_MAX_SLICES) {
        out.push({ code: 'pie_too_many_slices', message: `${n} slices — a pie is readable up to ${L.PIE_MAX_SLICES}.`, fix: { kind: 'set_type', type: 'bar_chart' } });
      } else if (n >= 2 && value.sum > 0 && (value.max ?? 0) / value.sum >= L.PIE_DOMINANT_SHARE) {
        out.push({ code: 'pie_dominant', message: 'One slice is practically the whole pie — the others are invisible.', fix: { kind: 'set_type', type: 'bar_chart' } });
      }
      break;
    }
    case 'treemap_chart': {
      if (value.negative > 0) {
        out.push({ code: 'negative_area', message: 'A treemap cannot show negative values.', fix: { kind: 'set_type', type: 'bar_chart' } });
      } else if (n > L.TREEMAP_MAX_TILES) {
        out.push({ code: 'too_many_categories', message: `${n} tiles — the small ones have no room for a name.`, fix: { kind: 'sql', instruction: `${n} rows for a treemap: ${TOP_N_SQL(L.TREEMAP_MAX_TILES - 1)}` } });
      }
      break;
    }
    case 'bar_chart':
    case 'top_list': {
      if (type === 'bar_chart' && n > L.BAR_MAX_CATEGORIES) {
        out.push({ code: 'too_many_categories', message: `${n} bars — past ${L.BAR_MAX_CATEGORIES} they are too thin to read.`, fix: { kind: 'sql', instruction: `${n} rows for a bar chart: ${TOP_N_SQL(L.BAR_MAX_CATEGORIES - 1)}` } });
      }
      if (type === 'top_list' && value.monotonic === 'none') {
        out.push({ code: 'unsorted_ranking', message: 'This is a ranking, but the rows are not in order of value.', fix: { kind: 'sql', instruction: 'A top_list must be ordered: add ORDER BY value DESC (or ASC for a bottom-N) and a LIMIT 10.' } });
      }
      break;
    }
    case 'vertical_bar_chart':
    case 'combo_chart': {
      if (timeAxis && n > L.VBAR_MAX_PERIODS) {
        out.push(type === 'vertical_bar_chart'
          ? { code: 'too_many_periods', message: `${n} periods — the bars become a picket fence; a line shows the trend.`, fix: { kind: 'set_type', type: 'line_chart' } }
          : { code: 'too_many_periods', message: `${n} periods — the bars become a picket fence.`, fix: { kind: 'sql', instruction: `${n} periods: aggregate to a coarser grain (quarters or years) so at most ${L.VBAR_MAX_PERIODS} remain.` } });
      } else if (!timeAxis && categorical && (n > L.VBAR_MAX_CATEGORICAL || label.maxLen > L.VBAR_MAX_CATEGORICAL_LABEL_LEN)) {
        out.push(type === 'vertical_bar_chart'
          ? { code: 'categorical_on_vertical', message: `${n} names along the bottom axis collide — names read better as horizontal bars.`, fix: { kind: 'set_type', type: 'bar_chart' } }
          : { code: 'categorical_on_vertical', message: `${n} names along the bottom axis collide.`, fix: { kind: 'sql', instruction: `Names on the x-axis collide: keep at most ${L.VBAR_MAX_CATEGORICAL} and use a short identifying column for "label".` } });
      }
      break;
    }
    case 'line_chart': {
      if (!singleSeries && series) {
        const fits = series.distinct <= L.STACKED_MAX_SERIES;
        out.push({ code: 'series_on_line', message: `The data has ${series.distinct} series in one column, but a line chart draws one line — they zigzag into each other.`,
          fix: fits ? { kind: 'set_type', type: 'stacked_bar_chart' } : { kind: 'sql', instruction: `${series.distinct} series on a single-line chart: either aggregate the "series" column away (one value per label) or ${TOP_N_SERIES_SQL(L.STACKED_MAX_SERIES - 1)} and change the type to stacked_bar_chart.` } });
      } else if (n < L.LINE_MIN_POINTS) {
        out.push({ code: 'single_point', message: 'One data point — a line needs a series over time.', fix: { kind: 'sql', instruction: 'Only one row: use a finer grain (months instead of years) or widen the period; if the measure is a single number, change the type to kpi_card.' } });
      } else if (!timeAxis && categorical && n <= L.BAR_MAX_CATEGORIES) {
        out.push({ code: 'categorical_on_line', message: 'A line implies order over time, but these labels are names.', fix: { kind: 'set_type', type: 'bar_chart' } });
      }
      break;
    }
    case 'stacked_bar_chart': {
      if (series && series.distinct > L.STACKED_MAX_SERIES) {
        out.push({ code: 'too_many_series', message: `${series.distinct} series — there are ${L.STACKED_MAX_SERIES} colours, so the rest repeat and cannot be told apart.`, fix: { kind: 'sql', instruction: `${series.distinct} distinct series: ${TOP_N_SERIES_SQL(L.STACKED_MAX_SERIES - 1)}` } });
      }
      if (label.distinct > L.STACKED_MAX_LABELS) {
        out.push({ code: 'too_many_labels', message: `${label.distinct} bars — too many to read the segments.`, fix: { kind: 'sql', instruction: `${label.distinct} distinct labels: use a coarser period (quarters) or keep the top ${L.STACKED_MAX_LABELS} labels.` } });
      }
      if (series && p.labelSeriesPairs !== null && p.labelSeriesPairs < p.scanned) {
        out.push({ code: 'duplicate_labels', message: 'The same label/series pair appears more than once — segments are split.', fix: { kind: 'sql', instruction: `${p.scanned - p.labelSeriesPairs} duplicate (label, series) rows: aggregate to one row per label and series.` } });
      }
      break;
    }
    case 'radar_chart': {
      if (n < L.RADAR_MIN_AXES) {
        out.push({ code: 'too_few_axes', message: `A radar needs at least ${L.RADAR_MIN_AXES} axes; this has ${n}.`, fix: { kind: 'set_type', type: 'bar_chart' } });
      } else if (n > L.RADAR_MAX_AXES) {
        out.push({ code: 'too_many_axes', message: `${n} axes — the shape cannot be read past ${L.RADAR_MAX_AXES}.`, fix: { kind: 'sql', instruction: `${n} rows for a radar: keep the ${L.RADAR_MAX_AXES} most important (ORDER BY value DESC LIMIT ${L.RADAR_MAX_AXES}).` } });
      }
      break;
    }
    case 'bullet_chart': {
      if (n > L.BULLET_MAX_ROWS) {
        out.push({ code: 'rows_dropped', message: `${n} rows, but the chart shows the first ${L.BULLET_MAX_ROWS} — the rest are silently dropped.`, fix: { kind: 'sql', instruction: `${n} rows for a bullet chart: ORDER BY value DESC LIMIT ${L.BULLET_MAX_ROWS}.` } });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying the fixes that need no model
// ---------------------------------------------------------------------------

export interface ReadabilityOutcome {
  widget: WidgetSpec;
  /** Spec-level fixes applied in place (type / format). */
  applied: ReadabilityFinding[];
  /** Findings only a SQL rewrite can settle — for the repair model. */
  remaining: ReadabilityFinding[];
}

/** The data satisfies a type's contract — a swap is safe at the DATA level, whatever the declared group. */
function profileSatisfies(p: RowProfile, type: WidgetType): boolean {
  const required = (REQUIRED_WIDGET_COLUMNS as Record<string, string[] | undefined>)[type] ?? [];
  const keys = new Set(p.columns.map((x) => x.key));
  return required.every((k) => keys.has(k));
}

/**
 * Apply every `set_type` / `set_format` finding, re-assessing after each pass
 * because a swap changes which rules apply (pie → bar → the bar count rule).
 * Bounded at 3 passes and one visit per type so two rules can never
 * ping-pong. What is left needs SQL and is returned as `remaining`.
 */
export function applyReadabilityFixes(widget: WidgetSpec, profile: RowProfile): ReadabilityOutcome {
  let current = widget;
  const applied: ReadabilityFinding[] = [];
  const seenTypes = new Set<WidgetType>([widget.type]);
  let findings = assessReadability(current, profile);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const f of findings) {
      if (f.fix.kind === 'set_format' && current.format !== f.fix.format) {
        current = { ...current, format: f.fix.format };
        applied.push(f); changed = true;
      } else if (f.fix.kind === 'set_type' && f.fix.type !== current.type && !seenTypes.has(f.fix.type) && profileSatisfies(profile, f.fix.type)) {
        current = { ...current, type: f.fix.type };
        seenTypes.add(f.fix.type);
        applied.push(f); changed = true;
      }
    }
    if (!changed) break;
    findings = assessReadability(current, profile);
  }
  const remaining = findings.filter((f) => f.fix.kind === 'sql'
    // A spec fix that could not be applied (would ping-pong, data does not fit) still needs a rewrite.
    || (f.fix.kind === 'set_type' && f.fix.type !== current.type)
    || (f.fix.kind === 'set_format' && current.format !== f.fix.format));
  return { widget: current, applied, remaining };
}

/** The sentence the repair model gets — every remaining finding with its rewrite. */
export function readabilityIssueText(findings: ReadabilityFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  return findings
    .map((f) => (f.fix.kind === 'sql' ? `${f.message} Fix: ${f.fix.instruction}` : f.message))
    .join(' ');
}

/** The sentence the card shows when a finding could not be repaired — plain, no SQL. */
export function readabilityNoteText(findings: ReadabilityFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  return findings.map((f) => f.message).join(' ');
}
