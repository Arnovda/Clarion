// ─── chart-theme.ts ──────────────────────────────────────────────────────────
// Observatory chart palette for DataBridge dashboards.
// Muted, editorial tones aligned with --c1 through --c6 in globals.css.
// All chart components should import colors from here — never hardcode hex values.

// ─── Series Palette ───────────────────────────────────────────────────────────

export const PALETTE = {
  // Primary series colors (6 coordinated Observatory tones).
  // Each entry's `gradient` pair derives a brighter/darker shade of the solid.
  series: [
    { solid: '#164e63', gradient: ['#1f6379', '#103d4f'] as [string, string] },  // ocean
    { solid: '#3f7a5c', gradient: ['#5a8f72', '#315f49'] as [string, string] },  // ok green
    { solid: '#a06a1c', gradient: ['#b27f37', '#7f5416'] as [string, string] },  // warn amber
    { solid: '#6b4e8c', gradient: ['#8567a7', '#553c70'] as [string, string] },  // plum
    { solid: '#8c5a3c', gradient: ['#a37151', '#6f4730'] as [string, string] },  // terracotta
    { solid: '#2d6e78', gradient: ['#3e8590', '#20555c'] as [string, string] },  // teal
  ],

  // Semantic colors for positive/negative/neutral deltas and badges
  positive: { solid: '#3f7a5c', light: '#dbe8e0', text: '#2b5a43' },
  negative: { solid: '#a43a3a', light: '#f1d7d7', text: '#7d2929' },
  neutral:  { solid: '#6b7680', light: '#edeff2', text: '#4a5660' },

  // KPI card background tints (very subtle, based on delta direction)
  kpiPositiveTint: 'rgba(63, 122, 92, 0.04)',
  kpiNegativeTint: 'rgba(164, 58, 58, 0.04)',
  kpiNeutralTint:  'rgba(22, 78, 99, 0.03)',

  // Chart structural colors
  grid:      'rgba(13, 28, 47, 0.06)',
  axis:      '#b8bec5',
  axisLabel: '#6b7680',
} as const;

// ─── Widget Type → Accent Color Mapping ──────────────────────────────────────

export const TYPE_ACCENT: Record<string, string> = {
  kpi_card:           '#164e63',
  bar_chart:          '#164e63',
  vertical_bar_chart: '#3f7a5c',
  stacked_bar_chart:  '#a06a1c',
  line_chart:         '#2d6e78',
  pie_chart:          '#6b4e8c',
  top_list:           '#8c5a3c',
  data_table:         '#6b7680',
  combo_chart:        '#2d6e78',
  radar_chart:        '#6b4e8c',
  treemap_chart:      '#3f7a5c',
};

// ─── Series Helpers ───────────────────────────────────────────────────────────

/**
 * Get the solid series color for a given series index.
 * Wraps around if index exceeds the palette length.
 */
export function getSeriesColor(index: number): string {
  return PALETTE.series[index % PALETTE.series.length].solid;
}

/**
 * Get the gradient pair [light, dark] for a given series index.
 * Wraps around if index exceeds the palette length.
 */
export function getSeriesGradient(index: number): [string, string] {
  return PALETTE.series[index % PALETTE.series.length].gradient;
}

/**
 * Get all solid series colors as a flat array (for Recharts CHART_COLORS pattern).
 */
export const SERIES_COLORS: string[] = PALETTE.series.map((s) => s.solid);

/**
 * Get the accent color for a widget type, with a fallback to the first series color.
 */
export function getTypeAccent(widgetType: string): string {
  return TYPE_ACCENT[widgetType] ?? PALETTE.series[0].solid;
}
