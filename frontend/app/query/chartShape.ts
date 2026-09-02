/**
 * Chart shape resolution for an Ask AI answer — pure, no React.
 *
 * The question this module answers: given the result rows and the model's
 * (optional, fallible) visualization hint, WHICH columns are the x-axis, the
 * value, and the series — and therefore what chart, if any, is honest.
 *
 * Why it exists: a "cumulative per supplier" answer arrives in LONG format —
 * one row per (month, supplier) — and was drawn as a single line walking the
 * rows in order, with supplier names as the x-axis: a zigzag that means
 * nothing. Two things went wrong at once. The model's hint named the supplier
 * as x (the prompt told it "the name column becomes the chart label"), and
 * the renderer only knew how to pivot for stacked bars. So the renderer now
 * resolves the shape itself — the hint is a strong suggestion, never trusted
 * past what the data supports.
 *
 * Rules, in the order they apply:
 *   1. A SERIES column is the hint's groupBy when it names a real column;
 *      otherwise the one other categorical column with a small number of
 *      distinct values. "One" is deliberate: two candidates is ambiguous, and
 *      an ambiguous chart is worse than a table.
 *   2. If a series exists and x is the LOW-cardinality category while another
 *      column is period-like, swap: time goes on the x-axis, the category
 *      becomes the series. This is the production failure, inverted.
 *   3. More than MAX_SERIES groups → no series chart. The palette is a fixed,
 *      ordered set; a 9th hue is never generated and never wrapped around.
 *   4. Long-format rows with a series are pivoted to wide (one row per x, one
 *      column per group), sorted by x when x is period-like.
 */

import type { VisualizationHint, VisualizationType } from './types';
export type { VisualizationHint, VisualizationType };

export interface ChartShape {
  columns: string[];
  numericCols: string[];
  xKey?: string;
  yKey?: string;
  /** Present when the rows carry one row per (x, category) and a series chart is honest. */
  seriesKey?: string;
  /** Distinct series values in first-seen order — the palette is assigned by this index, fixed. */
  groups: string[];
  /** Rows to hand the chart: pivoted wide when a series exists, the input rows otherwise. */
  data: Record<string, unknown>[];
  /** Initial chart type. */
  type: VisualizationType;
  xIsPeriod: boolean;
}

/** The series-count ceiling. Past it the tail is not "Other"-folded here — the answer falls back to a table. */
export const MAX_SERIES = 8;
/** Above this, a single-series result is a table by default (a hint may still ask for a chart). */
const MAX_ROWS_FOR_DEFAULT_CHART = 60;
/** A category column qualifies as a series only with this few distinct values or fewer. */
const MAX_CATEGORY_CARDINALITY = MAX_SERIES;

const PERIOD_NAME = /(date|day|week|month|quarter|year|period|when)$|^(date|day|week|month|quarter|year|period)/i;
const ISO_PERIOD = /^\d{4}(-\d{2}(-\d{2})?)?(T|\s|$)/;

export function isNumericColumn(rows: Record<string, unknown>[], col: string): boolean {
  return rows.some((r) => r[col] !== null && r[col] !== undefined) &&
    rows.every((r) =>
      r[col] === null || r[col] === undefined ||
      typeof r[col] === 'number' ||
      (typeof r[col] === 'string' && !isNaN(Number(r[col])) && (r[col] as string) !== ''),
    );
}

/** A column is period-like by name, or when most of its values read as ISO dates / months. */
export function isPeriodColumn(rows: Record<string, unknown>[], col: string): boolean {
  if (PERIOD_NAME.test(col)) return true;
  const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return false;
  const iso = vals.filter((v) => typeof v === 'string' && ISO_PERIOD.test(v)).length;
  return iso / vals.length >= 0.6;
}

