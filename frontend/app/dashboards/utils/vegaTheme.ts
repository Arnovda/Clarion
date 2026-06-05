// ─── vegaTheme.ts ────────────────────────────────────────────────────────────
// The single source of truth for how every Vega-Lite chart in Clarion looks.
// One config object, applied to every spec the builder produces, so all
// dashboards speak ONE polished visual language — editorial, calm, legible.
//
// Design intent (Observatory): generous whitespace, hairline axes, muted
// gridlines, soft-rounded bars, a single warm accent palette, no chart
// chrome competing with the data. The widget card already carries the
// title — charts themselves stay quiet.

import type { Config } from 'vega-lite';
import { PALETTE, SERIES_COLORS } from './chart-theme';

// System font stack — matches the app shell. Geist first, graceful fallback.
const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

const INK_2 = '#3a4654';
const MUTED = PALETTE.axisLabel;   // '#6b7680'
const GRID  = PALETTE.grid;        // very faint
const OCEAN = SERIES_COLORS[0];

/**
 * The Clarion Vega-Lite config. Spread into every spec via buildVegaSpec.
 * Kept as a plain object (not frozen) so per-chart builders can layer
 * small overrides without cloning the whole thing.
 */
export const CLARION_VEGA_CONFIG: Config = {
  background: 'transparent',
  font: FONT,
  // Remove the default 5px view border — the widget card frames it.
  view: { stroke: null, continuousWidth: 400, continuousHeight: 200 },

  // Soft, coordinated categorical palette + a single-hue ramp for heat.
  range: {
    category: SERIES_COLORS as string[],
    ordinal: { scheme: 'tealblues' },
    heatmap: { scheme: 'tealblues' },
    ramp: { scheme: 'tealblues' },
  },

  axis: {
    labelFont: FONT,
    labelFontSize: 11,
    labelColor: MUTED,
    labelPadding: 6,
    titleFont: FONT,
    titleFontSize: 11,
    titleColor: MUTED,
    titleFontWeight: 500,
    titlePadding: 10,
    domain: false,            // no axis spine — hairline grid does the work
    ticks: false,
    grid: true,
    gridColor: GRID,
    gridWidth: 1,
    labelOverlap: true,
  },
  axisX: {
    grid: false,             // vertical gridlines off — cleaner for bars/time
    labelFlush: true,
  },
  axisY: {
    grid: true,
    gridDash: [2, 3],
    tickCount: 5,
  },

  legend: {
    labelFont: FONT,
    labelFontSize: 11,
    labelColor: INK_2,
    titleFont: FONT,
    titleFontSize: 10,
    titleColor: MUTED,
    titleFontWeight: 600,
    symbolType: 'circle',
    symbolSize: 70,
    orient: 'top',
    offset: 4,
    padding: 0,
  },

  title: {
    font: FONT,
    fontSize: 13,
    fontWeight: 600,
    color: INK_2,
    anchor: 'start',
    subtitleFont: FONT,
    subtitleColor: MUTED,
  },

  // ── Mark defaults — where most of the "slick" lives ──
  bar: {
    fill: OCEAN,
    cornerRadiusEnd: 4,      // rounded top (vertical) / end (horizontal)
    // A touch of breathing room between bars handled by scale paddingInner.
  },
  line: {
    stroke: OCEAN,
    strokeWidth: 2.5,
    strokeCap: 'round',
    strokeJoin: 'round',
    point: false,
  },
  point: { size: 60, filled: true, fill: OCEAN },
  area: { fill: OCEAN, fillOpacity: 0.12, line: { strokeWidth: 2.5 } },
  arc: { stroke: '#ffffff', strokeWidth: 1.5, innerRadius: 0 },
  rect: { cornerRadius: 2 },
  text: { font: FONT, fontSize: 11, fill: INK_2 },

  // Tasteful spacing for grouped/stacked categories.
  scale: { bandPaddingInner: 0.28, pointPadding: 0.5 },
} as Config;

// d3-format-ish helpers expressed in the Vega expression language. Used for
// axis labels (compact) and tooltips (full). Mirrors utils/format.ts so a
// chart axis and the KPI card next to it speak the same number language.

/** Compact axis labels: €1.2k / 1.2M / 23% / 1,234. */
export function axisLabelExpr(format?: string): string {
  if (format === 'currency') return "'€' + format(datum.value, '~s')";
  if (format === 'percentage') return "format(datum.value, '.3~s') + '%'";
  return "format(datum.value, '~s')";
}

/** Full tooltip values: €1,234.50 / 23.45% / 1,234. */
export function tooltipFormat(format?: string): { format: string; formatType?: string } {
  if (format === 'currency') return { format: '€,.2f' };
  if (format === 'percentage') return { format: ',.2f' };
  return { format: ',.2f' };
}

export const VEGA_COLORS = SERIES_COLORS as string[];
export { OCEAN as VEGA_OCEAN };
