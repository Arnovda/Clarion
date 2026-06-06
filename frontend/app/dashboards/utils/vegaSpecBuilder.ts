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
import {
  CLARION_VEGA_CONFIG, valueAxisFormat, tooltipFormat, VEGA_COLORS, VEGA_TRACK, VEGA_TICK,
} from './vegaTheme';
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

const looksNumeric = (v: unknown) =>
  v != null && v !== '' && !Number.isNaN(Number(v));

/**
 * Robustly resolve which columns to use as label / value, tolerating AI
 * alias drift. Prefers the declared contract (`label` / `value`); otherwise
 * infers: the first mostly-numeric column is the value, the first other
 * column is the label. This is the difference between a chart that renders
 * and one that silently shows empty axes when the SQL aliased its columns
 * as, say, `month` + `revenue` instead of `label` + `value`.
 */
function resolveLV(rows: Row[]): { labelKey: string; valueKey: string } {
  const cols = Object.keys(rows[0] ?? {});
  if (cols.includes('label') && cols.includes('value')) {
    return { labelKey: 'label', valueKey: 'value' };
  }
  const numericCols = cols.filter((c) => rows.some((r) => looksNumeric(r[c]))
    && rows.every((r) => r[c] == null || looksNumeric(r[c])));
  const valueKey = (cols.includes('value') ? 'value' : numericCols[0]) ?? cols[cols.length - 1] ?? 'value';
  const labelKey = (cols.includes('label') ? 'label' : cols.find((c) => c !== valueKey)) ?? cols[0] ?? 'label';
  return { labelKey, valueKey };
}

/** Map raw rows to the canonical { label, value } the simple builders expect. */
function toLV(rows: Row[]): Array<{ label: string; value: number }> {
  const { labelKey, valueKey } = resolveLV(rows);
  return rows.map((r) => ({ label: str(r[labelKey]), value: num(r[valueKey]) }));
}

/** Which widget types this builder can render. Others fall back to legacy. */
export const VEGA_SUPPORTED = new Set<WidgetSpec['type']>([
  'bar_chart', 'vertical_bar_chart', 'stacked_bar_chart',
  'line_chart', 'pie_chart', 'combo_chart',
  'top_list', 'radar_chart', 'treemap_chart',
  'bullet_chart', 'scatter_chart', 'small_multiples',
]);

/** Humanise a raw column key for use as an axis / tooltip title:
 *  "avg_net_price" → "Avg net price". Used by the scatter builder, whose
 *  two measure axes are inferred from the SQL's own column names. */
function humanize(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Main entry. Returns a complete Vega-Lite OR full-Vega spec (vega-embed
 * detects which from the $schema). Treemap + radar are full Vega because
 * Vega-Lite has no `treemap` transform and no polar coordinates; every
 * other type stays in the simpler Vega-Lite grammar. Returns null when
 * the type isn't one we render in Vega (caller keeps its legacy renderer).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildVegaSpec(
  widget: WidgetSpec,
  rows: Row[],
  opts: BuildOpts = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (!rows || rows.length === 0) return null;
  const fmt = widget.format;
  switch (widget.type) {
    case 'bar_chart':          return horizontalBar(rows, fmt, opts);
    case 'vertical_bar_chart': return verticalBar(rows, fmt, opts);
    case 'stacked_bar_chart':  return stackedBar(rows, fmt, opts);
    case 'line_chart':         return lineChart(rows, fmt, opts);
    case 'pie_chart':          return donut(rows, fmt, opts);
    case 'combo_chart':        return combo(rows, fmt, opts);
    case 'top_list':           return topList(rows, fmt, opts);
    case 'bullet_chart':       return bullet(rows, fmt, opts);
    case 'scatter_chart':      return scatter(rows, fmt, opts);
    case 'small_multiples':    return smallMultiples(rows, fmt);
    case 'treemap_chart':      return treemap(rows, fmt);
    case 'radar_chart':        return radar(rows, fmt);
    default:                   return null;
  }
}

// ── Shared encodings ─────────────────────────────────────────────────────────

// No `autosize: fit` — it can shrink the plot area to nothing when axis
// labels are long, leaving a chart with axes but no marks. The default
// ('pad') always reserves the full width/height for the data rectangle.
// Width is set to the measured pixel width by <VegaChart>.
const base = (rows: Row[]): Partial<TopLevelSpec> => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  config: CLARION_VEGA_CONFIG,
  data: { values: rows },
  width: 'container',
});

