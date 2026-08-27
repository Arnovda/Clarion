/**
 * Shared table-name humanizer — the ONE place a raw warehouse name becomes a
 * business label ("dim_item" → "Item", "fact_sales_invoice_lines" → "Sales
 * Invoice Lines"). Every surface that may fall back to a technical name
 * (catalog cards, filter provenance, shared-data) uses this so a viewer never
 * reads `dim_*` and two surfaces never humanize differently.
 */
export function humanizeTableName(name: string): string {
  return name
    .replace(/^(dim|fact|rollup_monthly)_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True when a label is (or still looks like) a raw warehouse table name. */
export function looksLikeRawTableName(name: string): boolean {
  return /^(dim|fact|rollup_monthly)_/.test(name) || /^[a-z0-9_]+$/.test(name);
}
