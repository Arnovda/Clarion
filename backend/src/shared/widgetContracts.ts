/**
 * Widget data-column contracts — the single source of truth for which columns
 * each widget type's SQL must return.
 *
 * The frontend widgets read these columns by name (`label`/`value`/`series`/
 * `row_label`/…) and render an EMPTY chart — not an error — when they're
 * missing. That silent-blank mode is exactly the failure class that killed the
 * Vega-Lite migration, just in miniature. This module makes the contract
 * checkable: the /generate validation pass asserts every executed widget's
 * result set actually contains its required columns, so a mis-aliased AI query
 * becomes a caught, repairable issue instead of an empty card.
 *
 * Keep in sync with the prompt blocks in ai/prompts/dashboardPrompt.ts and the
 * widget components in frontend/app/dashboards/components/ChartWidgets.tsx.
 */

import type { WidgetSpec } from './contract';

type WidgetType = WidgetSpec['type'];

/** Columns the widget's SQL MUST return (checked case-insensitively). */
export const REQUIRED_WIDGET_COLUMNS: Record<WidgetType, string[]> = {
  kpi_card: ['value'],
  bar_chart: ['label', 'value'],
  vertical_bar_chart: ['label', 'value'],
  stacked_bar_chart: ['label', 'series', 'value'],
  line_chart: ['label', 'value'],
  pie_chart: ['label', 'value'],
  top_list: ['label', 'value'],
  data_table: [], // any named columns
  combo_chart: ['label', 'value'], // optional: "line" (right-axis overlay)
  radar_chart: ['label', 'value'],
  treemap_chart: ['label', 'value'],
  pivot_table: ['row_label', 'col_label', 'value'],
};

/**
 * Check a widget's sample rows against its column contract.
 * Returns a short human/AI-readable issue string, or null when the contract
 * is satisfied (or the type has no contract / there are no rows to check).
 */
export function validateWidgetColumns(
  type: string,
  sampleRows: Array<Record<string, unknown>>,
): string | null {
  const required = (REQUIRED_WIDGET_COLUMNS as Record<string, string[] | undefined>)[type];
  if (!required || required.length === 0 || sampleRows.length === 0) return null;

  const present = new Set(Object.keys(sampleRows[0]).map((k) => k.toLowerCase()));
  const missing = required.filter((col) => !present.has(col));
  if (missing.length === 0) return null;

  return `SQL result is missing required column(s) for ${type}: ${missing.join(', ')}. ` +
    `Columns returned: ${Object.keys(sampleRows[0]).join(', ')}. ` +
    `Alias the SELECT columns to the required names.`;
}
