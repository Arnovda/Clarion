'use client';

import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  Treemap,
} from 'recharts';
import type { WidgetExecutionProps } from '../types';
import { SERIES_COLORS, PALETTE, getSeriesColor } from '../utils/chart-theme';
import { formatValue } from '../utils/format';
import { PremiumTooltip } from './PremiumTooltip';
import { ChartSkeleton, WidgetSkeleton, WidgetError, EmptyWidget } from './WidgetSkeletons';

// ─── Shared axis formatter ──────────────────────────────────────────────────

function yAxisFormatter(maxVal: number) {
  return (v: number) =>
    maxVal > 10000
      ? `\u20AC${(v / 1000).toFixed(0)}k`
      : maxVal > 1000
        ? `\u20AC${(v / 1000).toFixed(1)}k`
        : String(v);
}

// ─── BarChartWidget (horizontal bars) ────────────────────────────────────────

export function BarChartWidget({
  spec, data, onCrossFilter, isCrossFilterActive, drillLabel,
}: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r) => ({
    label: String(r.label ?? ''),
    value: Number(r.value ?? 0),
  }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const height = Math.max(180, Math.min(chartData.length * 36 + 48, 320));
  const yFmt = (v: number) => (maxVal > 1000 ? `\u20AC${(v / 1000).toFixed(1)}k` : String(v));

  return (
    <div>
      {isCrossFilterActive && drillLabel && (
        <div className="mb-3 flex items-center gap-2">
          <button onClick={() => onCrossFilter?.(null)} className="text-xs text-blue-600 hover:text-blue-800 transition-colors">
            ← Clear
          </button>
          <p className="text-xs text-slate-500 text-slate-400">{drillLabel}</p>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={PALETTE.grid} />
          <XAxis type="number" tickFormatter={yFmt} tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
          <Tooltip content={<PremiumTooltip format={spec.format} />} />
          <Bar
            dataKey="value"
            radius={[0, 6, 6, 0]}
            cursor={onCrossFilter ? 'pointer' : undefined}
            onClick={onCrossFilter ? (entry) => onCrossFilter(String((entry as unknown as Record<string, unknown>).label)) : undefined}
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {onCrossFilter && !isCrossFilterActive && (
        <p className="text-xs text-slate-400 mt-1 text-center">Click a bar to cross-filter</p>
      )}
    </div>
  );
}

// ─── VerticalBarChartWidget ──────────────────────────────────────────────────

export function VerticalBarChartWidget({
  spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r) => ({
    label: String(r.label ?? ''),
    value: Number(r.value ?? 0),
    target: r.target !== undefined ? Number(r.target) : undefined,
  }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const yFmt = yAxisFormatter(maxVal);
  const hasTarget = chartData.some((r) => r.target !== undefined);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart
        data={chartData}
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        barCategoryGap="30%"
        onClick={onCrossFilter ? (d) => { if (d?.activeLabel) onCrossFilter(String(d.activeLabel)); } : undefined}
        style={{ cursor: onCrossFilter ? 'pointer' : undefined }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={PALETTE.grid} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Bar dataKey="value" fill={SERIES_COLORS[0]} radius={[6, 6, 0, 0]} />
        {hasTarget && (
          <Line type="monotone" dataKey="target" stroke="#64748b" strokeWidth={2} strokeDasharray="4 2" dot={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── LineChartWidget ─────────────────────────────────────────────────────────

export function LineChartWidget({
  spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r) => ({
    label: String(r.label ?? ''),
    value: Number(r.value ?? 0),
  }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const yFmt = yAxisFormatter(maxVal);
  const gradientId = `line-area-${spec.id}`;
  const lineColor = getSeriesColor(0);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart
        data={chartData}
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        onClick={onCrossFilter ? (d) => { if (d?.activeLabel) onCrossFilter(String(d.activeLabel)); } : undefined}
        style={{ cursor: onCrossFilter ? 'pointer' : undefined }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.15} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.grid} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Area
          type="monotone"
          dataKey="value"
          fill={`url(#${gradientId})`}
          stroke="none"
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={lineColor}
          strokeWidth={2.5}
          dot={{ r: 3, fill: lineColor, strokeWidth: 0 }}
          activeDot={{ r: 5, strokeWidth: 0 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── StackedBarChartWidget ───────────────────────────────────────────────────

export function StackedBarChartWidget({
  spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  // Pivot tidy format (label, series, value) -> { label, [series]: value }
  const labels = Array.from(new Set(data.rows.map((r) => String(r.label ?? ''))));
  const seriesNames = Array.from(new Set(data.rows.map((r) => String(r.series ?? ''))));
  const pivoted = labels.map((label) => {
    const row: Record<string, unknown> = { label };
    for (const s of seriesNames) {
      const match = data.rows.find(
        (r) => String(r.label) === label && String(r.series) === s,
      );
      row[s] = match ? Number(match.value ?? 0) : 0;
    }
    return row;
  });

  const maxVal = pivoted.reduce((acc, row) => {
    const total = seriesNames.reduce((s, k) => s + Number(row[k] ?? 0), 0);
    return Math.max(acc, total);
  }, 0);
  const yFmt = yAxisFormatter(maxVal);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={pivoted}
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        barCategoryGap="30%"
        onClick={onCrossFilter ? (d) => { if (d?.activeLabel) onCrossFilter(String(d.activeLabel)); } : undefined}
        style={{ cursor: onCrossFilter ? 'pointer' : undefined }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={PALETTE.grid} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        {seriesNames.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            stackId="a"
            fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            radius={i === seriesNames.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── PieChartWidget (donut) ──────────────────────────────────────────────────

export function PieChartWidget({
  spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r) => ({
    name: String(r.label ?? ''),
    value: Number(r.value ?? 0),
  }));
  const total = chartData.reduce((s, d) => s + d.value, 0);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="45%"
          innerRadius={55}
          outerRadius={80}
          label={({ name, percent }: { name?: string; percent?: number }) =>
            `${name ?? ''} (${((percent ?? 0) * 100).toFixed(0)}%)`
          }
          labelLine={false}
          cursor={onCrossFilter ? 'pointer' : undefined}
          onClick={
            onCrossFilter
              ? (entry) => onCrossFilter(String(entry.name))
              : undefined
          }
        >
          {chartData.map((_, i) => (
            <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
          ))}
        </Pie>
        {/* Center total label */}
        <text
          x="50%"
          y="45%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-slate-700"
          fontSize={14}
          fontWeight={700}
        >
          {formatValue(total, spec.format)}
        </text>
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── ComboChartWidget (bar + line overlay) ───────────────────────────────────

export function ComboChartWidget({ spec, data }: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r) => ({
    label: String(r.label ?? ''),
    value: Number(r.value ?? 0),
    line: r.line !== undefined ? Number(r.line) : undefined,
  }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 1);
  const yFmt = yAxisFormatter(maxVal);
  const gradientId = `combo-${spec.id}`;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={chartData} margin={{ left: 4, right: 24, top: 4, bottom: 20 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES_COLORS[0]} stopOpacity={0.9} />
            <stop offset="100%" stopColor={SERIES_COLORS[0]} stopOpacity={0.6} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.grid} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} angle={-30} textAnchor="end" />
        <YAxis yAxisId="left" tickFormatter={yFmt} tick={{ fontSize: 10, fill: PALETTE.axisLabel }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#a855f7' }} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Bar yAxisId="left" dataKey="value" fill={`url(#${gradientId})`} radius={[6, 6, 0, 0]} name="Value" />
        {chartData.some((r) => r.line !== undefined) && (
          <Line yAxisId="right" type="monotone" dataKey="line" stroke="#a855f7" strokeWidth={2.5} dot={{ fill: '#a855f7', r: 3 }} name="Rate" />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── TopListWidget ───────────────────────────────────────────────────────────

export function TopListWidget({
  spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const rows = data.rows.slice(0, 10);
  const maxVal = Math.max(...rows.map((r) => Number(r.value ?? 0)), 1);

  return (
    <div className="space-y-1">
      {rows.map((row, i) => {
        const numVal = Number(row.value ?? 0);
        const pct = (numVal / maxVal) * 100;
        return (
          <div
            key={i}
            onClick={onCrossFilter ? () => onCrossFilter(String(row.label ?? '')) : undefined}
            className={`relative flex items-center justify-between px-3.5 py-2.5 rounded-xl transition-all overflow-hidden
              ${onCrossFilter ? 'cursor-pointer hover:scale-[1.01]' : ''}
              ${i % 2 === 0 ? 'bg-slate-50/80' : 'bg-white/40'}`}
          >
            {/* Progress bar background — visible gradient */}
            <div
              className="absolute inset-y-0 left-0 rounded-xl transition-all duration-700"
              style={{
                width: `${pct}%`,
                background: `linear-gradient(90deg, ${getSeriesColor(i)}18, ${getSeriesColor(i)}06)`,
              }}
            />
            <div className="relative flex items-center gap-2.5 min-w-0">
              <span
                className="text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0 tabular-nums"
                style={{ background: `${getSeriesColor(i)}15`, color: getSeriesColor(i) }}
              >
                {i + 1}
              </span>
              <span className="text-sm font-medium text-slate-700 truncate">
                {String(row.label ?? '\u2014')}
              </span>
            </div>
            <span className="relative text-sm font-bold text-slate-900 shrink-0 ml-2 tabular-nums">
              {formatValue(row.value, spec.format)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── DataTableWidget ─────────────────────────────────────────────────────────

export function DataTableWidget({
  spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const keys = Object.keys(data.rows[0]);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const headerLabel = (k: string) => capitalize(k.replace(/_/g, ' '));
  const isNumeric = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
  const firstTextKey = keys.find((k) => !isNumeric(data.rows[0][k]));

  return (
    <div className="overflow-y-auto rounded-xl" style={{ maxHeight: 300 }}>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="sticky top-0 bg-slate-50/95 backdrop-blur-sm z-10">
            {keys.map((k) => (
              <th
                key={k}
                className={`px-3.5 py-2.5 text-left font-bold text-slate-500 text-[10px] uppercase tracking-wider border-b border-slate-200/60 whitespace-nowrap
                  ${isNumeric(data.rows[0]?.[k]) ? 'text-right' : ''}`}
              >
                {headerLabel(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr
              key={i}
              onClick={
                onCrossFilter && firstTextKey
                  ? () => onCrossFilter(String(row[firstTextKey] ?? ''))
                  : undefined
              }
              className={`transition-all border-b border-slate-100/40
                ${onCrossFilter ? 'cursor-pointer hover:bg-indigo-50/50' : ''}
                ${i % 2 === 0 ? 'bg-white/60' : 'bg-slate-50/30'}`}
            >
              {keys.map((k) => (
                <td
                  key={k}
                  className={`px-3.5 py-2.5 text-slate-700 whitespace-nowrap
                    ${isNumeric(row[k]) ? 'text-right font-mono tabular-nums font-semibold' : ''}`}
                >
                  {String(row[k] ?? '\u2014')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── RadarChartWidget ────────────────────────────────────────────────────────

export function RadarChartWidget({ spec, data }: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r) => ({
    subject: String(r.label ?? ''),
    value: Number(r.value ?? 0),
    fullMark: Math.max(...data.rows.map((x) => Number(x.value ?? 0))) * 1.2,
  }));

  const radarColor = getSeriesColor(4); // Violet

  return (
    <ResponsiveContainer width="100%" height={200}>
      <RadarChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
        <PolarGrid stroke="rgba(148,163,184,0.20)" />
        <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: PALETTE.axisLabel }} />
        <PolarRadiusAxis tick={false} axisLine={false} />
        <Radar
          name={spec.title}
          dataKey="value"
          stroke={radarColor}
          fill={radarColor}
          fillOpacity={0.2}
          strokeWidth={2}
        />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

// ─── TreemapWidget ───────────────────────────────────────────────────────────

function CustomTreemapContent(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  fill?: string;
  size?: number;
  format?: string;
}) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    name = '',
    fill = '#6366f1',
    size = 0,
    format,
  } = props;
  if (width < 30 || height < 20) return null;
  return (
    <g>
      <rect
        x={x + 1}
        y={y + 1}
        width={width - 2}
        height={height - 2}
        fill={fill}
        fillOpacity={0.85}
        rx={6}
      />
      {width > 60 && height > 30 && (
        <>
          <text
            x={x + 10}
            y={y + 20}
            fill="white"
            fontSize={11}
            fontWeight={600}
            style={{ pointerEvents: 'none' }}
          >
            {name.length > 14 ? name.slice(0, 13) + '\u2026' : name}
          </text>
          {height > 44 && (
            <text
              x={x + 10}
              y={y + 34}
              fill="rgba(255,255,255,0.75)"
              fontSize={9}
              style={{ pointerEvents: 'none' }}
            >
              {formatValue(size, format)}
            </text>
          )}
        </>
      )}
    </g>
  );
}

export function TreemapWidget({ spec, data }: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const chartData = data.rows.map((r, i) => ({
    name: String(r.label ?? ''),
    size: Number(r.value ?? 0),
    fill: SERIES_COLORS[i % SERIES_COLORS.length],
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <Treemap
        data={chartData}
        dataKey="size"
        aspectRatio={4 / 3}
        content={<CustomTreemapContent format={spec.format} />}
      >
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
      </Treemap>
    </ResponsiveContainer>
  );
}
