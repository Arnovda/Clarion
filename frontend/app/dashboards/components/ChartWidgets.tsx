'use client';

import { useState } from 'react';
import {
  BarChart, Bar, Line, PieChart, Pie, Cell,
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

/** Shared axis tick styling — muted ink-3 label in Observatory. */
const TICK = { fontSize: 11, fill: PALETTE.axisLabel };

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
          <button onClick={() => onCrossFilter?.(null)} className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors">
            ← Clear
          </button>
          <p className="text-[11px] text-muted">{drillLabel}</p>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={PALETTE.grid} />
          <XAxis type="number" tickFormatter={yFmt} tick={TICK} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={110} tick={TICK} axisLine={false} tickLine={false} />
          <Tooltip content={<PremiumTooltip format={spec.format} />} />
          <Bar
            dataKey="value"
            radius={[0, 4, 4, 0]}
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
        <p className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 mt-2 text-center">Click a bar to cross-filter</p>
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
        <XAxis dataKey="label" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Bar dataKey="value" fill={SERIES_COLORS[0]} radius={[4, 4, 0, 0]} />
        {hasTarget && (
          <Line type="monotone" dataKey="target" stroke={PALETTE.axisLabel} strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
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
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.18} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.grid} />
        <XAxis dataKey="label" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={TICK} axisLine={false} tickLine={false} />
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
          strokeWidth={2}
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
        <XAxis dataKey="label" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8, color: PALETTE.axisLabel }} />
        {seriesNames.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            stackId="a"
            fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            radius={i === seriesNames.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
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
          fill={PALETTE.series[0].solid}
          fontSize={14}
          fontWeight={600}
        >
          {formatValue(total, spec.format)}
        </text>
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8, color: PALETTE.axisLabel }} />
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
  const overlayColor = getSeriesColor(3); // plum

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
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: overlayColor }} axisLine={false} tickLine={false} />
        <Tooltip content={<PremiumTooltip format={spec.format} />} />
        <Bar yAxisId="left" dataKey="value" fill={`url(#${gradientId})`} radius={[4, 4, 0, 0]} name="Value" />
        {chartData.some((r) => r.line !== undefined) && (
          <Line yAxisId="right" type="monotone" dataKey="line" stroke={overlayColor} strokeWidth={2} dot={{ fill: overlayColor, r: 3 }} name="Rate" />
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
        const barColor = getSeriesColor(i);
        return (
          <div
            key={i}
            onClick={onCrossFilter ? () => onCrossFilter(String(row.label ?? '')) : undefined}
            className={`relative flex items-center justify-between px-3 py-2 rounded-md overflow-hidden transition-colors ${
              onCrossFilter ? 'cursor-pointer hover:bg-softer' : ''
            }`}
          >
            {/* Subtle progress bar background */}
            <div
              className="absolute inset-y-0 left-0 rounded-md"
              style={{
                width: `${pct}%`,
                background: `${barColor}1a`,
              }}
            />
            <div className="relative flex items-center gap-2.5 min-w-0">
              <span
                className="text-[10px] font-mono font-medium w-5 text-right tabular-nums shrink-0"
                style={{ color: barColor }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-[13px] text-ink-2 truncate">
                {String(row.label ?? '\u2014')}
              </span>
            </div>
            <span className="relative text-[13px] font-medium text-ink shrink-0 ml-2 tabular-nums">
              {formatValue(row.value, spec.format)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Safe formula evaluator ──────────────────────────────────────────────────

function evalFormula(expr: string, row: Record<string, unknown>): number | null {
  try {
    // Replace column references with their numeric values
    const colNames = Object.keys(row);
    const values = colNames.map((k) => Number(row[k] ?? 0));
    // Only allow safe characters: alphanumeric, operators, parens, spaces, dots
    if (/[^a-zA-Z0-9_+\-*/().\s]/.test(expr)) return null;
    // eslint-disable-next-line no-new-func
    const fn = new Function(...colNames, `return (${expr})`);
    const result = fn(...values);
    return typeof result === 'number' && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// ─── DataTableWidget ─────────────────────────────────────────────────────────

export function DataTableWidget({
  spec: _spec, data, onCrossFilter,
}: WidgetExecutionProps) {
  const [calcCols, setCalcCols] = useState<Array<{ name: string; expr: string }>>([]);
  const [showFormulaForm, setShowFormulaForm] = useState(false);
  const [formulaName, setFormulaName] = useState('');
  const [formulaExpr, setFormulaExpr] = useState('');
  const [formulaError, setFormulaError] = useState('');

  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  const baseKeys = Object.keys(data.rows[0]);
  const allKeys = [...baseKeys, ...calcCols.map((c) => c.name)];
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const headerLabel = (k: string) => capitalize(k.replace(/_/g, ' '));
  const isNumeric = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
  const firstTextKey = baseKeys.find((k) => !isNumeric(data.rows[0][k]));

  function addFormula() {
    const name = formulaName.trim();
    const expr = formulaExpr.trim();
    if (!name || !expr) { setFormulaError('Name and expression are required.'); return; }
    if (allKeys.includes(name)) { setFormulaError('Column name already exists.'); return; }
    // Test evaluation on first row
    const test = evalFormula(expr, data.rows[0]);
    if (test === null) { setFormulaError('Invalid expression. Use column names and +  -  *  /  ( ).'); return; }
    setCalcCols((c) => [...c, { name, expr }]);
    setFormulaName('');
    setFormulaExpr('');
    setFormulaError('');
    setShowFormulaForm(false);
  }

  return (
    <div>
      {/* Formula bar */}
      <div className="mb-2 flex items-center justify-end gap-2">
        {calcCols.map((c) => (
          <span key={c.name} className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-line bg-softer text-muted">
            {c.name} = {c.expr}
            <button onClick={() => setCalcCols((cols) => cols.filter((x) => x.name !== c.name))} className="text-muted-2 hover:text-err ml-0.5">×</button>
          </span>
        ))}
        <button
          onClick={() => setShowFormulaForm((v) => !v)}
          className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ocean transition-colors"
          title="Add calculated column"
        >
          + formula
        </button>
      </div>

      {showFormulaForm && (
        <div className="mb-3 p-3 rounded-lg border border-line bg-surface space-y-2">
          <div className="flex gap-2">
            <input
              value={formulaName}
              onChange={(e) => setFormulaName(e.target.value)}
              placeholder="Column name"
              className="w-28 px-2 py-1 text-[11px] rounded border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean"
            />
            <span className="text-[11px] text-muted self-center">=</span>
            <input
              value={formulaExpr}
              onChange={(e) => setFormulaExpr(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addFormula(); }}
              placeholder={`e.g. revenue / orders`}
              className="flex-1 px-2 py-1 text-[11px] font-mono rounded border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean"
            />
            <button onClick={addFormula} className="px-2.5 py-1 text-[11px] rounded bg-ocean text-white hover:bg-ocean-hover transition-colors">Add</button>
            <button onClick={() => { setShowFormulaForm(false); setFormulaError(''); }} className="text-[11px] text-muted hover:text-ink-2 transition-colors">Cancel</button>
          </div>
          {formulaError && <p className="text-[10px] text-err">{formulaError}</p>}
          <p className="text-[10px] text-muted">Available columns: {baseKeys.join(', ')}</p>
        </div>
      )}

    <div className="overflow-y-auto rounded-md border border-line" style={{ maxHeight: 300 }}>
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="sticky top-0 bg-softer z-10">
            {allKeys.map((k) => {
              const isCalc = calcCols.some((c) => c.name === k);
              return (
                <th
                  key={k}
                  className={`px-3 py-2 font-mono font-medium text-muted text-[10px] uppercase tracking-[0.08em] border-b border-line whitespace-nowrap ${
                    isNumeric(data.rows[0]?.[k]) || isCalc ? 'text-right' : 'text-left'
                  } ${isCalc ? 'text-ocean' : ''}`}
                >
                  {headerLabel(k)}
                </th>
              );
            })}
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
              className={`border-b border-line last:border-b-0 transition-colors ${
                onCrossFilter ? 'cursor-pointer hover:bg-softer' : ''
              }`}
            >
              {allKeys.map((k) => {
                const calcDef = calcCols.find((c) => c.name === k);
                const rawVal = calcDef ? evalFormula(calcDef.expr, row) : row[k];
                const display = rawVal == null ? '—' : typeof rawVal === 'number' ? rawVal.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(rawVal);
                return (
                  <td
                    key={k}
                    className={`px-3 py-2 text-ink-2 whitespace-nowrap ${
                      isNumeric(rawVal) || calcDef ? 'text-right font-mono tabular-nums' : ''
                    } ${calcDef ? 'text-ocean' : ''}`}
                  >
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

  const radarColor = getSeriesColor(3); // plum

  return (
    <ResponsiveContainer width="100%" height={200}>
      <RadarChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
        <PolarGrid stroke={PALETTE.grid} />
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
    fill = PALETTE.series[0].solid,
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
        rx={4}
      />
      {width > 60 && height > 30 && (
        <>
          <text
            x={x + 10}
            y={y + 20}
            fill="white"
            fontSize={11}
            fontWeight={500}
            style={{ pointerEvents: 'none' }}
          >
            {name.length > 14 ? name.slice(0, 13) + '\u2026' : name}
          </text>
          {height > 44 && (
            <text
              x={x + 10}
              y={y + 34}
              fill="rgba(255,255,255,0.8)"
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

// ─── PivotTableWidget ────────────────────────────────────────────────────────
// SQL must return: row_label, col_label, value
// e.g. SELECT month AS row_label, category AS col_label, SUM(amount) AS value ...

export function PivotTableWidget({ spec, data }: WidgetExecutionProps) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <EmptyWidget />;

  // Build cross-tab structure
  const rowLabels: string[] = [];
  const colLabels: string[] = [];
  const cellMap: Record<string, Record<string, number>> = {};

  for (const r of data.rows) {
    const row = String(r.row_label ?? '');
    const col = String(r.col_label ?? '');
    const val = Number(r.value ?? 0);
    if (!rowLabels.includes(row)) rowLabels.push(row);
    if (!colLabels.includes(col)) colLabels.push(col);
    if (!cellMap[row]) cellMap[row] = {};
    cellMap[row][col] = (cellMap[row][col] ?? 0) + val;
  }

  // Row totals for heat-map intensity
  const rowTotals = rowLabels.map((row) =>
    colLabels.reduce((s, col) => s + (cellMap[row]?.[col] ?? 0), 0),
  );
  const grandTotal = rowTotals.reduce((s, v) => s + v, 0);
  const maxCell = Math.max(
    ...rowLabels.flatMap((row) => colLabels.map((col) => cellMap[row]?.[col] ?? 0)),
    1,
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="text-left px-3 py-1.5 font-medium text-muted border-b border-line sticky left-0 bg-raised min-w-[120px]" />
            {colLabels.map((col) => (
              <th key={col} className="px-3 py-1.5 font-medium text-muted border-b border-line text-right whitespace-nowrap">
                {col}
              </th>
            ))}
            <th className="px-3 py-1.5 font-medium text-muted border-b border-line text-right whitespace-nowrap">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rowLabels.map((row, ri) => {
            const rowTotal = rowTotals[ri];
            return (
              <tr key={row} className="hover:bg-softer transition-colors">
                <td className="px-3 py-1.5 font-medium text-ink-2 border-b border-line sticky left-0 bg-raised truncate max-w-[160px]">
                  {row}
                </td>
                {colLabels.map((col) => {
                  const val = cellMap[row]?.[col] ?? 0;
                  const intensity = Math.round((val / maxCell) * 12);
                  return (
                    <td
                      key={col}
                      className="px-3 py-1.5 text-right border-b border-line font-mono tabular-nums transition-colors"
                      style={{ background: val > 0 ? `rgba(var(--color-ocean-rgb, 37 99 235) / ${intensity * 0.05})` : undefined }}
                    >
                      {val > 0 ? formatValue(val, spec.format) : <span className="text-muted-2">—</span>}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right border-b border-line font-medium font-mono tabular-nums text-ink-2">
                  {formatValue(rowTotal, spec.format)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-softer">
            <td className="px-3 py-1.5 font-medium text-ink-2 sticky left-0 bg-softer">Total</td>
            {colLabels.map((col) => {
              const colTotal = rowLabels.reduce((s, row) => s + (cellMap[row]?.[col] ?? 0), 0);
              return (
                <td key={col} className="px-3 py-1.5 text-right font-medium font-mono tabular-nums text-ink-2">
                  {formatValue(colTotal, spec.format)}
                </td>
              );
            })}
            <td className="px-3 py-1.5 text-right font-bold font-mono tabular-nums text-ink">
              {formatValue(grandTotal, spec.format)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
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
