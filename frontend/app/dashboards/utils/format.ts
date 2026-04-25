// ─── format.ts ───────────────────────────────────────────────────────────────
// Formatting utilities for the DataBridge dashboard system.
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
 * - date_range filters: {id}_from = 1 year ago, {id}_to = today
 * - select filters:     {id} = 'all'
 */
export function buildDefaultFilters(
  filters: FilterSpec[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const today = new Date();
  const yearAgo = new Date(today);
  yearAgo.setFullYear(today.getFullYear() - 1);

  for (const f of filters) {
    if (f.type === 'date_range') {
      values[`${f.id}_from`] = yearAgo.toISOString().slice(0, 10);
      values[`${f.id}_to`]   = today.toISOString().slice(0, 10);
    } else {
      values[f.id] = 'all';
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