function distinct(rows: Record<string, unknown>[], col: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const v = String(r[col] ?? '');
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** Copied from the renderer's long-standing heuristics so behaviour without a hint is unchanged. */
function pickLabelColumn(columns: string[], numericCols: string[]): string | undefined {
  const nonNumeric = columns.filter((c) => !numericCols.includes(c));
  if (nonNumeric.length === 0) return undefined;
  const lower = (s: string) => s.toLowerCase();
  const isCode = (s: string) => /(_id|_key|_nr|_number|_code|artikelnr|^id$|^key$|^code$|^nr$)$/.test(lower(s));
  const isNameLike = (s: string) =>
    /(^name$|^label$|^title$|^description$|_name$|_title$|_label$|_description$|product_name|customer_name|supplier_name|category_name|employee_name)/.test(lower(s));
  return nonNumeric.find(isNameLike) ?? nonNumeric.find((c) => !isCode(c)) ?? nonNumeric[0];
}

function pickValueColumn(rows: Record<string, unknown>[], numericCols: string[]): string | undefined {
  const isPctCol = (c: string) => /(_pct|_percent|_percentage|_rate|_ratio|_share)$/i.test(c);
  const isIdCol = (c: string) => /(_id|_key|_nr|_number|_code)$/i.test(c);
  const candidates = numericCols.filter((c) => !isIdCol(c));
  const absolute = candidates.filter((c) => !isPctCol(c));
  const pool = absolute.length > 0 ? absolute : candidates;
  if (pool.length === 0) return undefined;
  return pool.reduce((best, col) => {
    const maxBest = Math.max(...rows.map((r) => Number(r[best]) || 0));
    const maxCol = Math.max(...rows.map((r) => Number(r[col]) || 0));
    return maxCol > maxBest ? col : best;
  });
}

export function resolveChartShape(rows: Record<string, unknown>[], hint?: VisualizationHint): ChartShape {
  if (!rows || rows.length === 0) {
    return { columns: [], numericCols: [], groups: [], data: [], type: 'table', xIsPeriod: false };
  }
  const columns = Object.keys(rows[0]);
  const numericCols = columns.filter((c) => isNumericColumn(rows, c));
  const has = (k?: string): k is string => !!k && columns.includes(k);

  let xKey = has(hint?.xKey) ? hint!.xKey! : pickLabelColumn(columns, numericCols);
  const yKey = has(hint?.yKey) ? hint!.yKey! : pickValueColumn(rows, numericCols);

  // Rule 1 — the series column.
  const categoryCols = columns.filter((c) => c !== xKey && c !== yKey && !numericCols.includes(c));
  let seriesKey: string | undefined;
  if (has(hint?.groupBy) && hint!.groupBy !== xKey && hint!.groupBy !== yKey) {
    seriesKey = hint!.groupBy!;
  } else {
    const small = categoryCols.filter((c) => {
      const n = distinct(rows, c).length;
      return n >= 2 && n <= MAX_CATEGORY_CARDINALITY;
    });
    if (small.length === 1) seriesKey = small[0];
  }

  // Rule 1b — the production case: the hint (or the label picker) put the
  // low-cardinality CATEGORY on x, and the only other text column is the
  // period — too wide to be a series, exactly right as the x-axis. That is
  // the series/x swap, not a dead end.
  if (!seriesKey && xKey) {
    const xCard = distinct(rows, xKey).length;
    if (xCard >= 2 && xCard <= MAX_CATEGORY_CARDINALITY && !isPeriodColumn(rows, xKey)) {
      const periods = categoryCols.filter((c) => isPeriodColumn(rows, c));
      if (periods.length === 1) { seriesKey = xKey; xKey = periods[0]; }
    }
  }

  // Rule 2 — time belongs on the x-axis; the category is the series.
  if (seriesKey && xKey) {
    const xCard = distinct(rows, xKey).length;
    const xLooksLikeCategory = xCard <= MAX_CATEGORY_CARDINALITY && !isPeriodColumn(rows, xKey);
    if (xLooksLikeCategory && isPeriodColumn(rows, seriesKey)) {
      const t = xKey; xKey = seriesKey; seriesKey = t;
    } else if (xLooksLikeCategory) {
      // Any OTHER period-like column beats a low-cardinality category as x.
      const period = columns.find((c) => c !== xKey && c !== yKey && c !== seriesKey && !numericCols.includes(c) && isPeriodColumn(rows, c));
      if (period) { seriesKey = xKey; xKey = period; }
    }
  }

  const xIsPeriod = !!xKey && isPeriodColumn(rows, xKey);
  let groups = seriesKey ? distinct(rows, seriesKey) : [];

  // Rule 3 — never more series than the palette has fixed slots for.
  if (groups.length > MAX_SERIES) { seriesKey = undefined; groups = []; }

  // Rule 4 — pivot long → wide when a series exists.
  let data: Record<string, unknown>[] = rows;
  if (seriesKey && xKey && yKey) {
    const map = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const x = String(r[xKey] ?? '');
      const g = String(r[seriesKey] ?? '');
      const acc = map.get(x) ?? { [xKey]: x };
      acc[g] = (Number(acc[g]) || 0) + (Number(r[yKey]) || 0);
      map.set(x, acc);
    }
    data = Array.from(map.values());
    if (xIsPeriod) data.sort((a, b) => String(a[xKey!]).localeCompare(String(b[xKey!])));
  }

  // Type: the hint wins when the data can honour it; otherwise the heuristic.
  const heuristic = (): VisualizationType => {
    if (!xKey || !yKey) return 'table';
    if (seriesKey) return xIsPeriod ? 'line' : 'stacked_bar';
    if (rows.length > MAX_ROWS_FOR_DEFAULT_CHART && !xIsPeriod) return 'table';
    return xIsPeriod ? 'line' : 'bar';
  };
  let type: VisualizationType = hint?.type ?? heuristic();
  if (type === 'stacked_bar' && !seriesKey) type = heuristic();
  if (type === 'pie' && (seriesKey || rows.length > 12)) type = heuristic();
  if ((type === 'line' || type === 'bar') && !seriesKey && rows.length > MAX_ROWS_FOR_DEFAULT_CHART && !xIsPeriod) type = 'table';
  if ((type === 'line' || type === 'bar' || type === 'pie') && (!xKey || !yKey)) type = 'table';

  return { columns, numericCols, xKey, yKey, seriesKey, groups, data, type, xIsPeriod };
}
