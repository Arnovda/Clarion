'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ReferenceLine, RadarChart, Radar, PolarGrid, PolarAngleAxis,
  PolarRadiusAxis, RadialBarChart, RadialBar, Treemap,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FilterSpec {
  id: string;
  type: 'date_range' | 'select';
  label: string;
  table: string;
  column: string;
  allLabel?: string;
}

interface WidgetSpec {
  id: string;
  type: 'kpi_card' | 'bar_chart' | 'vertical_bar_chart' | 'stacked_bar_chart' | 'line_chart' | 'pie_chart' | 'top_list' | 'data_table' | 'combo_chart' | 'radar_chart' | 'treemap_chart';
  title: string;
  sql: string;
  drillDownSql?: string;
  drillDownLabel?: string;
  format?: 'currency' | 'number' | 'percentage';
  colSpan?: 1 | 2 | 3 | 4;
  featured?: boolean;
  crossFilterKey?: string;  // SQL column name emitted as {{xf_<key>}} when clicked
}

interface DashboardSpec {
  title: string;
  description: string;
  filters: FilterSpec[];
  widgets: WidgetSpec[];
}

interface SavedDashboard {
  id: number;
  title: string;
  description: string;
  is_favorite: boolean;
  is_shared: boolean;
  shared_permission: string;
  folder: string | null;
  auto_refresh_seconds: number | null;
  user_id: string;
  is_owner: boolean;
  permission: 'owner' | 'editor' | 'viewer';
  created_at: string;
  updated_at: string;
}

interface DashboardTemplate {
  id: number;
  name: string;
  description: string;
  category: string;
  created_at: string;
}

interface WidgetData {
  rows: Record<string, unknown>[];
  loading: boolean;
  error?: string;
}

interface DrillState {
  widgetId: string;
  key: string;    // crossFilterKey → passed as xf_<key> to all widget executions
  value: string;
  label: string;
}

interface RefinementQuestion {
  question: string;
  suggestions: string[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  type: 'query' | 'refine';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHART_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ef4444', '#06b6d4', '#84cc16', '#f97316',
];

const TYPE_ACCENT: Record<string, string> = {
  kpi_card:           '#6366f1',
  bar_chart:          '#3b82f6',
  vertical_bar_chart: '#10b981',
  stacked_bar_chart:  '#f59e0b',
  line_chart:         '#06b6d4',
  pie_chart:          '#8b5cf6',
  top_list:           '#ef4444',
  data_table:         '#64748b',
  combo_chart:        '#0ea5e9',
  radar_chart:        '#a855f7',
  treemap_chart:      '#10b981',
};

// ─── Utility functions ────────────────────────────────────────────────────────

function formatValue(v: unknown, format?: string): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (isNaN(n)) return String(v);
  if (format === 'currency' || (format !== 'number' && format !== 'percentage' && Math.abs(n) >= 100)) {
    return '€' + n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === 'percentage') return n.toLocaleString('nl-BE', { maximumFractionDigits: 1 }) + '%';
  return n.toLocaleString('nl-BE', { maximumFractionDigits: 2 });
}

function buildDefaultFilters(filters: FilterSpec[]): Record<string, string> {
  const values: Record<string, string> = {};
  const today = new Date();
  const yearAgo = new Date(today);
  yearAgo.setFullYear(today.getFullYear() - 1);
  for (const f of filters) {
    if (f.type === 'date_range') {
      values[`${f.id}_from`] = yearAgo.toISOString().slice(0, 10);
      values[`${f.id}_to`] = today.toISOString().slice(0, 10);
    } else {
      values[f.id] = 'all';
    }
  }
  return values;
}

