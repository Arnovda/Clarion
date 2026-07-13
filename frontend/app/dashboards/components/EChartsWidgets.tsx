'use client';

// ─── ECharts-rendered widgets ────────────────────────────────────────────────
// scatter_chart + bullet_chart — the analyst-cockpit vocabulary from the
// retained design mockups (design-mockups/B-analyst-cockpit.html). These are
// the chart types Recharts can't do well (no native bullet; scatter without
// zoom/decimation), so they render through the tree-shaken ECharts engine
// behind the SAME widget DSL. The AI never sees the library — it only emits
// {type, sql} and these components consume the contract columns
// (shared REQUIRED_WIDGET_COLUMNS: scatter = label/x/y[/size],
// bullet = label/value/target).

import { EChart } from './EChart';
import type { EChartsOption } from '../utils/echartsSetup';
import { PALETTE, getSeriesColor } from '../utils/chart-theme';
import { formatValue } from '../utils/format';
import { ChartSkeleton, WidgetError, EmptyWidget } from './WidgetSkeletons';
import type { WidgetExecutionProps } from '../types';

/** Visible contract failure — never render a silently-empty chart. */
function missingColumns(rows: Record<string, unknown>[], required: string[]): string[] {
  if (!rows.length) return [];
  const present = new Set(Object.keys(rows[0]).map((k) => k.toLowerCase()));
  return required.filter((c) => !present.has(c));
}

// ─── ScatterChartWidget ──────────────────────────────────────────────────────
// Correlation between two measures across entities. Optional "size" column
// drives bubble area (sqrt-scaled so area, not radius, encodes the value).

export function ScatterChartWidget({
  spec,
  data,
  onCrossFilter,
}: WidgetExecutionProps & { onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const missing = missingColumns(data.rows, ['label', 'x', 'y']);
  if (missing.length) {
    return <WidgetError msg={`Chart data is missing column(s): ${missing.join(', ')}`} />;
  }

  const points = data.rows.map((r) => ({
    name: String(r.label ?? ''),
    value: [Number(r.x ?? 0), Number(r.y ?? 0)],
    size: r.size !== undefined ? Number(r.size) : undefined,
  }));
  const maxSize = Math.max(...points.map((p) => p.size ?? 0), 1);

  const option: EChartsOption = {
    xAxis: { type: 'value', name: '', scale: true },
    yAxis: { type: 'value', name: '', scale: true },
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { name: string; value: [number, number] };
        return `<strong>${p.name}</strong><br/>${formatValue(p.value[0], 'number')} · ${formatValue(p.value[1], spec.format)}`;
      },
    },
    series: [
      {
        type: 'scatter',
        data: points,
        symbolSize: (val: unknown, params: { data?: { size?: number } }) =>
          params.data?.size !== undefined
            ? 6 + 22 * Math.sqrt(params.data.size / maxSize)
            : 10,
        itemStyle: { color: getSeriesColor(0), opacity: 0.75 },
        emphasis: { itemStyle: { opacity: 1 } },
      },
    ],
  };

  return (
    <EChart
      option={option}
      height={spec.featured ? 300 : 220}
      onPointClick={onCrossFilter ? (label) => onCrossFilter(label) : undefined}
    />
  );
}

// ─── BulletChartWidget ───────────────────────────────────────────────────────
// Actual vs target per category — a wide light bar shows the target, a
// narrower solid bar shows the actual, coloured by attainment (>=100% green,
// >=75% amber, below red). Matches the finance/ops domain colour rules in
// the dashboard prompt.

export function BulletChartWidget({
  spec,
  data,
  onCrossFilter,
}: WidgetExecutionProps & { onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const missing = missingColumns(data.rows, ['label', 'value', 'target']);
  if (missing.length) {
    return <WidgetError msg={`Chart data is missing column(s): ${missing.join(', ')}`} />;
  }

  const rows = data.rows.slice(0, 12);
  const labels = rows.map((r) => String(r.label ?? ''));
  const values = rows.map((r) => Number(r.value ?? 0));
  const targets = rows.map((r) => Number(r.target ?? 0));

  const attainmentColor = (value: number, target: number): string => {
    if (target <= 0) return getSeriesColor(0);
    const ratio = value / target;
    if (ratio >= 1) return PALETTE.positive.solid;
    if (ratio >= 0.75) return getSeriesColor(2); // amber
    return PALETTE.negative.solid;
  };

  const option: EChartsOption = {
    // Categories top-to-bottom in SQL order (yAxis inverse keeps rank order)
    yAxis: { type: 'category', data: labels, inverse: true },
    xAxis: { type: 'value' },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'none' },
      formatter: (params: unknown) => {
        const list = params as Array<{ name: string; seriesName: string; value: number }>;
        if (!list.length) return '';
        const byName = Object.fromEntries(list.map((p) => [p.seriesName, p.value]));
        const v = byName['Actual'] ?? 0;
        const t = byName['Target'] ?? 0;
        const pct = t > 0 ? ` (${Math.round((v / t) * 100)}% of target)` : '';
        return `<strong>${list[0].name}</strong><br/>Actual: ${formatValue(v, spec.format)}${pct}<br/>Target: ${formatValue(t, spec.format)}`;
      },
    },
    series: [
      {
        name: 'Target',
        type: 'bar',
        data: targets,
        barWidth: 18,
        itemStyle: { color: 'rgba(13, 28, 47, 0.08)', borderRadius: 2 },
        silent: false,
        z: 1,
      },
      {
        name: 'Actual',
        type: 'bar',
        data: values.map((v, i) => ({
          value: v,
          itemStyle: { color: attainmentColor(v, targets[i]), borderRadius: 2 },
        })),
        barWidth: 8,
        barGap: '-72%', // overlay the actual bar inside the target backdrop
        z: 2,
      },
    ],
  };

  // ~34px per category keeps the bullets readable at any row count
  const height = Math.max(140, Math.min(360, rows.length * 34 + 40));

  return (
    <EChart
      option={option}
      height={height}
      onPointClick={onCrossFilter ? (label) => onCrossFilter(label) : undefined}
    />
  );
}