const valueAxis = (fmt?: string) => ({
  title: null,
  format: valueAxisFormat(fmt),
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
  const data = toLV(rows);
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
  const data = toLV(rows);
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
  const data = toLV(rows);
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
               axis: { title: null, format: valueAxisFormat('number'), grid: false } },
          color: { value: VEGA_COLORS[5] },
          tooltip: [
            { field: 'line', type: 'quantitative' as const, title: 'Rate', format: ',.2f' },
          ],
        },
      },
    ],
  } as TopLevelSpec;
}

// ── Top list (ranked horizontal bar with value labels) ───────────────────────
// A ranked-list aesthetic: index pill on the left, label, soft tinted bar
// behind, full-precision value on the right. Stays in Vega-Lite via a
// layered bar + text mark; the row count is bounded so it never crowds.

function topList(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const data = rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    label: str(r.label),
    value: num(r.value),
  }));
  const h = Math.max(140, Math.min(data.length * 28 + 16, 320));
  return {
    ...base(data),
    height: h,
    layer: [
      {
        mark: { type: 'bar' as const, cornerRadiusEnd: 4, tooltip: true, opacity: 0.92 },
        encoding: {
          y: { field: 'label', type: 'nominal' as const, sort: '-x', title: null,
               axis: { labelLimit: 180, labelPadding: 10 } },
          x: { field: 'value', type: 'quantitative' as const, axis: null },
          color: { value: VEGA_COLORS[0] },
          opacity: highlightOpacity('label', opts.highlightValue),
          tooltip: [
            { field: 'label', type: 'nominal' as const, title: ' ' },
            valueTooltip(fmt, opts.valueTitle ?? 'Value'),
          ],
        },
      },
      {
        // Numeric label at the bar's end. dx pushes it just past the tip;
        // align:left makes long labels render outside instead of overflowing.
        mark: { type: 'text' as const, align: 'left' as const, baseline: 'middle' as const,
                dx: 6, fontSize: 11, fontWeight: 500 },
        encoding: {
          y: { field: 'label', type: 'nominal' as const, sort: '-x' },
          x: { field: 'value', type: 'quantitative' as const },
          text: { field: 'value', type: 'quantitative' as const, ...tooltipFormat(fmt) },
          color: { value: '#3a4654' },
        },
      },
    ],
  } as TopLevelSpec;
}

// ── Bullet (actual vs target, horizontal) ────────────────────────────────────
// Three layered marks per category: a faint full "track" sized to the target,
// the actual value as a thin bold bar, and a dark tick at the target line.
// Reads "actual vs target" at a glance — the analyst's KPI-with-context chart.
// Degrades gracefully to a plain ranked bar when no target column is present.

function bullet(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const hasTarget = rows.some((r) => r.target !== undefined && r.target !== null);
  const data = rows.map((r) => ({
    label: str(r.label),
    value: num(r.value),
    ...(hasTarget ? { target: num(r.target) } : {}),
  }));
  const h = Math.max(150, Math.min(data.length * 40 + 24, 380));

  const actualTooltip = [
    { field: 'label', type: 'nominal' as const, title: ' ' },
    { field: 'value', type: 'quantitative' as const, title: 'Actual', ...tooltipFormat(fmt) },
    ...(hasTarget
      ? [{ field: 'target', type: 'quantitative' as const, title: 'Target', ...tooltipFormat(fmt) }]
      : []),
  ];

  const actualLayer = {
    mark: {
      type: 'bar' as const, cornerRadiusEnd: 3, color: VEGA_COLORS[0], tooltip: true,
      ...(hasTarget ? { height: 10 } : {}),
    },
    encoding: {
      x: { field: 'value', type: 'quantitative' as const, ...(hasTarget ? {} : { axis: valueAxis(fmt) }) },
      opacity: highlightOpacity('label', opts.highlightValue),
      tooltip: actualTooltip,
    },
  };

  return {
    ...base(data),
    height: h,
    encoding: {
      y: { field: 'label', type: 'nominal', sort: '-x', title: null, axis: { labelLimit: 160 } },
    },
    layer: hasTarget
      ? [
          {
            mark: { type: 'bar' as const, cornerRadiusEnd: 3, color: VEGA_TRACK },
            encoding: { x: { field: 'target', type: 'quantitative' as const, axis: valueAxis(fmt) } },
          },
          actualLayer,
          {
            mark: { type: 'tick' as const, color: VEGA_TICK, thickness: 2, size: 24 },
            encoding: { x: { field: 'target', type: 'quantitative' as const } },
          },
        ]
      : [actualLayer],
  } as TopLevelSpec;
}