function relTime(ts: string): string {
  const d = Date.now() - new Date(ts).getTime();
  const m = Math.floor(d / 60000);
  const h = Math.floor(d / 3600000);
  const dy = Math.floor(d / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${dy}d ago`;
}

// ─── CustomTooltip ────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label, format }: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
  label?: string;
  format?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm border border-black/10 dark:border-white/10 rounded-xl shadow-xl px-3 py-2 text-xs">
      {label && <p className="font-semibold text-slate-700 dark:text-slate-200 mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="text-slate-600 dark:text-slate-300" style={{ color: p.color }}>
          {p.name ? `${p.name}: ` : ''}{formatValue(p.value, format)}
        </p>
      ))}
    </div>
  );
}

// ─── Markdown renderer (bold + tables) ───────────────────────────────────────

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
  );
}

function MarkdownAnswer({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table: header row followed by separator row (|---|)
    if (line.trim().startsWith('|') && lines[i + 1]?.trim().startsWith('|---')) {
      const headers = line.split('|').map(c => c.trim()).filter(Boolean);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].split('|').map(c => c.trim()).filter(Boolean));
        i++;
      }
      elements.push(
        <div key={`t${i}`} className="overflow-x-auto mt-2 mb-1">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>
                {headers.map((h, j) => (
                  <th key={j} className="px-2 py-1 text-left font-semibold bg-slate-100 border border-slate-200 whitespace-nowrap">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, j) => (
                <tr key={j} className={j % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                  {row.map((cell, k) => (
                    <td key={k} className="px-2 py-1 border border-slate-200 whitespace-nowrap">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (line.trim()) {
      elements.push(<p key={`p${i}`} className="mb-1">{renderInline(line)}</p>);
      i++;
    } else {
      i++;
    }
  }

  return <div className="text-sm leading-relaxed">{elements}</div>;
}

// ─── Widget card wrapper ──────────────────────────────────────────────────────

function WidgetCard({
  spec, colSpan, children, isFiltered, isCrossFilterSource,
}: {
  spec: WidgetSpec;
  colSpan: number;
  children: React.ReactNode;
  isFiltered?: boolean;
  isCrossFilterSource?: boolean;
}) {
  const isKpi   = spec.type === 'kpi_card';
  const accent  = TYPE_ACCENT[spec.type] ?? '#6366f1';
  const featured = spec.featured;

  return (
    <div
      style={{
        gridColumn: `span ${colSpan}`,
        gridRow: featured ? 'span 2' : undefined,
      }}
      className={`rounded-2xl overflow-hidden transition-all duration-300 flex flex-col
        backdrop-blur-md border
        ${isCrossFilterSource
          ? 'bg-white/85 dark:bg-slate-800/80 border-indigo-300/60 dark:border-indigo-500/40 shadow-[0_0_0_2px_rgba(99,102,241,0.25),0_8px_32px_rgba(99,102,241,0.12)]'
          : isFiltered
          ? 'bg-white/50 dark:bg-slate-800/40 border-white/30 dark:border-slate-700/30 shadow-sm opacity-55'
          : 'bg-white/80 dark:bg-slate-800/70 border-white/60 dark:border-slate-700/40 shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_4px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_32px_rgba(0,0,0,0.10),0_2px_8px_rgba(0,0,0,0.06)] hover:-translate-y-0.5'
        }`}
    >
      {/* Colored accent bar */}
      <div className="h-0.5 w-full shrink-0" style={{ background: isCrossFilterSource ? '#6366f1' : accent }} />

      {/* Card header (non-KPI only) */}
      {!isKpi && (
        <div className="px-4 py-2 border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
            <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 truncate">{spec.title}</h3>
          </div>
          {isCrossFilterSource && (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md"
              style={{ color: '#6366f1', background: 'rgba(99,102,241,0.10)' }}>
              Filtering
            </span>
          )}
        </div>
      )}

      <div className={`flex-1 ${isKpi ? 'p-4' : 'p-3'}`}>{children}</div>
    </div>
  );
}

// ─── Loading / error helpers ──────────────────────────────────────────────────

function WidgetSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-3 bg-slate-100 dark:bg-slate-700 rounded-full w-1/3" />
      <div className="h-10 bg-slate-100 dark:bg-slate-700 rounded-lg w-2/3" />
      <div className="h-3 bg-slate-100 dark:bg-slate-700 rounded-full w-1/2" />
    </div>
  );
}

function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="animate-pulse flex items-end gap-2 px-2" style={{ height }}>
      {[65, 40, 80, 55, 90, 35, 70, 50].map((h, i) => (
        <div key={i} className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-t-sm" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

function WidgetError({ msg }: { msg: string }) {
  return <p className="text-xs text-red-500">{msg}</p>;
}

// ─── KpiCard ─────────────────────────────────────────────────────────────────

function KpiCard({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  const row = data.rows[0] ?? {};
  const val = row.value;
  const delta = row.delta !== undefined && row.delta !== null ? Number(row.delta) : null;
  const deltaLabel = row.delta_label ? String(row.delta_label) : 'vs prior period';
  const isPositive = delta !== null && delta > 0;
  const isNegative = delta !== null && delta < 0;

  return (
    <div>
      <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-1">{spec.title}</p>
      <p className="text-3xl font-bold text-slate-900 dark:text-slate-100">{formatValue(val, spec.format)}</p>
      <div className="mt-2 flex items-center gap-1.5">
        {delta !== null ? (
          <>
            <span className={`text-xs font-semibold ${isPositive ? 'text-emerald-600' : isNegative ? 'text-red-500' : 'text-slate-400'}`}>
              {isPositive ? '▲' : isNegative ? '▼' : '—'} {Math.abs(delta).toFixed(1)}%
            </span>
            <span className="text-xs text-slate-400">{deltaLabel}</span>
          </>
        ) : (
          <>
            <span className="inline-block w-2 h-2 rounded-full bg-blue-400" />
            <span className="text-xs text-slate-400">Current period</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── BarChartWidget ──────────────────────────────────────────────────────────

function BarChartWidget({
  spec, data, onCrossFilter, isCrossFilterActive, drillLabel,
}: {
  spec: WidgetSpec;
  data: WidgetData;
  onCrossFilter?: (value: string | null) => void;
  isCrossFilterActive?: boolean;
  drillLabel?: string;
}) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  const chartData = data.rows.map((r) => ({ label: String(r.label ?? ''), value: Number(r.value ?? 0) }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const height = Math.max(180, Math.min(chartData.length * 36 + 48, 320));
  const yFmt = (v: number) => (maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v));

  return (
    <div>
      {isCrossFilterActive && drillLabel && (
        <div className="mb-3 flex items-center gap-2">
          <button onClick={() => onCrossFilter?.(null)} className="text-xs text-blue-600 hover:text-blue-800">← Clear</button>
          <p className="text-xs text-slate-500 dark:text-slate-400">{drillLabel}</p>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(148,163,184,0.15)" />
          <XAxis type="number" tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v: number) => [formatValue(v, spec.format), spec.title]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
          <Bar
            dataKey="value"
            radius={[0, 4, 4, 0]}
            cursor={onCrossFilter ? 'pointer' : undefined}
            onClick={onCrossFilter ? (entry) => onCrossFilter(String(entry.label)) : undefined}
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {onCrossFilter && !isCrossFilterActive && (
        <p className="text-xs text-slate-400 dark:text-slate-600 mt-1 text-center">Click a bar to cross-filter</p>
      )}
    </div>
  );
}

// ─── LineChartWidget ──────────────────────────────────────────────────────────

function LineChartWidget({ spec, data, onCrossFilter }: { spec: WidgetSpec; data: WidgetData; onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  const chartData = data.rows.map((r) => ({ label: String(r.label ?? ''), value: Number(r.value ?? 0) }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const yFmt = (v: number) => (maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        onClick={onCrossFilter ? (d) => { if (d?.activeLabel) onCrossFilter(String(d.activeLabel)); } : undefined}
        style={{ cursor: onCrossFilter ? 'pointer' : undefined }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v: number) => [formatValue(v, spec.format), spec.title]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
        <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3, fill: '#3b82f6' }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── VerticalBarChartWidget ───────────────────────────────────────────────────

function VerticalBarChartWidget({ spec, data, onCrossFilter }: { spec: WidgetSpec; data: WidgetData; onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  const chartData = data.rows.map((r) => ({
    label: String(r.label ?? ''),
    value: Number(r.value ?? 0),
    target: r.target !== undefined ? Number(r.target) : undefined,
  }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const yFmt = (v: number) => (maxVal > 10000 ? `€${(v / 1000).toFixed(0)}k` : maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v));

  const hasTarget = chartData.some((r) => r.target !== undefined);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={chartData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="30%"
        onClick={onCrossFilter ? (d) => { if (d?.activeLabel) onCrossFilter(String(d.activeLabel)); } : undefined}
        style={{ cursor: onCrossFilter ? 'pointer' : undefined }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.15)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v: number, name: string) => [formatValue(v, spec.format), name === 'value' ? spec.title : 'Target']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
        <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
        {hasTarget && (
          <Line type="monotone" dataKey="target" stroke="#64748b" strokeWidth={2} strokeDasharray="4 2" dot={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── StackedBarChartWidget ─────────────────────────────────────────────────────

function StackedBarChartWidget({ spec, data, onCrossFilter }: { spec: WidgetSpec; data: WidgetData; onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  // Pivot tidy format (label, series, value) → { label, [series]: value }
  const labels = [...new Set(data.rows.map((r) => String(r.label ?? '')))];
  const seriesNames = [...new Set(data.rows.map((r) => String(r.series ?? '')))];
  const pivoted = labels.map((label) => {
    const row: Record<string, unknown> = { label };
    for (const s of seriesNames) {
      const match = data.rows.find((r) => String(r.label) === label && String(r.series) === s);
      row[s] = match ? Number(match.value ?? 0) : 0;
    }
    return row;
  });

  const maxVal = pivoted.reduce((acc, row) => {
    const total = seriesNames.reduce((s, k) => s + Number(row[k] ?? 0), 0);
    return Math.max(acc, total);
  }, 0);
  const yFmt = (v: number) => (maxVal > 10000 ? `€${(v / 1000).toFixed(0)}k` : maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={pivoted} margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="30%"
        onClick={onCrossFilter ? (d) => { if (d?.activeLabel) onCrossFilter(String(d.activeLabel)); } : undefined}
        style={{ cursor: onCrossFilter ? 'pointer' : undefined }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.15)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v: number, name: string) => [formatValue(v, spec.format), name]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        {seriesNames.map((s, i) => (
          <Bar key={s} dataKey={s} stackId="a" fill={CHART_COLORS[i % CHART_COLORS.length]} radius={i === seriesNames.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── PieChartWidget ──────────────────────────────────────────────────────────

function PieChartWidget({ spec, data, onCrossFilter }: { spec: WidgetSpec; data: WidgetData; onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  const chartData = data.rows.map((r) => ({ name: String(r.label ?? ''), value: Number(r.value ?? 0) }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="45%"
          outerRadius={80}
          label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
          labelLine={false}
          cursor={onCrossFilter ? 'pointer' : undefined}
          onClick={onCrossFilter ? (entry) => onCrossFilter(String(entry.name)) : undefined}
        >
          {chartData.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => [formatValue(v, spec.format)]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── TopListWidget ────────────────────────────────────────────────────────────

function TopListWidget({ spec, data, onCrossFilter }: { spec: WidgetSpec; data: WidgetData; onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  const rows = data.rows.slice(0, 10);

  return (
    <div className="space-y-0.5">
      {rows.map((row, i) => (
        <div
          key={i}
          onClick={onCrossFilter ? () => onCrossFilter(String(row.label ?? '')) : undefined}
          className={`flex items-center justify-between px-2 py-1.5 rounded-md transition-colors
            ${onCrossFilter ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : ''}
            ${i % 2 === 0 ? 'bg-slate-50 dark:bg-slate-700/40' : 'bg-white dark:bg-slate-800/40'}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-slate-400 dark:text-slate-500 w-5 shrink-0">{i + 1}.</span>
            <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{String(row.label ?? '—')}</span>
          </div>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 shrink-0 ml-2">
            {formatValue(row.value, spec.format)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Combo Chart (Bar + Line overlay) ────────────────────────────────────────

function ComboChartWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error)   return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500 py-8 text-center">No data</p>;

  const chartData = data.rows.map((r) => ({
    label: String(r.label ?? ''),
    value: Number(r.value ?? 0),
    line:  r.line !== undefined ? Number(r.line) : undefined,
  }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 1);
  const yFmt = (v: number) =>
    maxVal > 10000 ? `€${(v / 1000).toFixed(0)}k`
    : maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k`
    : String(v);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={chartData} margin={{ left: 4, right: 24, top: 4, bottom: 20 }}>
        <defs>
          <linearGradient id={`combo-${spec.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.9} />
            <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.6} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} angle={-30} textAnchor="end" />
        <YAxis yAxisId="left" tickFormatter={yFmt} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#a855f7' }} axisLine={false} tickLine={false} />
        <Tooltip content={<CustomTooltip format={spec.format} />} />
        <Bar yAxisId="left" dataKey="value" fill={`url(#combo-${spec.id})`} radius={[4, 4, 0, 0]} name="Value" />
        {chartData.some((r) => r.line !== undefined) && (
          <Line yAxisId="right" type="monotone" dataKey="line" stroke="#a855f7" strokeWidth={2.5} dot={{ fill: '#a855f7', r: 3 }} name="Rate" />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── Radar Chart ─────────────────────────────────────────────────────────────

function RadarChartWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error)   return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500 py-8 text-center">No data</p>;

  const chartData = data.rows.map((r) => ({
    subject: String(r.label ?? ''),
    value:   Number(r.value ?? 0),
    fullMark: Math.max(...data.rows.map((x) => Number(x.value ?? 0))) * 1.2,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <RadarChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
        <PolarGrid stroke="rgba(148,163,184,0.25)" />
        <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: '#94a3b8' }} />
        <PolarRadiusAxis tick={false} axisLine={false} />
        <Radar
          name={spec.title}
          dataKey="value"
          stroke={CHART_COLORS[4]}
          fill={CHART_COLORS[4]}
          fillOpacity={0.25}
          strokeWidth={2}
        />
        <Tooltip content={<CustomTooltip format={spec.format} />} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

// ─── Treemap Chart ────────────────────────────────────────────────────────────

function TreemapWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <ChartSkeleton />;
  if (data.error)   return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500 py-8 text-center">No data</p>;

  const chartData = data.rows.map((r, i) => ({
    name:  String(r.label ?? ''),
    size:  Number(r.value ?? 0),
    fill:  CHART_COLORS[i % CHART_COLORS.length],
  }));

  const CustomTreemapContent = (props: {
    x?: number; y?: number; width?: number; height?: number;
    name?: string; fill?: string; size?: number;
  }) => {
    const { x = 0, y = 0, width = 0, height = 0, name = '', fill = '#6366f1', size = 0 } = props;
    if (width < 30 || height < 20) return null;
    return (
      <g>
        <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} fill={fill} fillOpacity={0.85} rx={4} />
        {width > 60 && height > 30 && (
          <>
            <text x={x + 8} y={y + 18} fill="white" fontSize={11} fontWeight={600} style={{ pointerEvents: 'none' }}>
              {name.length > 14 ? name.slice(0, 13) + '…' : name}
            </text>
            {height > 44 && (
              <text x={x + 8} y={y + 32} fill="rgba(255,255,255,0.75)" fontSize={9} style={{ pointerEvents: 'none' }}>
                {formatValue(size, spec.format)}
              </text>
            )}
          </>
        )}
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <Treemap
        data={chartData}
        dataKey="size"
        aspectRatio={4 / 3}
        content={<CustomTreemapContent />}
      >
        <Tooltip formatter={(v: number) => [formatValue(v, spec.format), '']} />
      </Treemap>
    </ResponsiveContainer>
  );
}

// ─── DataTableWidget ──────────────────────────────────────────────────────────

function DataTableWidget({ spec, data, onCrossFilter }: { spec: WidgetSpec; data: WidgetData; onCrossFilter?: (v: string | null) => void }) {
  if (data.loading) return <WidgetSkeleton />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400 dark:text-slate-500">No data</p>;

  const keys = Object.keys(data.rows[0]);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const headerLabel = (k: string) => capitalize(k.replace(/_/g, ' '));
  const isNumeric = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
  // Cross-filter: emit the value of the first non-numeric column in a clicked row
  const firstTextKey = keys.find((k) => !isNumeric(data.rows[0][k]));

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="sticky top-0 bg-slate-50 dark:bg-slate-800">
            {keys.map((k) => (
              <th key={k} className="px-2 py-1.5 text-left font-semibold text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
                {headerLabel(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr
              key={i}
              onClick={onCrossFilter && firstTextKey ? () => onCrossFilter(String(row[firstTextKey] ?? '')) : undefined}
              className={`transition-colors
                ${onCrossFilter ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : ''}
                ${i % 2 === 0 ? 'bg-white dark:bg-slate-800/50' : 'bg-slate-50 dark:bg-slate-700/30'}`}
            >
              {keys.map((k) => (
                <td key={k} className={`px-2 py-1.5 text-slate-700 dark:text-slate-300 ${isNumeric(row[k]) ? 'text-right font-mono' : ''}`}>
                  {String(row[k] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Create input — defined OUTSIDE the page so it is never remounted ────────

function CreateInput({
  value, onChange, onSubmit, loading, compact, inputRef,
}: {
  value:     string;
  onChange:  (v: string) => void;
  onSubmit:  () => void;
  loading:   boolean;
  compact?:  boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className={`flex gap-2 ${compact ? '' : 'w-full max-w-lg'}`}>
      <input
        ref={compact ? undefined : inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        placeholder={compact ? 'Describe a dashboard…' : 'e.g. Sales overview by product and region'}
        className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white placeholder-slate-400"
        disabled={loading}
      />
      <button
        onClick={onSubmit}
        disabled={loading || !value.trim()}
        className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? '…' : 'Go'}
      </button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DashboardsPage() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('db_dark') === '1';
  });
  const [dashboards, setDashboards] = useState<SavedDashboard[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [currentSpec, setCurrentSpec] = useState<DashboardSpec | null>(null);
  const [isUnsaved, setIsUnsaved] = useState(false);
  const [mode, setMode] = useState<'empty' | 'choosing' | 'refining' | 'creating' | 'viewing'>('empty');
  const [createInput, setCreateInput] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [refinementQuestions, setRefinementQuestions] = useState<RefinementQuestion[]>([]);
  const [refinementAnswers, setRefinementAnswers] = useState<Record<number, string>>({});
  const [refinementLoading, setRefinementLoading] = useState(false);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({});
  const [widgetData, setWidgetData] = useState<Record<string, WidgetData>>({});
  const [crossFilter, setCrossFilter] = useState<DrillState | null>(null);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [availableDomains,  setAvailableDomains]  = useState<string[]>([]);
  const [selectedDomains,   setSelectedDomains]   = useState<string[]>([]);
  const [connectionId,      setConnectionId]      = useState<number>(1);
  const [connections,       setConnections]       = useState<{ id: number; name: string; domains: string[] }[]>([]);
  const [products, setProducts] = useState<{ id: number; name: string; description: string; status: string }[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [showShared, setShowShared] = useState(false);
  const [templates, setTemplates] = useState<DashboardTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [autoRefreshActive, setAutoRefreshActive] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dashboardGridRef = useRef<HTMLDivElement>(null);

  // ── Load saved dashboards ──────────────────────────────────────────────────

  const loadDashboards = useCallback(async () => {
    try {
      const res = await api.get('/dashboards');
      const sorted = (res.data.data as SavedDashboard[]).sort((a, b) => {
        if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
      setDashboards(sorted);
    } catch {
      // ignore — may not be connected yet
    }
  }, []);

  // ── Execute a single widget ────────────────────────────────────────────────

  async function executeWidget(widgetId: string, sql: string, filters: Record<string, string>, connId: number) {
    setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: true } }));
    try {
      const res = await api.post('/dashboards/execute', {
        connectionId: connId,
        sql,
        filterValues: filters,
      });
      if (res.data.ok === false) {
        setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: false, error: res.data.error ?? 'Query failed' } }));
      } else {
        setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: res.data.data?.rows ?? [], loading: false } }));
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Query failed';
      setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: false, error: msg } }));
    }
  }

  // ── Execute all widgets ───────────────────────────────────────────────────

  const executeAllWidgets = useCallback(
    async (
      spec: DashboardSpec,
      filters: Record<string, string>,
      xFilter: DrillState | null,
      connId: number,
    ) => {
      for (const widget of spec.widgets) {
        // If this widget is the cross-filter source AND has a drill SQL, show its drill view
        const isDrilled = xFilter?.widgetId === widget.id && widget.drillDownSql;
        const sql = isDrilled ? widget.drillDownSql! : widget.sql;
        const filterPayload: Record<string, string> = {
          ...filters,
          ...(isDrilled ? { drill_value: xFilter!.value } : {}),
          // Pass xf_<key> so any widget SQL with that placeholder gets filtered
          ...(xFilter ? { [`xf_${xFilter.key}`]: xFilter.value } : {}),
        };
        executeWidget(widget.id, sql, filterPayload, connId);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Load filter options ───────────────────────────────────────────────────

  async function loadFilterOptions(filters: FilterSpec[], connId: number) {
    for (const f of filters) {
      if (f.type === 'select' && f.table && f.column) {
        try {
          const res = await api.post('/dashboards/filter-options', {
            connectionId: connId,
            table: f.table,
            column: f.column,
          });
          setFilterOptions((prev) => ({ ...prev, [f.id]: res.data.data.options }));
        } catch {
          // ignore
        }
      }
    }
  }

  // ── Step 1: show choose dialog ────────────────────────────────────────────

  function initiateCreate() {
    if (!createInput.trim() || createLoading) return;
    setCreateError('');
    setMode('choosing');
  }

  // ── Step 2a: ask AI for clarifying questions ──────────────────────────────

  async function askForRefinement() {
    setRefinementLoading(true);
    setRefinementQuestions([]);
    setRefinementAnswers({});
    setMode('refining');
    try {
      const res = await api.post('/dashboards/refine', {
        connectionId: connectionId,
        request: createInput.trim(),
        ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
        ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}),
      });
      setRefinementQuestions(res.data.data.questions ?? []);
    } catch {
      setCreateError('Could not load questions. You can generate directly instead.');
      setMode('choosing');
    } finally {
      setRefinementLoading(false);
    }
  }

  // ── Step 2b / 3: generate the dashboard (optionally with answers) ─────────

  async function createDashboard(answers?: string[]) {
    if (!createInput.trim() || createLoading) return;
    setCreateLoading(true);
    setCreateError('');
    setMode('creating');
    try {
      const res = await api.post('/dashboards/generate', {
        connectionId: connectionId,
        request: createInput.trim(),
        answers: answers?.filter((a) => a.trim()),
        ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
        ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}),
      });
      const spec: DashboardSpec = res.data.data.spec;
      const defaults = buildDefaultFilters(spec.filters);
      setCurrentSpec(spec);
      setFilterValues(defaults);
      setCrossFilter(null);
      setChatMessages([]);
      setIsUnsaved(true);
      setMode('viewing');
      loadFilterOptions(spec.filters, connectionId);
      executeAllWidgets(spec, defaults, null, connectionId);
      setCreateInput('');
    } catch {
      setCreateError('Failed to generate dashboard. Please try again.');
      setMode('empty');
    } finally {
      setCreateLoading(false);
    }
  }

  // ── Save dashboard ────────────────────────────────────────────────────────

  async function saveDashboard() {
    if (!currentSpec) return;
    setSaving(true);
    try {
      const res = await api.post('/dashboards', {
        connectionId: connectionId,
        title: currentSpec.title,
        description: currentSpec.description,
        spec: currentSpec,
      });
      setIsUnsaved(false);
      setActiveId(res.data.data.id);
      await loadDashboards();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  // ── Open a saved dashboard ────────────────────────────────────────────────

  async function openDashboard(id: number) {
    try {
      const res = await api.get(`/dashboards/${id}`);
      const row = res.data.data;
      const spec: DashboardSpec =
        typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
      const defaults = buildDefaultFilters(spec.filters);
      setCurrentSpec(spec);
      setFilterValues(defaults);
      setCrossFilter(null);
      setIsUnsaved(false);
      setActiveId(id);
      setMode('viewing');
      setChatMessages([]);
      setSettingsOpen(false);
      // Sync auto-refresh from saved dashboard
      const saved = dashboards.find((d) => d.id === id);
      setAutoRefreshActive(!!(saved?.auto_refresh_seconds && saved.auto_refresh_seconds > 0));
      loadFilterOptions(spec.filters, connectionId);
      executeAllWidgets(spec, defaults, null, connectionId);
    } catch {
      // ignore
    }
  }

  // ── Toggle favorite ───────────────────────────────────────────────────────

  async function toggleFavorite(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.patch(`/dashboards/${id}/favorite`);
      await loadDashboards();
    } catch {
      // ignore
    }
  }

  // ── Delete dashboard ──────────────────────────────────────────────────────

  async function deleteDashboard(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete this dashboard?')) return;
    try {
      await api.delete(`/dashboards/${id}`);
      if (activeId === id) {
        setActiveId(null);
        setCurrentSpec(null);
        setMode('empty');
      }
      await loadDashboards();
    } catch {
      // ignore
    }
  }

  // ── Handle cross-filter / drill-down ─────────────────────────────────────

  function handleCrossFilter(widgetId: string, xfKey: string, value: string | null) {
    if (!value || (crossFilter?.widgetId === widgetId && crossFilter?.value === value)) {
      // Second click on same item → clear
      setCrossFilter(null);
      if (currentSpec) executeAllWidgets(currentSpec, filterValues, null, connectionId);
      return;
    }
    const widget = currentSpec?.widgets.find((w) => w.id === widgetId);
    const label = widget?.drillDownLabel?.replace('{{drill_value}}', value) ?? value;
    const newXF: DrillState = { widgetId, key: xfKey, value, label };
    setCrossFilter(newXF);
    if (currentSpec) executeAllWidgets(currentSpec, filterValues, newXF, connectionId);
  }

  // ── Handle filter change ──────────────────────────────────────────────────

  function handleFilterChange(key: string, value: string) {
    const newFilters = { ...filterValues, [key]: value };
    setFilterValues(newFilters);
    if (currentSpec) executeAllWidgets(currentSpec, newFilters, crossFilter, connectionId);
  }

  // ── Intent detection — routes to query or refine ─────────────────────────

  function detectIntent(input: string): 'query' | 'refine' {
    const lower = input.toLowerCase().trim();
    const queryPattern = /^(what|why|how|who|when|which|where|is |are |was |were |can |could |would |should |do |did |show me|tell me|give me|list |find |how many|how much|which |compare)/;
    return queryPattern.test(lower) ? 'query' : 'refine';
  }

  // ── Smart chat submit — asks data questions OR refines the dashboard ───────

  async function handleChatSubmit() {
    if (!refineInput.trim() || chatLoading || !currentSpec) return;
    const input = refineInput.trim();
    setRefineInput('');

    const intent = detectIntent(input);
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text: input, type: intent };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);

    try {
      if (intent === 'query') {
        // Build context from previous Q&A if this looks like a follow-up
        const prevMessages = chatMessages.filter(m => m.type === 'query');
        const isFollowUp = /^(can you|could you|give me|show me|list|what about|and |also |them|they|those|it |that |these)/i.test(input);
        let fullQuestion = input;
        if (isFollowUp && prevMessages.length >= 2) {
          const lastQ = prevMessages[prevMessages.length - 2];
          const lastA = prevMessages[prevMessages.length - 1];
          if (lastQ.role === 'user' && lastA.role === 'assistant') {
            fullQuestion = `Previous question: "${lastQ.text}"\nPrevious answer summary: "${lastA.text.slice(0, 300)}"\n\nFollow-up question: ${input}`;
          }
        }
        const res = await api.post('/query', { connectionId: connectionId, question: fullQuestion });
        const answer: string = res.data.data?.answer ?? res.data.answer ?? 'No answer available.';
        setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_a', role: 'assistant', text: answer, type: 'query' }]);
      } else {
        const res = await api.post('/dashboards/refine-spec', { connectionId: connectionId, refinement: input, currentSpec, ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}) });
        const newSpec: DashboardSpec = res.data.data.spec;
        const defaults = buildDefaultFilters(newSpec.filters);
        setCurrentSpec(newSpec);
        setFilterValues(defaults);
        setCrossFilter(null);
        setIsUnsaved(true);
        loadFilterOptions(newSpec.filters, connectionId);
        executeAllWidgets(newSpec, defaults, null, connectionId);
        setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_a', role: 'assistant', text: `Dashboard updated — "${newSpec.title}"`, type: 'refine' }]);
      }
    } catch {
      setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_e', role: 'assistant', text: 'Something went wrong. Please try again.', type: intent }]);
    } finally {
      setChatLoading(false);
    }
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem('db_dark', darkMode ? '1' : '0');
  }, [darkMode]);

  useEffect(() => {
    setIsAdmin(getTokenPayload()?.role === 'admin');
    loadDashboards();
    // Load the real connection ID — never assume it is 1
    api.get('/connections')
      .then((r) => {
        const conns = r.data.data as { id: number; name: string; domains?: string | string[] }[];
        if (conns.length > 0) {
          const parsed = conns.map((c) => ({
            id: c.id,
            name: c.name,
            domains: Array.isArray(c.domains)
              ? c.domains
              : c.domains
                ? JSON.parse(c.domains as string)
                : [],
          }));
          setConnections(parsed);
          setConnectionId(parsed[0].id);
          api.get(`/semantic/domains?connectionId=${conns[0].id}`)
            .then((dr) => setAvailableDomains(dr.data.data ?? []))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [loadDashboards]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Close settings dropdown when clicking outside
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = () => setSettingsOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [settingsOpen]);

  // ── Helper: discard unsaved dashboard ────────────────────────────────────

  function discardDashboard() {
    setCurrentSpec(null);
    setIsUnsaved(false);
    setActiveId(null);
    setMode('empty');
    setWidgetData({});
    setCrossFilter(null);
    setChatMessages([]);
  }

  // ── Load folders + templates ────────────────────────────────────────────

  useEffect(() => {
    api.get('/dashboards/folders').then((r) => setFolders(r.data.data ?? [])).catch(() => {});
    api.get('/dashboards/templates/list').then((r) => setTemplates(r.data.data ?? [])).catch(() => {});
    api.get('/products').then((r) => {
      const prods = (r.data.data ?? []).filter((p: { status: string }) => ['approved', 'success'].includes(p.status));
      setProducts(prods);
    }).catch(() => {});
  }, []);

  // ── Auto-refresh effect ───────────────────────────────────────────────

  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (!autoRefreshActive || !currentSpec) return;

    const saved = dashboards.find((d) => d.id === activeId);
    const interval = saved?.auto_refresh_seconds;
    if (!interval || interval < 10) return;

    autoRefreshRef.current = setInterval(() => {
      if (currentSpec) {
        executeAllWidgets(currentSpec, filterValues, crossFilter, connectionId);
      }
    }, interval * 1000);

    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [autoRefreshActive, activeId, currentSpec, filterValues, crossFilter, connectionId, dashboards, executeAllWidgets]);

  // ── Duplicate dashboard ───────────────────────────────────────────────

  async function duplicateDashboard(id: number) {
    try {
      await api.post(`/dashboards/${id}/duplicate`);
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── Toggle sharing ────────────────────────────────────────────────────

  async function toggleSharing(id: number) {
    const d = dashboards.find((x) => x.id === id);
    if (!d || !d.is_owner) return;
    try {
      await api.patch(`/dashboards/${id}`, { is_shared: !d.is_shared });
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── Update shared permission ──────────────────────────────────────────

  async function updateSharedPermission(id: number, perm: string) {
    try {
      await api.patch(`/dashboards/${id}`, { shared_permission: perm });
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── Move to folder ────────────────────────────────────────────────────

  async function moveToFolder(id: number, folder: string | null) {
    try {
      await api.patch(`/dashboards/${id}`, { folder });
      await loadDashboards();
      api.get('/dashboards/folders').then((r) => setFolders(r.data.data ?? [])).catch(() => {});
    } catch { /* ignore */ }
  }

  // ── Set auto-refresh ──────────────────────────────────────────────────

  async function setAutoRefresh(id: number, seconds: number | null) {
    try {
      await api.patch(`/dashboards/${id}`, { auto_refresh_seconds: seconds });
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── PDF export (client-side) ──────────────────────────────────────────

  async function exportPdf() {
    if (!dashboardGridRef.current || !currentSpec) return;
    // Dynamic import to avoid bundling html2canvas + jspdf for everyone
    const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
      import('html2canvas'),
      import('jspdf'),
    ]);

    const canvas = await html2canvas(dashboardGridRef.current, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    });

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [canvas.width, canvas.height],
    });
    pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
    pdf.save(`${currentSpec.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
  }

  // ── Create from template ──────────────────────────────────────────────

  async function createFromTemplate(templateId: number) {
    try {
      const res = await api.post('/dashboards/from-template', {
        templateId,
        connectionId,
      });
      const newId = res.data.data.id;
      await loadDashboards();
      openDashboard(newId);
      setShowTemplates(false);
    } catch { /* ignore */ }
  }

  // ── Helper: partition dashboards ─────────────────────────────────────────

  const visibleDashboards = dashboards.filter((d) => {
    if (showShared && !d.is_shared && !d.is_owner) return false;
    if (showShared && d.is_owner) return false; // show only others' shared
    if (!showShared && !d.is_owner) return false; // my dashboards only
    if (activeFolder !== null && d.folder !== activeFolder) return false;
    return true;
  });
  const favorites = visibleDashboards.filter((d) => d.is_favorite);
  const regular = visibleDashboards.filter((d) => !d.is_favorite);

  // ── Sidebar list item ─────────────────────────────────────────────────────

  function DashboardListItem({ d }: { d: SavedDashboard }) {
    const isActive = d.id === activeId && !isUnsaved;
    return (
      <button
        onClick={() => openDashboard(d.id)}
        className={`w-full text-left px-3 py-2 rounded-lg group flex items-start justify-between gap-1 transition-colors ${
          isActive
            ? 'border-l-2 border-blue-500 bg-blue-50 pl-2.5'
            : 'hover:bg-slate-50 border-l-2 border-transparent'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <p className={`text-sm font-medium truncate ${isActive ? 'text-blue-700' : 'text-slate-700 dark:text-slate-200'}`}>
              {d.title}
            </p>
            {d.is_shared && <span className="shrink-0 text-[10px] bg-blue-100 text-blue-600 px-1 rounded">shared</span>}
            {!d.is_owner && <span className="shrink-0 text-[10px] bg-purple-100 text-purple-600 px-1 rounded">{d.permission}</span>}
          </div>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
            {d.folder && <span className="text-slate-300 mr-1">{d.folder} /</span>}
            {relTime(d.updated_at)}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
          {d.is_owner && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); duplicateDashboard(d.id); }}
                className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-blue-500 rounded text-xs"
                title="Duplicate"
              >
                ⧉
              </button>
              <button
                onClick={(e) => toggleFavorite(d.id, e)}
                className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-amber-400 rounded"
                title={d.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                {d.is_favorite ? '⭐' : '☆'}
              </button>
              <button
                onClick={(e) => deleteDashboard(d.id, e)}
                className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-red-500 rounded text-xs"
                title="Delete"
              >
                ×
              </button>
            </>
          )}
          {!d.is_owner && (
            <button
              onClick={(e) => { e.stopPropagation(); duplicateDashboard(d.id); }}
              className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-blue-500 rounded text-xs"
              title="Duplicate to my dashboards"
            >
              ⧉
            </button>
          )}
        </div>
      </button>
    );
  }

  // ── Create input row ──────────────────────────────────────────────────────

  // ── Render widget by type ─────────────────────────────────────────────────

  function renderWidget(widget: WidgetSpec) {
    const data: WidgetData = widgetData[widget.id] ?? { rows: [], loading: true };

    // 12-column grid: spec colSpan 1→3cols, 2→6cols, 3→9cols, 4→12cols
    // kpi_card=3 → 4 per row (12), everything else=6 → 2 per row (12), data_table=12 → full row
    const defaultCols: Record<string, number> = {
      kpi_card: 3, bar_chart: 6, vertical_bar_chart: 6, stacked_bar_chart: 6,
      line_chart: 6, pie_chart: 6, top_list: 6, data_table: 12,
      combo_chart: 6, radar_chart: 6, treemap_chart: 6,
    };
    const SPAN_MAP: Record<number, number> = { 1: 3, 2: 6, 3: 9, 4: 12 };
    const col12 = widget.colSpan ? (SPAN_MAP[widget.colSpan] ?? 6) : (defaultCols[widget.type] ?? 6);

    const isCrossFilterSource = crossFilter?.widgetId === widget.id;
    const isFiltered = crossFilter !== null && !isCrossFilterSource;

    // Cross-filter handler: use widget.crossFilterKey, fall back to the widget id
    const xfKey = widget.crossFilterKey ?? widget.id;
    const onCF = (val: string | null) => handleCrossFilter(widget.id, xfKey, val);
    const hasCrossFilter = Boolean(widget.crossFilterKey);

    switch (widget.type) {
      case 'kpi_card':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <KpiCard spec={widget} data={data} />
          </WidgetCard>
        );

      case 'bar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <BarChartWidget
              spec={widget}
              data={data}
              onCrossFilter={hasCrossFilter ? onCF : undefined}
              isCrossFilterActive={isCrossFilterSource}
              drillLabel={isCrossFilterSource ? crossFilter!.label : undefined}
            />
          </WidgetCard>
        );

      case 'line_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <LineChartWidget spec={widget} data={data} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );

      case 'vertical_bar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <VerticalBarChartWidget spec={widget} data={data} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );

      case 'stacked_bar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <StackedBarChartWidget spec={widget} data={data} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );

      case 'pie_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <PieChartWidget spec={widget} data={data} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );

      case 'top_list':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <TopListWidget spec={widget} data={data} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );

      case 'data_table':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <DataTableWidget spec={widget} data={data} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );

      case 'combo_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <ComboChartWidget spec={widget} data={data} />
          </WidgetCard>
        );
      case 'radar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <RadarChartWidget spec={widget} data={data} />
          </WidgetCard>
        );
      case 'treemap_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={col12} isFiltered={isFiltered} isCrossFilterSource={isCrossFilterSource}>
            <TreemapWidget spec={widget} data={data} />
          </WidgetCard>
        );

      default:
        return null;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Sidebar header */}
      <div className="px-3 py-3 ghost-border-b">
        <div className="flex items-center justify-between mb-2">
          <span className="text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Dashboards</span>
          <button
            onClick={() => { setMode('empty'); setActiveId(null); setCurrentSpec(null); setIsUnsaved(false); }}
            className="text-label-md text-secondary font-semibold hover:text-primary"
          >
            + New
          </button>
        </div>
        <CreateInput
          compact
          value={createInput}
          onChange={setCreateInput}
          onSubmit={initiateCreate}
          loading={createLoading}
        />
        {createError && <p className="text-label-sm text-error mt-1">{createError}</p>}
      </div>

      {/* My / Shared toggle */}
      <div className="px-2 pt-2 flex gap-1">
        <button
          onClick={() => { setShowShared(false); setActiveFolder(null); }}
          className={`flex-1 text-label-md py-1 rounded-lg font-medium transition-colors ${!showShared ? 'pill-active' : 'pill-inactive'}`}
        >
          My
        </button>
        <button
          onClick={() => { setShowShared(true); setActiveFolder(null); }}
          className={`flex-1 text-label-md py-1 rounded-lg font-medium transition-colors ${showShared ? 'pill-active' : 'pill-inactive'}`}
        >
          Shared
        </button>
        <button
          onClick={() => setShowTemplates(true)}
          className="flex-1 text-label-md py-1 rounded-lg font-medium pill-inactive transition-colors"
          title="Browse templates"
        >
          Templates
        </button>
      </div>

      {/* Folder filter */}
      {!showShared && folders.length > 0 && (
        <div className="px-2 pt-1.5 flex flex-wrap gap-1">
          <button
            onClick={() => setActiveFolder(null)}
            className={`text-label-sm px-2 py-0.5 rounded-pill transition-colors ${activeFolder === null ? 'bg-primary text-on-primary' : 'text-on-surface-variant ghost-border hover:bg-surface-container'}`}
          >
            All
          </button>
          {folders.map((f) => (
            <button
              key={f}
              onClick={() => setActiveFolder(activeFolder === f ? null : f)}
              className={`text-label-sm px-2 py-0.5 rounded-pill transition-colors ${activeFolder === f ? 'bg-primary text-on-primary' : 'text-on-surface-variant ghost-border hover:bg-surface-container'}`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {/* Dashboard list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin py-2 px-2 space-y-0.5">
        {favorites.length > 0 && (
          <>
            <p className="text-label-sm text-on-surface-variant/50 uppercase tracking-wider px-1 py-1">Favorites</p>
            {favorites.map((d) => <DashboardListItem key={d.id} d={d} />)}
            {regular.length > 0 && <div className="my-2" />}
          </>
        )}
        {regular.map((d) => <DashboardListItem key={d.id} d={d} />)}
        {visibleDashboards.length === 0 && (
          <p className="text-label-sm text-on-surface-variant/40 text-center mt-4 px-2">
            {showShared ? 'No shared dashboards yet' : 'No saved dashboards yet'}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <AppShell
      title="Dashboards"
      contextPanel={sidebarContent}
      pills={[{ key: 'all', label: 'All' }, { key: 'favorites', label: 'Favorites' }, { key: 'reports', label: 'Reports' }]}
      activePill="all"
      onPillChange={() => {}}
    >
      <div className={`flex-1 overflow-hidden flex flex-col ${darkMode ? 'dark' : ''}`}
        style={{ background: darkMode
          ? 'linear-gradient(135deg, #0f1117 0%, #1a1d2e 50%, #0f1117 100%)'
          : undefined }}>

        {/* ── Main area ── */}
        <main className="flex-1 overflow-hidden flex flex-col">

          {/* Empty state */}
          {mode === 'empty' && (
            <div className="flex items-center justify-center h-full p-8">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10 max-w-md w-full text-center">
                <div className="text-5xl mb-4">📊</div>
                <h2 className="text-xl font-bold text-slate-900 mb-2">Build your first dashboard</h2>
                <p className="text-sm text-slate-500 mb-6">
                  Describe what you want to see and let AI design it for you.
                </p>
                <div className="flex justify-center mb-6">
                  <CreateInput
                    value={createInput}
                    onChange={setCreateInput}
                    onSubmit={initiateCreate}
                    loading={createLoading}
                    inputRef={inputRef}
                  />
                </div>
                {createError && <p className="text-xs text-red-500 mb-4">{createError}</p>}
                <div className="flex flex-wrap justify-center gap-2">
                  {['Sales overview', 'Customer analysis', 'Product performance'].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => { setCreateInput(prompt); setMode('choosing'); }}
                      className="px-3 py-1 text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Choosing: refine first or generate now */}
          {mode === 'choosing' && (
            <div className="flex items-center justify-center h-full p-8">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 max-w-lg w-full">
                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Your request</p>
                <p className="text-base font-semibold text-slate-800 mb-4 leading-snug">&ldquo;{createInput}&rdquo;</p>

                {/* Data domain selector — shown when multiple connections / domains exist */}
                {connections.length > 1 && (() => {
                  // Build flat list: one chip per domain; fall back to connection name
                  const chips: { label: string; connId: number }[] = [];
                  for (const c of connections) {
                    if (c.domains.length > 0) {
                      c.domains.forEach((d) => chips.push({ label: d, connId: c.id }));
                    } else {
                      chips.push({ label: c.name, connId: c.id });
                    }
                  }
                  return (
                    <div className="mb-5">
                      <p className="text-xs text-slate-500 mb-1.5 font-medium">Data domain</p>
                      <div className="flex flex-wrap gap-2">
                        {chips.map((chip) => (
                          <button
                            key={`${chip.connId}-${chip.label}`}
                            onClick={() => setConnectionId(chip.connId)}
                            className={`px-3 py-1.5 text-xs rounded-full border transition-colors font-medium capitalize ${
                              connectionId === chip.connId
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400 hover:text-blue-600'
                            }`}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Data product selector */}
                {products.length > 0 && (
                  <div className="mb-5">
                    <p className="text-xs text-slate-500 mb-1.5 font-medium">Data product(s)</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setSelectedProductIds([])}
                        className={`px-3 py-1.5 text-xs rounded-full border transition-colors font-medium ${
                          selectedProductIds.length === 0
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400 hover:text-blue-600'
                        }`}
                      >
                        All products
                      </button>
                      {products.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setSelectedProductIds((prev) =>
                              prev.includes(p.id)
                                ? prev.filter((id) => id !== p.id)
                                : [...prev, p.id],
                            );
                          }}
                          className={`px-3 py-1.5 text-xs rounded-full border transition-colors font-medium ${
                            selectedProductIds.includes(p.id)
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white text-slate-600 border-slate-300 hover:border-indigo-400 hover:text-indigo-600'
                          }`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                    {selectedProductIds.length > 0 && (
                      <p className="text-[10px] text-slate-400 mt-1">
                        {selectedProductIds.length} product{selectedProductIds.length > 1 ? 's' : ''} selected — dashboard will only use tables from {selectedProductIds.length > 1 ? 'these products' : 'this product'}
                      </p>
                    )}
                  </div>
                )}

                <p className="text-sm text-slate-500 mb-5">How would you like to proceed?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={askForRefinement}
                    className="flex flex-col items-start gap-2 p-4 border-2 border-blue-200 hover:border-blue-400 bg-blue-50 hover:bg-blue-100 rounded-xl transition-colors text-left"
                  >
                    <span className="text-2xl">🎯</span>
                    <span className="text-sm font-semibold text-blue-800">Refine with AI first</span>
                    <span className="text-xs text-blue-600">Answer a few questions so AI can tailor the dashboard exactly to your needs</span>
                  </button>
                  <button
                    onClick={() => createDashboard()}
                    className="flex flex-col items-start gap-2 p-4 border-2 border-slate-200 hover:border-slate-400 bg-slate-50 hover:bg-slate-100 rounded-xl transition-colors text-left"
                  >
                    <span className="text-2xl">⚡</span>
                    <span className="text-sm font-semibold text-slate-700">Generate now</span>
                    <span className="text-xs text-slate-500">Let AI decide what to include based on best practices and your schema</span>
                  </button>
                </div>
                <button
                  onClick={() => setMode('empty')}
                  className="mt-4 text-xs text-slate-400 hover:text-slate-600 transition-colors"
                >
                  ← Back
                </button>
                {createError && <p className="text-xs text-red-500 mt-3">{createError}</p>}
              </div>
            </div>
          )}

          {/* Refining: AI questions */}
          {mode === 'refining' && (
            <div className="flex items-center justify-center h-full p-8">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 max-w-xl w-full">
                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Refining</p>
                <p className="text-base font-semibold text-slate-800 mb-1">&ldquo;{createInput}&rdquo;</p>
                <p className="text-xs text-slate-400 mb-6">Answer what you can — skip anything that doesn&apos;t apply</p>

                {refinementLoading ? (
                  <div className="flex items-center gap-3 py-8 justify-center">
                    <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm text-slate-500">Thinking of the right questions…</span>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {refinementQuestions.map((q, idx) => (
                      <div key={idx}>
                        <p className="text-sm font-medium text-slate-700 mb-2">
                          <span className="text-blue-500 font-bold mr-1.5">{idx + 1}.</span>
                          {q.question}
                        </p>
                        {/* Suggestion chips */}
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {q.suggestions.map((s) => (
                            <button
                              key={s}
                              onClick={() => setRefinementAnswers((prev) => ({
                                ...prev,
                                [idx]: prev[idx] === s ? '' : s,
                              }))}
                              className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                                refinementAnswers[idx] === s
                                  ? 'bg-blue-600 text-white border-blue-600'
                                  : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400 hover:text-blue-600'
                              }`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                        {/* Custom free-text answer */}
                        <input
                          type="text"
                          value={refinementAnswers[idx] ?? ''}
                          onChange={(e) => setRefinementAnswers((prev) => ({ ...prev, [idx]: e.target.value }))}
                          placeholder="Or type your own answer…"
                          className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 text-slate-700 placeholder-slate-300"
                        />
                      </div>
                    ))}

                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => createDashboard(Object.values(refinementAnswers).filter(Boolean))}
                        disabled={createLoading}
                        className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors"
                      >
                        {createLoading ? 'Generating…' : 'Generate Dashboard →'}
                      </button>
                      <button
                        onClick={() => createDashboard()}
                        disabled={createLoading}
                        className="px-4 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-500 text-sm rounded-xl transition-colors"
                        title="Skip refinement and generate now"
                      >
                        Skip
                      </button>
                    </div>
                    <button
                      onClick={() => setMode('choosing')}
                      className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      ← Back
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Generating state */}
          {mode === 'creating' && (
            <div className="flex items-center justify-center h-full">
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10 text-center">
                <div className="flex justify-center mb-4">
                  <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
                <p className="text-base font-semibold text-slate-700">Generating your dashboard…</p>
                <p className="text-sm text-slate-400 mt-1">AI is designing your widgets and queries</p>
              </div>
            </div>
          )}

          {/* Dashboard view */}
          {mode === 'viewing' && currentSpec && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Top bar */}
              <div className="bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-b border-black/5 dark:border-white/5 px-6 py-3 flex items-center justify-between gap-4 shrink-0">
                <div className="min-w-0">
                  <h1 className="font-bold text-lg text-slate-900 leading-tight">{currentSpec.title}</h1>
                  {currentSpec.description && (
                    <p className="text-sm text-slate-500 mt-0.5 truncate">{currentSpec.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Settings dropdown (share, folder, auto-refresh) — only for saved owned dashboards */}
                  {activeId && !isUnsaved && (() => {
                    const activeDash = dashboards.find((d) => d.id === activeId);
                    if (!activeDash?.is_owner) return null;
                    return (
                      <div className="relative">
                        <button
                          onClick={() => setSettingsOpen(!settingsOpen)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-700 transition-colors text-sm"
                          title="Dashboard settings"
                        >
                          &#9881;
                        </button>
                        {settingsOpen && (
                          <div className="absolute right-0 top-10 z-50 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl p-3 space-y-3"
                               onClick={(e) => e.stopPropagation()}>
                            {/* Sharing */}
                            <div>
                              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={activeDash.is_shared}
                                  onChange={() => toggleSharing(activeId)}
                                  className="rounded border-slate-300"
                                />
                                Share with team
                              </label>
                              {activeDash.is_shared && (
                                <select
                                  value={activeDash.shared_permission}
                                  onChange={(e) => updateSharedPermission(activeId, e.target.value)}
                                  className="mt-1 w-full text-xs border border-slate-200 rounded-md px-2 py-1"
                                >
                                  <option value="viewer">Team can view</option>
                                  <option value="editor">Team can edit</option>
                                </select>
                              )}
                            </div>
                            {/* Folder */}
                            <div>
                              <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Folder</label>
                              <div className="flex gap-1">
                                <input
                                  type="text"
                                  defaultValue={activeDash.folder ?? ''}
                                  placeholder="Uncategorized"
                                  onBlur={(e) => moveToFolder(activeId, e.target.value || null)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                  className="flex-1 text-xs border border-slate-200 rounded-md px-2 py-1"
                                />
                              </div>
                            </div>
                            {/* Auto-refresh */}
                            <div>
                              <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Auto-refresh</label>
                              <select
                                value={activeDash.auto_refresh_seconds ?? 0}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setAutoRefresh(activeId, v || null);
                                  setAutoRefreshActive(v > 0);
                                }}
                                className="w-full text-xs border border-slate-200 rounded-md px-2 py-1"
                              >
                                <option value={0}>Off</option>
                                <option value={30}>Every 30 seconds</option>
                                <option value={60}>Every minute</option>
                                <option value={300}>Every 5 minutes</option>
                                <option value={600}>Every 10 minutes</option>
                                <option value={1800}>Every 30 minutes</option>
                              </select>
                            </div>
                            <button
                              onClick={() => setSettingsOpen(false)}
                              className="w-full text-xs text-slate-400 hover:text-slate-600 pt-1"
                            >
                              Close
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* PDF export */}
                  {!isUnsaved && (
                    <button
                      onClick={exportPdf}
                      className="w-8 h-8 flex items-center justify-center rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-700 transition-colors text-sm"
                      title="Export as PDF"
                    >
                      PDF
                    </button>
                  )}

                  {/* Duplicate */}
                  {activeId && !isUnsaved && (
                    <button
                      onClick={() => duplicateDashboard(activeId)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-700 transition-colors text-sm"
                      title="Duplicate dashboard"
                    >
                      ⧉
                    </button>
                  )}

                  {/* Auto-refresh indicator */}
                  {autoRefreshActive && (
                    <span className="px-2 py-1 text-[10px] bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-full font-medium flex items-center gap-1">
                      <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                      Auto
                    </span>
                  )}

                  <button
                    onClick={() => setDarkMode((d) => !d)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-slate-800/60 hover:bg-white dark:hover:bg-slate-700 transition-colors text-base"
                    title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                  >
                    {darkMode ? '☀️' : '🌙'}
                  </button>
                  {isUnsaved ? (
                    <>
                      <button
                        onClick={discardDashboard}
                        className="px-3 py-1.5 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
                      >
                        Discard
                      </button>
                      <button
                        onClick={saveDashboard}
                        disabled={saving}
                        className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <span className="px-3 py-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded-full font-medium">
                      Saved
                    </span>
                  )}
                </div>
              </div>

              {/* Filter bar */}
              {currentSpec.filters.length > 0 && (
                <div className="bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-b border-black/5 dark:border-white/5 px-6 py-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 shrink-0">
                  {currentSpec.filters.map((f) => {
                    if (f.type === 'date_range') {
                      return (
                        <div key={f.id} className="flex items-center gap-2">
                          <span className="text-xs font-medium text-slate-500">{f.label}</span>
                          <input
                            type="date"
                            value={filterValues[`${f.id}_from`] ?? ''}
                            onChange={(e) => handleFilterChange(`${f.id}_from`, e.target.value)}
                            className="px-2 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <span className="text-xs text-slate-400">to</span>
                          <input
                            type="date"
                            value={filterValues[`${f.id}_to`] ?? ''}
                            onChange={(e) => handleFilterChange(`${f.id}_to`, e.target.value)}
                            className="px-2 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                      );
                    }
                    if (f.type === 'select') {
                      const opts = filterOptions[f.id] ?? [];
                      return (
                        <div key={f.id} className="flex items-center gap-2">
                          <span className="text-xs font-medium text-slate-500">{f.label}</span>
                          <select
                            value={filterValues[f.id] ?? 'all'}
                            onChange={(e) => handleFilterChange(f.id, e.target.value)}
                            className="px-2 py-1 text-xs border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                          >
                            <option value="all">{f.allLabel ?? `All ${f.label}`}</option>
                            {opts.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              )}

              {/* Widget grid */}
              <div className="flex-1 overflow-y-auto">
              <div ref={dashboardGridRef} className="grid gap-3 p-4" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: 'min-content' }}>
                {currentSpec.widgets.map((widget) => renderWidget(widget))}
              </div>
              </div>

              {/* Bottom chat bar */}
              <div className="bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-t border-black/5 dark:border-white/5 shrink-0">
                {/* Chat history */}
                {chatMessages.length > 0 && (
                  <div className="px-6 pt-3 pb-1 max-h-52 overflow-y-auto space-y-2">
                    {chatMessages.map((msg) => (
                      <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] px-3 py-2 rounded-xl ${
                          msg.role === 'user'
                            ? 'bg-blue-600 text-white rounded-br-sm text-sm'
                            : msg.type === 'refine'
                            ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-bl-sm'
                            : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                        }`}>
                          {msg.role === 'assistant' && msg.type === 'refine' && (
                            <span className="text-xs font-semibold block mb-0.5 text-emerald-600">✦ Dashboard updated</span>
                          )}
                          {msg.role === 'assistant'
                            ? <MarkdownAnswer text={msg.text} />
                            : msg.text}
                        </div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="bg-slate-100 rounded-xl rounded-bl-sm px-3 py-2 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                )}
                {/* Input row */}
                <div className="px-6 py-3 flex gap-2">
                  <input
                    type="text"
                    value={refineInput}
                    onChange={(e) => setRefineInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleChatSubmit()}
                    placeholder='Ask about the data or say how to improve this dashboard…'
                    disabled={chatLoading}
                    className="flex-1 px-4 py-2 text-sm border border-black/10 dark:border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white/80 dark:bg-slate-800/80 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 disabled:opacity-50 backdrop-blur-sm"
                  />
                  <button
                    onClick={handleChatSubmit}
                    disabled={chatLoading || !refineInput.trim()}
                    className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    {chatLoading ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Template gallery modal */}
      {showTemplates && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Dashboard Templates</h2>
              <button onClick={() => setShowTemplates(false)} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {templates.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-4xl mb-3">📋</div>
                  <p className="text-sm text-slate-500">No templates available yet.</p>
                  <p className="text-xs text-slate-400 mt-1">Admins can save dashboard specs as templates.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {(() => {
                    const categories = [...new Set(templates.map((t) => t.category))];
                    return categories.map((cat) => (
                      <div key={cat} className="col-span-2">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{cat}</p>
                        <div className="grid grid-cols-2 gap-3">
                          {templates.filter((t) => t.category === cat).map((t) => (
                            <button
                              key={t.id}
                              onClick={() => createFromTemplate(t.id)}
                              className="text-left p-4 border border-slate-200 hover:border-blue-400 rounded-xl transition-colors group"
                            >
                              <p className="text-sm font-semibold text-slate-700 group-hover:text-blue-700">{t.name}</p>
                              {t.description && <p className="text-xs text-slate-500 mt-1">{t.description}</p>}
                            </button>
                          ))}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </AppShell>
  );
}
