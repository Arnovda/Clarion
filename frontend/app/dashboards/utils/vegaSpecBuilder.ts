// ─── vegaSpecBuilder.ts ──────────────────────────────────────────────────────
// Turns Clarion's structured widget spec + executed rows into a themed
// Vega-Lite spec. The AI keeps emitting the same reliable, narrow widget
// types (bar / line / stacked / pie / combo …); this layer makes them all
// render through ONE beautiful, consistent Vega-Lite engine.
//
// Column contract (set by the dashboard SQL prompt — unchanged):
//   simple charts : { label, value }            (+ optional `target` on line)
//   stacked       : { label, series, value }    (long format)
//   combo         : { label, value, line }       (bar = value, line = line)

import type { TopLevelSpec } from 'vega-lite';
import { CLARION_VEGA_CONFIG, axisLabelExpr, tooltipFormat, VEGA_COLORS } from './vegaTheme';
import type { WidgetSpec } from '../types';

type Row = Record<string, unknown>;

export interface BuildOpts {
  /** When set, this widget is the cross-filter source — the matching
   *  category stays bright, the rest dim (Power-BI-style highlight). */
  highlightValue?: string;
  /** Title-cased label for the value axis / legend (defaults to "Value"). */
  valueTitle?: string;
}

const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Which widget types this builder can render. Others fall back to legacy. */
export const VEGA_SUPPORTED = new Set<WidgetSpec['type']>([
  'bar_chart', 'vertical_bar_chart', 'stacked_bar_chart',
  'line_chart', 'pie_chart', 'combo_chart',
]);

/**
 * Main entry. Returns a complete, themed Vega-Lite spec, or null when the
 * type isn't one we render in Vega (caller keeps its legacy renderer).
 */
export function buildVegaSpec(
  widget: WidgetSpec,
  rows: Row[],
  opts: BuildOpts = {},
): TopLevelSpec | null {
  if (!rows || rows.length === 0) return null;
  const fmt = widget.format;
  switch (widget.type) {
    case 'bar_chart':          return horizontalBar(rows, fmt, opts);
    case 'vertical_bar_chart': return verticalBar(rows, fmt, opts);
    case 'stacked_bar_chart':  return stackedBar(rows, fmt, opts);
    case 'line_chart':         return lineChart(rows, fmt, opts);
    case 'pie_chart':          return donut(rows, fmt, opts);
    case 'combo_chart':        return combo(rows, fmt, opts);
    default:                   return null;
  }
}

// ── Shared encodings ─────────────────────────────────────────────────────────

const base = (rows: Row[]): Partial<TopLevelSpec> => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  config: CLARION_VEGA_CONFIG,
  data: { values: rows },
  width: 'container',
  autosize: { type: 'fit', contains: 'padding', resize: true },
});

const valueAxis = (fmt?: string) => ({
  title: null,
  labelExpr: axisLabelExpr(fmt),
});

const valueTooltip = (fmt?: string, title = 'Value') => ({
  field: 'value', type: 'quantitative' as const, title, ...tooltipFormat(fmt),
});

/** Dim non-matching categories when a cross-filter highlight is active. */
function highlightOpacity(field: string, highlightValue?: string) {
  if (highlightValue === undefined) return undefined;
  return {
    condition: { test: `datum['${field}'] === ${JSON.stringify(highlightValue)}`, value: 1 },
    value: 0.28,
  };
}

// ── Horizontal bar (ranked) ──────────────────────────────────────────────────

function horizontalBar(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const data = rows.map((r) => ({ label: str(r.label), value: num(r.value) }));
  const h = Math.max(160, Math.min(data.length * 34 + 24, 360));
  return {
    ...base(data),
    height: h,
    mark: { type: 'bar', cornerRadiusEnd: 4, tooltip: true },
    encoding: {
      y: { field: 'label', type: 'nominal', sort: '-x', title: null,
           axis: { labelLimit: 160 } },
      x: { field: 'value', type: 'quantitative', axis: valueAxis(fmt) },
      color: { value: VEGA_COLORS[0] },
      opacity: highlightOpacity('label', opts.highlightValue),
      tooltip: [
        { field: 'label', type: 'nominal', title: ' ' },
        valueTooltip(fmt, opts.valueTitle ?? 'Value'),
      ],
    },
  } as TopLevelSpec;
}

// ── Vertical bar (totals / time) ─────────────────────────────────────────────

function verticalBar(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const data = rows.map((r) => ({ label: str(r.label), value: num(r.value) }));
  return {
    ...base(data),
    height: 260,
    mark: { type: 'bar', cornerRadiusEnd: 4, tooltip: true },
    encoding: {
      x: { field: 'label', type: 'nominal', sort: null, title: null,
           axis: { labelAngle: data.length > 8 ? -35 : 0, labelLimit: 90 } },
      y: { field: 'value', type: 'quantitative', axis: valueAxis(fmt) },
      color: { value: VEGA_COLORS[0] },
      opacity: highlightOpacity('label', opts.highlightValue),
      tooltip: [
        { field: 'label', type: 'nominal', title: ' ' },
        valueTooltip(fmt, opts.valueTitle ?? 'Value'),
      ],
    },
  } as TopLevelSpec;
}