// ── Scatter / bubble (two measures, optional size + colour group) ─────────────
// Columns are inferred from the SQL's own names so tooltips/axes stay
// self-documenting: a text column is the point label, the first two numeric
// columns become x and y, a third numeric (if any) drives bubble size, and a
// second text column colours the points by group.

function scatter(rows: Row[], fmt?: string, opts: BuildOpts = {}): TopLevelSpec {
  const cols = Object.keys(rows[0] ?? {});
  const isNumCol = (c: string) =>
    rows.some((r) => looksNumeric(r[c])) && rows.every((r) => r[c] == null || looksNumeric(r[c]));

  const labelKey = cols.includes('label')
    ? 'label'
    : (cols.find((c) => !isNumCol(c)) ?? cols[0] ?? 'label');
  const numericCols = cols.filter((c) => c !== labelKey && isNumCol(c));
  const xKey = cols.includes('x') ? 'x' : (numericCols[0] ?? cols[0]);
  const yKey = cols.includes('y') ? 'y' : (numericCols.find((c) => c !== xKey) ?? numericCols[0] ?? cols[0]);
  const sizeKey = cols.includes('size')
    ? 'size'
    : numericCols.find((c) => c !== xKey && c !== yKey);
  const groupKey = cols.includes('group')
    ? 'group'
    : cols.find((c) => c !== labelKey && c !== xKey && c !== yKey && c !== sizeKey && !isNumCol(c));

  const data = rows.map((r) => ({
    label: str(r[labelKey]),
    x: num(r[xKey]),
    y: num(r[yKey]),
    ...(sizeKey ? { size: num(r[sizeKey]) } : {}),
    ...(groupKey ? { group: str(r[groupKey]) } : {}),
  }));

  return {
    ...base(data),
    height: 280,
    mark: { type: 'circle', opacity: 0.82, tooltip: true },
    encoding: {
      x: { field: 'x', type: 'quantitative', title: humanize(xKey), axis: { format: '.3~s' } },
      y: { field: 'y', type: 'quantitative', title: null, axis: valueAxis(fmt) },
      size: sizeKey
        ? { field: 'size', type: 'quantitative', legend: null, scale: { range: [80, 700] } }
        : { value: 120 },
      color: groupKey
        ? { field: 'group', type: 'nominal', title: null, scale: { range: VEGA_COLORS }, legend: { orient: 'top' } }
        : { value: VEGA_COLORS[0] },
      opacity: highlightOpacity('label', opts.highlightValue),
      tooltip: [
        { field: 'label', type: 'nominal', title: ' ' },
        { field: 'x', type: 'quantitative', title: humanize(xKey), format: ',.2f' },
        { field: 'y', type: 'quantitative', title: humanize(yKey), ...tooltipFormat(fmt) },
        ...(sizeKey ? [{ field: 'size', type: 'quantitative' as const, title: humanize(sizeKey), format: ',.2f' }] : []),
        ...(groupKey ? [{ field: 'group', type: 'nominal' as const, title: 'Group' }] : []),
      ],
    },
  } as TopLevelSpec;
}

// ── Small multiples (a grid of mini area charts, one per group) ───────────────
// Faceted area sparklines sharing an x (time) axis but independent y scales, so
// each group's shape is legible regardless of magnitude. Built as a faceted
// Vega-Lite spec WITHOUT a top-level container width — <VegaChart> sizes the
// child spec to fit the measured container (facet specs ignore top-level width).

