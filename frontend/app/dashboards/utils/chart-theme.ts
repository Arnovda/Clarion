// ─── chart-theme.ts ──────────────────────────────────────────────────────────
// Premium "Ocean" color palette and chart theming for DataBridge dashboards.
// All chart components should import colors from here — never hardcode hex values.

// ─── Series Palette ───────────────────────────────────────────────────────────

export const PALETTE = {
  // Primary series colors (8 coordinated colors, each with a gradient pair)
  series: [
    { solid: '#4F46E5', gradient: ['#6366F1', '#4338CA'] as [string, string] },  // Indigo
    { solid: '#0EA5E9', gradient: ['#38BDF8', '#0284C7'] as [string, string] },  // Sky
    { solid: '#10B981', gradient: ['#34D399', '#059669'] as [string, string] },  // Emerald
    { solid: '#F59E0B', gradient: ['#FBBF24', '#D97706'] as [string, string] },  // Amber
    { solid: '#8B5CF6', gradient: ['#A78BFA', '#7C3AED'] as [string, string] },  // Violet
    { solid: '#EC4899', gradient: ['#F472B6', '#DB2777'] as [string, string] },  // Pink
    { solid: '#06B6D4', gradient: ['#22D3EE', '#0891B2'] as [string, string] },  // Cyan
    { solid: '#F97316', gradient: ['#FB923C', '#EA580C'] as [string, string] },  // Orange
  ],

  // Semantic colors for positive/negative/neutral deltas and badges
  positive: { solid: '#10B981', light: '#D1FAE5', text: '#065F46' },
  negative: { solid: '#EF4444', light: '#FEE2E2', text: '#991B1B' },
  neutral:  { solid: '#6B7280', light: '#F3F4F6', text: '#374151' },

  // KPI card background tints (very subtle, based on delta direction)
  kpiPositiveTint: 'rgba(16, 185, 129, 0.04)',
  kpiNegativeTint: 'rgba(239, 68, 68, 0.03)',
  kpiNeutralTint:  'rgba(99, 102, 241, 0.03)',

  // Chart structural colors
  grid:      'rgba(148, 163, 184, 0.08)',
  axis:      '#CBD5E1',
  axisLabel: '#94A3B8',
} as const;

// ─── Widget Type → Accent Color Mapping ──────────────────────────────────────

export const TYPE_ACCENT: Record<string, string> = {
  kpi_card:           '#6366F1',
  bar_chart:          '#4F46E5',
  vertical_bar_chart: '#10B981',
  stacked_bar_chart:  '#F59E0B',
  line_chart:         '#0EA5E9',
  pie_chart:          '#8B5CF6',
  top_list:           '#EC4899',
  data_table:         '#64748B',
  combo_chart:        '#06B6D4',
  radar_chart:        '#A855F7',
  treemap_chart:      '#10B981',
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