// ── Stacked bar (label × series) ─────────────────────────────────────────────

function stackedBar(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const data = rows.map((r) => ({ label: str(r.label), series: str(r.series), value: num(r.value) }));
  return {
    ...base(data),
    height: 280,
    mark: { type: 'bar', tooltip: true },
    encoding: {
      x: { field: 'label', type: 'nominal', sort: null, title: null,
           axis: { labelAngle: data.length > 24 ? -35 : 0, labelLimit: 90 } },
      y: { field: 'value', type: 'quantitative', stack: 'zero', axis: valueAxis(fmt) },
      color: { field: 'series', type: 'nominal', title: null,
               scale: { range: VEGA_COLORS }, legend: { orient: 'top' } },
      opacity: highlightOpacity('label', opts.highlightValue),
      tooltip: [
        { field: 'label', type: 'nominal', title: ' ' },
        { field: 'series', type: 'nominal', title: 'Series' },
        valueTooltip(fmt, opts.valueTitle ?? 'Value'),
      ],
    },
  } as TopLevelSpec;
}

// ── Line (with optional target overlay) ──────────────────────────────────────

function lineChart(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const hasTarget = rows.some((r) => r.target !== undefined && r.target !== null);
  const data = rows.map((r) => ({
    label: str(r.label),
    value: num(r.value),
    ...(hasTarget ? { target: num(r.target) } : {}),
  }));
  const x = { field: 'label', type: 'nominal' as const, sort: null, title: null,
              axis: { labelAngle: data.length > 8 ? -35 : 0, labelLimit: 90 } };
  const valueLine = {
    mark: { type: 'line' as const, point: { filled: true, size: 50 }, tooltip: true, interpolate: 'monotone' as const },
    encoding: {
      x, y: { field: 'value', type: 'quantitative' as const, axis: valueAxis(fmt) },
      color: { value: VEGA_COLORS[0] },
      tooltip: [
        { field: 'label', type: 'nominal' as const, title: ' ' },
        valueTooltip(fmt, opts.valueTitle ?? 'Value'),
      ],
    },
  };
  if (!hasTarget) {
    return { ...base(data), height: 260, ...valueLine } as TopLevelSpec;
  }
  return {
    ...base(data),
    height: 260,
    layer: [
      valueLine,
      {
        mark: { type: 'line' as const, strokeDash: [4, 3], strokeWidth: 1.5, interpolate: 'monotone' as const },
        encoding: {
          x, y: { field: 'target', type: 'quantitative' as const },
          color: { value: '#9aa3ac' },
        },
      },
    ],
  } as TopLevelSpec;
}

// ── Donut (modern pie) ───────────────────────────────────────────────────────

function donut(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const data = rows.map((r) => ({ label: str(r.label), value: num(r.value) }));
  return {
    ...base(data),
    height: 240,
    mark: { type: 'arc', innerRadius: 58, cornerRadius: 2, tooltip: true, padAngle: 0.015 },
    encoding: {
      theta: { field: 'value', type: 'quantitative', stack: true },
      color: { field: 'label', type: 'nominal', title: null,
               scale: { range: VEGA_COLORS }, legend: { orient: 'right' } },
      opacity: highlightOpacity('label', opts.highlightValue),
      order: { field: 'value', type: 'quantitative', sort: 'descending' },
      tooltip: [
        { field: 'label', type: 'nominal', title: ' ' },
        valueTooltip(fmt, opts.valueTitle ?? 'Value'),
      ],
    },
  } as TopLevelSpec;
}

// ── Combo (bars + line, dual axis) ───────────────────────────────────────────

function combo(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const data = rows.map((r) => ({ label: str(r.label), value: num(r.value), line: num(r.line) }));
  const x = { field: 'label', type: 'nominal' as const, sort: null, title: null,
              axis: { labelAngle: data.length > 8 ? -35 : 0, labelLimit: 90 } };
  return {
    ...base(data),
    height: 260,
    resolve: { scale: { y: 'independent' } },
    layer: [
      {
        mark: { type: 'bar' as const, cornerRadiusEnd: 4, tooltip: true },
        encoding: {
          x,
          y: { field: 'value', type: 'quantitative' as const, axis: valueAxis(fmt) },
          color: { value: VEGA_COLORS[0] },
          opacity: highlightOpacity('label', opts.highlightValue),
          tooltip: [
            { field: 'label', type: 'nominal' as const, title: ' ' },
            valueTooltip(fmt, opts.valueTitle ?? 'Value'),
          ],
        },
      },
      {
        mark: { type: 'line' as const, point: { filled: true, size: 45 }, tooltip: true, interpolate: 'monotone' as const },
        encoding: {
          x,
          y: { field: 'line', type: 'quantitative' as const,
               axis: { title: null, labelExpr: axisLabelExpr('number'), grid: false } },
          color: { value: VEGA_COLORS[5] },
          tooltip: [
            { field: 'line', type: 'quantitative' as const, title: 'Rate', format: ',.2f' },
          ],
        },
      },
    ],
  } as TopLevelSpec;
}