function smallMultiples(rows: Row[], fmt?: string): TopLevelSpec {
  const cols = Object.keys(rows[0] ?? {});
  const facetKey = ['facet', 'series', 'group'].find((c) => cols.includes(c)) ?? cols[0];
  const rest = cols.filter((c) => c !== facetKey);
  const valueKey = rest.includes('value')
    ? 'value'
    : (rest.find((c) => rows.some((r) => looksNumeric(r[c])) && rows.every((r) => r[c] == null || looksNumeric(r[c]))) ?? rest[rest.length - 1] ?? 'value');
  const labelKey = rest.includes('label') ? 'label' : (rest.find((c) => c !== valueKey) ?? rest[0] ?? 'label');

  const data = rows.map((r) => ({
    facet: str(r[facetKey]),
    label: str(r[labelKey]),
    value: num(r[valueKey]),
  }));
  const facetCount = new Set(data.map((d) => d.facet)).size;
  const columns = Math.min(Math.max(facetCount, 1), 3);

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    config: CLARION_VEGA_CONFIG,
    data: { values: data },
    columns,
    facet: {
      field: 'facet', type: 'nominal', title: null,
      header: { labelFontSize: 11, labelFontWeight: 600, labelColor: '#3a4654', labelAnchor: 'start' },
    },
    spec: {
      width: 200,
      height: 78,
      mark: {
        type: 'area',
        line: { color: VEGA_COLORS[0], strokeWidth: 1.5 },
        color: {
          x1: 1, y1: 1, x2: 1, y2: 0, gradient: 'linear',
          stops: [
            { offset: 0, color: 'rgba(22,78,99,0)' },
            { offset: 1, color: 'rgba(22,78,99,0.18)' },
          ],
        },
        tooltip: true,
      },
      encoding: {
        x: { field: 'label', type: 'nominal', sort: null, axis: null },
        y: { field: 'value', type: 'quantitative', axis: null },
        tooltip: [
          { field: 'facet', type: 'nominal', title: ' ' },
          { field: 'label', type: 'nominal', title: 'Period' },
          { field: 'value', type: 'quantitative', title: 'Value', ...tooltipFormat(fmt) },
        ],
      },
    },
    resolve: { scale: { y: 'independent' } },
  } as unknown as TopLevelSpec;
}

// ── Treemap (full Vega, since Vega-Lite has no treemap transform) ────────────
// Uses Vega's `treemap` transform (squarify) with the Clarion palette;
// tiles get hairline white borders + soft inset labels.

function treemap(rows: Row[], fmt?: string): unknown {
  const data = rows.map((r) => ({ label: str(r.label), value: Math.max(num(r.value), 0) }));
  const tooltipFmt = fmt === 'currency' ? "'€' + format(datum.value, ',.2f')"
                   : fmt === 'percentage' ? "format(datum.value, ',.2f') + '%'"
                   : "format(datum.value, ',.2f')";
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    background: 'transparent',
    autosize: { type: 'fit', resize: true },
    width: 400, height: 240, padding: 0,
    data: [
      { name: 'tree', values: data,
        transform: [
          { type: 'nest', keys: ['label'] },
          { type: 'treemap', field: 'value', method: 'squarify', round: true,
            size: [{ signal: 'width' }, { signal: 'height' }],
            padding: 2 },
        ] },
      { name: 'leaves', source: 'tree', transform: [{ type: 'filter', expr: 'datum.leaf' }] },
    ],
    scales: [
      { name: 'color', type: 'ordinal',
        domain: { data: 'leaves', field: 'label' },
        range: VEGA_COLORS },
    ],
    marks: [
      {
        type: 'rect',
        from: { data: 'leaves' },
        encode: {
          enter: {
            x: { field: 'x0' }, y: { field: 'y0' },
            x2: { field: 'x1' }, y2: { field: 'y1' },
            fill: { scale: 'color', field: 'label' },
            stroke: { value: '#ffffff' }, strokeWidth: { value: 1.5 },
            cornerRadius: { value: 3 },
            tooltip: { signal: `{ ' ': datum.label, 'Value': ${tooltipFmt} }` },
          },
        },
      },
      {
        type: 'text',
        from: { data: 'leaves' },
        encode: {
          enter: {
            x: { signal: '(datum.x0 + datum.x1) / 2' },
            y: { signal: '(datum.y0 + datum.y1) / 2' },
            align: { value: 'center' }, baseline: { value: 'middle' },
            fill: { value: '#ffffff' },
            font: { value: "'Geist', ui-sans-serif, system-ui, sans-serif" },
            fontSize: { value: 11 }, fontWeight: { value: 600 },
            // Hide labels on tiles too small to fit them legibly.
            opacity: { signal: '(datum.x1 - datum.x0 > 56 && datum.y1 - datum.y0 > 22) ? 1 : 0' },
            text: { field: 'label' },
            limit: { signal: 'datum.x1 - datum.x0 - 8' },
          },
        },
      },
    ],
  };
}

// ── Radar (full Vega, via polar-coordinate arc transform) ────────────────────
// Categories evenly spaced around the circle; one polygon mark connects the
// data points; axis spokes + ring grid drawn manually. Same palette as
// everything else.

