// ─── format.ts ───────────────────────────────────────────────────────────────
// Formatting utilities for the Clarion dashboard system.
// Extracted from the monolith so widget components can import without
// pulling in the entire page module.

import type { FilterSpec } from '../types';

// ─── Value Formatter ──────────────────────────────────────────────────────────

/**
 * Detect the implied format from a column name.
 * Returns 'percentage' | 'currency' | 'number' | 'id' | undefined.
 */
export function inferColumnFormat(col: string): 'percentage' | 'currency' | 'number' | 'id' | undefined {
  const c = col.toLowerCase();
  if (/(_pct|_percent|_percentage|_rate|_ratio|_share|_utilization|_occupancy)$/.test(c)) return 'percentage';
  if (/percent/.test(c)) return 'percentage';
  if (/(_id|_key|_nr|_number|_code|artikelnr|customer_nr|order_nr)$/.test(c)) return 'id';
  if (/(_count|_qty|_quantity|^count$|_orders$|_items$|_units$)/.test(c)) return 'number';
  if (/(revenue|amount|cost|price|total|profit|spend|budget|salary|turnover|sales|gross|net|invoice|cogs|payable|receivable|payment|expense)/.test(c)) return 'currency';
  return undefined;
}

/**
 * Format a raw value for display in a widget cell or KPI card.
 *
 * - null / undefined  → em-dash
 * - non-numeric       → raw string
 * - format='currency' → € locale (nl-BE, 2 decimals)
 * - format='percentage' → locale number + %
 * - format='number'   → locale number, up to 2 decimals
 * - format='id'       → raw string (no thousands separators, no €)
 * - no format + |n| ≥ 100 → treated as currency (heuristic)
 */
export function formatValue(v: unknown, format?: string): string {
  if (v === null || v === undefined) return '—';

  // Identifier columns: render as plain string regardless of numeric appearance
  if (format === 'id') return String(v);

  const n = typeof v === 'number' ? v : Number(v);
  if (isNaN(n)) return String(v);

  if (
    format === 'currency' ||
    (format !== 'number' && format !== 'percentage' && Math.abs(n) >= 100)
  ) {
    return (
      '€' +
      n.toLocaleString('nl-BE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  if (format === 'percentage') {
    return n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  }

  return n.toLocaleString('nl-BE', { maximumFractionDigits: 2 });
}

// ─── Axis Formatter ───────────────────────────────────────────────────────────

/**
 * Tick formatter for a chart's value axis. Honours the widget's declared
 * `format`: a count axis must not read "€1.2k" — it did, because every chart
 * hard-coded the € above 1000 whatever the format said (the "orders shown as
 * euros" class the readability check now also catches at generation).
 * Without a format the historical heuristic stands: big numbers are money.
 */
export function yAxisFormatter(maxVal: number, format?: string): (v: number) => string {
  const big = Math.abs(maxVal) > 1000;
  const compact = (v: number) =>
    Math.abs(maxVal) > 10000 ? `${(v / 1000).toFixed(0)}k` : big ? `${(v / 1000).toFixed(1)}k` : String(v);
  if (format === 'percentage') return (v) => `${v}%`;
  if (format === 'number') return compact;
  if (format === 'currency') return (v) => `\u20AC${compact(v)}`;
  return (v) => (big ? `\u20AC${compact(v)}` : String(v));
}

// ─── Cell helpers ─────────────────────────────────────────────────────────────

/**
 * A numeric column whose every value is a whole number in 1900..2100 is a
 * year. Rendered through the money heuristic it reads "€2.025,00"; as an id
 * it reads "2025". Name-based inference cannot catch `boekjaar` or `period`
 * — the values can.
 */
export function looksLikeYearColumn(values: unknown[]): boolean {
  let seen = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1900 || n > 2100) return false;
    seen++;
  }
  return seen > 0;
}

