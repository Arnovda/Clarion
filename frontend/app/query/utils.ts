/**
 * Pure helpers extracted from page.tsx — no React, no hooks, no state.
 */

import { format as sqlFormat } from 'sql-formatter';

/** Pretty-print SQL using sql-formatter (DuckDB dialect). Falls back to raw on error. */
export function formatSql(raw: string): string {
  if (!raw) return '';
  try {
    return sqlFormat(raw, {
      language: 'duckdb',
      keywordCase: 'upper',
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
  } catch {
    return raw;
  }
}

/**
 * Detect the numeric format implied by a column name.
 *  - percentage: ends in _pct, _percent, _percentage, _rate, _ratio, _share, _utilization, _occupancy, _margin (when also _pct/_percent), or contains "percent"
 *  - currency:   contains revenue, amount, cost, price, total, profit, spend, budget, salary, value (excl. _key/_id), turnover, sales (when numeric), gross/net (when numeric), invoice
 *  - count:      ends in _count, _qty, _quantity, starts with "num_" or "n_", or named "count", "orders", "items"
 *  - id:         ends in `id`/`key`/`nr`/`number`/`code` (with OR without an underscore
 *                separator) → render as plain string, never as money.
 *                This is the firewall preventing "INVOICENUMBER" (no underscore) from
 *                being formatted as currency just because "invoice" appears in the name.
 *                Order matters: ID check runs BEFORE currency check so the keyword-based
 *                currency rule can't override an identifier-shaped column name.
 */
function classifyColumn(col: string): 'percentage' | 'currency' | 'count' | 'id' | 'unknown' {
  const c = col.toLowerCase();
  if (/(_pct|_percent|_percentage|_rate|_ratio|_share|_utilization|_occupancy)$/.test(c)) return 'percentage';
  if (/percent/.test(c)) return 'percentage';
  // Match identifier suffixes regardless of whether there's an underscore
  // separator. "INVOICENUMBER", "invoice_number", "invoicelineid" all
  // classify as id. The currency check below would otherwise catch
  // "invoicenumber" via the "invoice" keyword — that's the bug this
  // matches against.
  if (/(id|key|nr|number|code|guid|uuid)$/.test(c)) return 'id';
  if (/(artikelnr|customer_nr|order_nr)$/.test(c)) return 'id';
  if (/(_count|_qty|_quantity|n_|^num_|^count$|^orders$|^items$|_orders$|_items$)/.test(c)) return 'count';
  if (/(revenue|amount|cost|price|total|profit|spend|budget|salary|turnover|sales|gross|net|invoice|margin|cogs|payable|receivable|payment|expense)/.test(c)) return 'currency';
  return 'unknown';
}

/**
 * Format a query-result cell value.
 * When `column` is provided, formatting is column-aware:
 *   - *_pct / *_rate / *_share / etc. → "12.5%"
 *   - *_id / *_key / *_nr / *_code   → raw string (no thousands separators, no €)
 *   - revenue / cost / total / …      → "€1.234,56"
 *   - count-like                      → integer with thousands separators
 *   - otherwise (legacy)              → heuristic: decimal numbers ≥10 → currency
 */
export function formatCellValue(v: unknown, column?: string): string {
  if (v === null || v === undefined) return '—';

  const kind = column ? classifyColumn(column) : 'unknown';

  // Identifier-like columns: never coerce to currency, even if numeric.
  if (kind === 'id') return String(v);

  if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)))) {
    const n = Number(v);

    if (kind === 'percentage') {
      return `${n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    }
    if (kind === 'currency') {
      return `\u20AC${n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (kind === 'count') {
      return n.toLocaleString('nl-BE', { maximumFractionDigits: 0 });
    }
    // Fallback heuristic: decimals ≥10 look like money
    if (Math.abs(n) >= 10 && String(v).includes('.'))
      return `\u20AC${n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return n.toLocaleString('nl-BE', { maximumFractionDigits: 2 });
  }
  return String(v);
}

/**
 * Pick the best "label" column for a chart from a row's column list.
 * Prefers human-readable name columns over codes/ids when both are present.
 *
 * Priority:
 *   1. exact "name" / "label" / "title" / "description" / "product_name" / "customer_name"
 *   2. ends in _name / _title / _label / _description
 *   3. anything that doesn't look like a code/id
 *   4. any non-numeric column (last resort)
 */
export function pickLabelColumn(columns: string[], numericCols: string[]): string | undefined {
  const nonNumeric = columns.filter((c) => !numericCols.includes(c));
  if (nonNumeric.length === 0) return undefined;

  const lower = (s: string) => s.toLowerCase();
  const isCode = (s: string) =>
    /(_id|_key|_nr|_number|_code|artikelnr|^id$|^key$|^code$|^nr$)$/.test(lower(s));
  const isNameLike = (s: string) =>
    /(^name$|^label$|^title$|^description$|_name$|_title$|_label$|_description$|product_name|customer_name|supplier_name|category_name|employee_name)/.test(lower(s));

  // 1. explicit name/label
  const exact = nonNumeric.find(isNameLike);
  if (exact) return exact;

  // 2. anything that's not code-like
  const nonCode = nonNumeric.find((c) => !isCode(c));
  if (nonCode) return nonCode;

  // 3. fall back to first non-numeric (even if code-like)
  return nonNumeric[0];
}