function radar(rows: Row[], fmt?: string): unknown {
  const data = rows.map((r) => ({ category: str(r.label), value: num(r.value) }));
  const N = data.length || 1;
  const tooltipFmt = fmt === 'currency' ? "'€' + format(datum.value, ',.2f')"
                   : fmt === 'percentage' ? "format(datum.value, ',.2f') + '%'"
                   : "format(datum.value, ',.2f')";
  const radarColor = VEGA_COLORS[3]; // plum, matches old design
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    background: 'transparent',
    autosize: { type: 'none' },
    width: 320, height: 260, padding: 24,
    signals: [
      { name: 'radius', update: 'min(width, height) / 2 - 18' },
      { name: 'cx', update: 'width / 2' },
      { name: 'cy', update: 'height / 2 + 4' },
    ],
    data: [
      { name: 'source', values: data,
        transform: [
          { type: 'window', ops: ['row_number'], as: ['idx'] },
          { type: 'formula', expr: `2 * PI * (datum.idx - 1) / ${N} - PI / 2`, as: 'angle' },
        ] },
      { name: 'maxVal',
        source: 'source',
        transform: [{ type: 'aggregate', fields: ['value'], ops: ['max'], as: ['m'] }] },
      // Concentric grid rings at 25/50/75/100%.
      { name: 'rings', values: [0.25, 0.5, 0.75, 1] },
    ],
    marks: [
      // Grid rings
      {
        type: 'symbol',
        from: { data: 'rings' },
        encode: {
          enter: {
            x: { signal: 'cx' }, y: { signal: 'cy' },
            shape: { value: 'circle' },
            fill: { value: 'transparent' },
            stroke: { value: 'rgba(13,28,47,0.08)' }, strokeWidth: { value: 1 },
            strokeDash: { value: [2, 3] },
            size: { signal: 'pow(radius * datum.data * 2, 2)' },
          },
        },
      },
      // Spokes from centre to each category point
      {
        type: 'rule',
        from: { data: 'source' },
        encode: {
          enter: {
            x: { signal: 'cx' }, y: { signal: 'cy' },
            x2: { signal: 'cx + cos(datum.angle) * radius' },
            y2: { signal: 'cy + sin(datum.angle) * radius' },
            stroke: { value: 'rgba(13,28,47,0.06)' }, strokeWidth: { value: 1 },
          },
        },
      },
      // The radar polygon itself (filled area)
      {
        type: 'line',
        from: { data: 'source' },
        encode: {
          enter: {
            x: { signal: 'cx + cos(datum.angle) * radius * (datum.value / data("maxVal")[0].m)' },
            y: { signal: 'cy + sin(datum.angle) * radius * (datum.value / data("maxVal")[0].m)' },
            stroke: { value: radarColor }, strokeWidth: { value: 2 },
            strokeJoin: { value: 'round' },
            fill: { value: radarColor }, fillOpacity: { value: 0.18 },
            defined: { value: true },
          },
        },
        sort: { field: 'datum.idx' },
      },
      // Vertex dots
      {
        type: 'symbol',
        from: { data: 'source' },
        encode: {
          enter: {
            x: { signal: 'cx + cos(datum.angle) * radius * (datum.value / data("maxVal")[0].m)' },
            y: { signal: 'cy + sin(datum.angle) * radius * (datum.value / data("maxVal")[0].m)' },
            size: { value: 40 },
            fill: { value: radarColor },
            tooltip: { signal: `{ ' ': datum.category, 'Value': ${tooltipFmt} }` },
          },
        },
      },
      // Category labels around the perimeter
      {
        type: 'text',
        from: { data: 'source' },
        encode: {
          enter: {
            x: { signal: 'cx + cos(datum.angle) * (radius + 12)' },
            y: { signal: 'cy + sin(datum.angle) * (radius + 12)' },
            // Right-align labels on the left half, left-align on the right.
            align: { signal: "cos(datum.angle) < -0.3 ? 'right' : cos(datum.angle) > 0.3 ? 'left' : 'center'" },
            baseline: { signal: "sin(datum.angle) < -0.3 ? 'bottom' : sin(datum.angle) > 0.3 ? 'top' : 'middle'" },
            fill: { value: '#6b7680' },
            font: { value: "'Geist', ui-sans-serif, system-ui, sans-serif" },
            fontSize: { value: 11 },
            text: { field: 'category' },
          },
        },
      },
    ],
  };
}