const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A DATE that crossed the wire as '2025-01-31T00:00:00.000Z' shows as
 * '2025-01-31'; a real timestamp keeps its HH:MM. Anything that is not an
 * ISO stamp is returned untouched, so this is safe on every string cell.
 */
export function formatIsoTimestamp(s: string): string {
  const m = ISO_TS_RE.exec(s);
  if (!m) return s;
  return m[2] === '00' && m[3] === '00' ? m[1] : `${m[1]} ${m[2]}:${m[3]}`;
}

// ─── Compact Formatter ────────────────────────────────────────────────────────

/**
 * Smart compact formatting for KPI headline numbers.
 *
 * Examples:
 *   1_234_567 → "€1.23M"
 *   12_345    → "€12.3K"
 *   987       → "€987"
 */
export function formatCompact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return '€' + (v / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(v) >= 1_000)     return '€' + (v / 1_000).toFixed(1) + 'K';
  return '€' + v.toFixed(0);
}

// ─── Filter Defaults ──────────────────────────────────────────────────────────

/**
 * Build an initial filter-value map from a dashboard's FilterSpec array.
 *
 * - date_range filters: honour the spec's `defaultPreset` when the AI set one
 *   (it does so only when the user stated a time window — e.g. a refinement
 *   answer of "Last 30 days" must NOT silently become a 1-year dashboard);
 *   fall back to the app default of the last 12 months.
 * - select filters: the spec's `defaultValue` when present, else 'all'.
 */
export function buildDefaultFilters(
  filters: FilterSpec[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const today = new Date();

  // TOLERANT by design: defaultPreset is MODEL OUTPUT. The enum is only
  // enforced when structured outputs are on, so an off-list value like
  // "last_3_months" or "last_year" must map to something sensible — and an
  // unrecognisable one must fall back to the 12-month default, never crash
  // the create/open path.
  const presetFrom = (preset: string): Date => {
    const d = new Date(today);
    const p = preset.toLowerCase();
    const monthsMatch = p.match(/(\d+)[_\s-]*month/);
    const daysMatch = p.match(/(\d+)[_\s-]*day/);
    if (p.includes('all')) return new Date(1900, 0, 1);
    if (p.includes('this_year') || p.includes('year_to_date') || p === 'ytd') {
      return new Date(d.getFullYear(), 0, 1);
    }
    if (daysMatch) { d.setDate(d.getDate() - Number(daysMatch[1])); return d; }
    if (monthsMatch) { d.setMonth(d.getMonth() - Number(monthsMatch[1])); return d; }
    if (p.includes('week')) { d.setDate(d.getDate() - 7); return d; }
    // Unknown (incl. "last_year") → the app default: last 12 months.
    d.setFullYear(d.getFullYear() - 1);
    return d;
  };

  for (const f of filters) {
    if (f.type === 'date_range') {
      const from = presetFrom(typeof f.defaultPreset === 'string' ? f.defaultPreset : 'last_12_months');
      values[`${f.id}_from`] = from.toISOString().slice(0, 10);
      values[`${f.id}_to`]   = today.toISOString().slice(0, 10);
    } else {
      values[f.id] = (typeof f.defaultValue === 'string' && f.defaultValue.trim()) || 'all';
    }
  }

  return values;
}

// ─── Relative Time ────────────────────────────────────────────────────────────

/**
 * Convert an ISO timestamp to a human-readable relative string.
 *
 * Examples:  "just now", "4m ago", "2h ago", "3d ago"
 */
export function relTime(ts: string): string {
  const d  = Date.now() - new Date(ts).getTime();
  const m  = Math.floor(d / 60_000);
  const h  = Math.floor(d / 3_600_000);
  const dy = Math.floor(d / 86_400_000);

  if (m  <  1) return 'just now';
  if (m  < 60) return `${m}m ago`;
  if (h  < 24) return `${h}h ago`;
  return `${dy}d ago`;
}
