'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Nav from '@/components/Nav';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
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
  type: 'kpi_card' | 'bar_chart' | 'vertical_bar_chart' | 'stacked_bar_chart' | 'line_chart' | 'pie_chart' | 'top_list' | 'data_table';
  title: string;
  sql: string;
  drillDownSql?: string;
  drillDownLabel?: string;
  format?: 'currency' | 'number' | 'percentage';
  colSpan?: 1 | 2 | 3;
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
  created_at: string;
  updated_at: string;
}

interface WidgetData {
  rows: Record<string, unknown>[];
  loading: boolean;
  error?: string;
}

interface DrillState {
  widgetId: string;
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

const CONNECTION_ID = 1;
const CHART_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ef4444', '#06b6d4', '#84cc16', '#f97316',
];

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
  spec,
  colSpan,
  children,
}: {
  spec: WidgetSpec;
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ gridColumn: `span ${colSpan}` }}
      className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700">{spec.title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Loading / error helpers ──────────────────────────────────────────────────

function WidgetSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-4 bg-slate-100 rounded w-1/2" />
      <div className="h-8 bg-slate-100 rounded w-3/4" />
    </div>
  );
}

function WidgetSpinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
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
      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{spec.title}</p>
      <p className="text-3xl font-bold text-slate-900">{formatValue(val, spec.format)}</p>
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
  spec,
  data,
  onDrillDown,
  isDrilled,
  drillLabel,
}: {
  spec: WidgetSpec;
  data: WidgetData;
  onDrillDown?: (value: string | null) => void;
  isDrilled?: boolean;
  drillLabel?: string;
}) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

  const chartData = data.rows.map((r) => ({ label: String(r.label ?? ''), value: Number(r.value ?? 0) }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const height = Math.max(180, Math.min(chartData.length * 36 + 48, 320));

  const yFmt = (v: number) => (maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v));

  return (
    <div>
      {isDrilled && drillLabel && (
        <div className="mb-3">
          <button
            onClick={() => onDrillDown?.(null)}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            ← Back to all
          </button>
          <p className="text-xs text-slate-500 mt-0.5">{drillLabel}</p>
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
          <XAxis type="number" tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="label"
            width={110}
            tick={{ fontSize: 11, fill: '#64748b' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            formatter={(v: number) => [formatValue(v, spec.format), spec.title]}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
          />
          <Bar
            dataKey="value"
            fill={CHART_COLORS[0]}
            radius={[0, 4, 4, 0]}
            cursor={onDrillDown ? 'pointer' : undefined}
            onClick={onDrillDown ? (entry) => onDrillDown(String(entry.label)) : undefined}
          />
        </BarChart>
      </ResponsiveContainer>
      {onDrillDown && !isDrilled && (
        <p className="text-xs text-slate-400 mt-1 text-center">Click a bar to drill down ↓</p>
      )}
    </div>
  );
}

// ─── LineChartWidget ──────────────────────────────────────────────────────────

function LineChartWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

  const chartData = data.rows.map((r) => ({ label: String(r.label ?? ''), value: Number(r.value ?? 0) }));
  const maxVal = Math.max(...chartData.map((r) => r.value), 0);
  const yFmt = (v: number) => (maxVal > 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(v: number) => [formatValue(v, spec.format), spec.title]}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="#3b82f6"
          strokeWidth={2}
          dot={{ r: 3, fill: '#3b82f6' }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── VerticalBarChartWidget ───────────────────────────────────────────────────

function VerticalBarChartWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

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
      <ComposedChart data={chartData} margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="30%">
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(v: number, name: string) => [formatValue(v, spec.format), name === 'value' ? spec.title : 'Target']}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
        <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
        {hasTarget && (
          <Line type="monotone" dataKey="target" stroke="#64748b" strokeWidth={2} strokeDasharray="4 2" dot={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ─── StackedBarChartWidget ─────────────────────────────────────────────────────

function StackedBarChartWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

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
      <BarChart data={pivoted} margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="30%">
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={yFmt} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(v: number, name: string) => [formatValue(v, spec.format), name]}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        {seriesNames.map((s, i) => (
          <Bar key={s} dataKey={s} stackId="a" fill={CHART_COLORS[i % CHART_COLORS.length]} radius={i === seriesNames.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── PieChartWidget ──────────────────────────────────────────────────────────

function PieChartWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

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
        >
          {chartData.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(v: number) => [formatValue(v, spec.format)]}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── TopListWidget ────────────────────────────────────────────────────────────

function TopListWidget({ spec, data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

  const rows = data.rows.slice(0, 10);

  return (
    <div className="space-y-0.5">
      {rows.map((row, i) => (
        <div
          key={i}
          className={`flex items-center justify-between px-2 py-1.5 rounded-md ${i % 2 === 0 ? 'bg-slate-50' : 'bg-white'}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-slate-400 w-5 shrink-0">{i + 1}.</span>
            <span className="text-sm text-slate-700 truncate">{String(row.label ?? '—')}</span>
          </div>
          <span className="text-sm font-semibold text-slate-900 shrink-0 ml-2">
            {formatValue(row.value, spec.format)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── DataTableWidget ──────────────────────────────────────────────────────────

function DataTableWidget({ data }: { spec: WidgetSpec; data: WidgetData }) {
  if (data.loading) return <WidgetSpinner />;
  if (data.error) return <WidgetError msg={data.error} />;
  if (!data.rows.length) return <p className="text-xs text-slate-400">No data</p>;

  const keys = Object.keys(data.rows[0]);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const headerLabel = (k: string) => capitalize(k.replace(/_/g, ' '));

  const isNumeric = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 300 }}>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="sticky top-0 bg-slate-50">
            {keys.map((k) => (
              <th key={k} className="px-2 py-1.5 text-left font-semibold text-slate-600 border-b border-slate-200 whitespace-nowrap">
                {headerLabel(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
              {keys.map((k) => (
                <td
                  key={k}
                  className={`px-2 py-1.5 text-slate-700 ${isNumeric(row[k]) ? 'text-right font-mono' : ''}`}
                >
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DashboardsPage() {
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
  const [drillState, setDrillState] = useState<DrillState | null>(null);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  async function executeWidget(widgetId: string, sql: string, filters: Record<string, string>) {
    setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: true } }));
    try {
      const res = await api.post('/dashboards/execute', {
        connectionId: CONNECTION_ID,
        sql,
        filterValues: filters,
      });
      setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: res.data.data.rows, loading: false } }));
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Query failed';
      setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: false, error: msg } }));
    }
  }

  // ── Execute all widgets ───────────────────────────────────────────────────

  const executeAllWidgets = useCallback(
    async (spec: DashboardSpec, filters: Record<string, string>, drill: DrillState | null) => {
      for (const widget of spec.widgets) {
        const isDrilled = drill?.widgetId === widget.id && widget.drillDownSql;
        const sql = isDrilled ? widget.drillDownSql! : widget.sql;
        const filterPayload = isDrilled ? { ...filters, drill_value: drill!.value } : filters;
        executeWidget(widget.id, sql, filterPayload);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Load filter options ───────────────────────────────────────────────────

  async function loadFilterOptions(filters: FilterSpec[]) {
    for (const f of filters) {
      if (f.type === 'select') {
        try {
          const res = await api.post('/dashboards/filter-options', {
            connectionId: CONNECTION_ID,
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
        connectionId: CONNECTION_ID,
        request: createInput.trim(),
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
        connectionId: CONNECTION_ID,
        request: createInput.trim(),
        answers: answers?.filter((a) => a.trim()),
      });
      const spec: DashboardSpec = res.data.data.spec;
      const defaults = buildDefaultFilters(spec.filters);
      setCurrentSpec(spec);
      setFilterValues(defaults);
      setDrillState(null);
      setIsUnsaved(true);
      setMode('viewing');
      loadFilterOptions(spec.filters);
      executeAllWidgets(spec, defaults, null);
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
        connectionId: CONNECTION_ID,
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
      setDrillState(null);
      setIsUnsaved(false);
      setActiveId(id);
      setMode('viewing');
      setChatMessages([]);
      loadFilterOptions(spec.filters);
      executeAllWidgets(spec, defaults, null);
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

  // ── Handle drill-down ─────────────────────────────────────────────────────

  function handleDrillDown(widgetId: string, value: string | null, spec: DashboardSpec) {
    if (!value) {
      setDrillState(null);
      if (currentSpec) executeAllWidgets(currentSpec, filterValues, null);
      return;
    }
    const widget = spec.widgets.find((w) => w.id === widgetId);
    const label =
      widget?.drillDownLabel?.replace('{{drill_value}}', value) ?? value;
    const newDrill = { widgetId, value, label };
    setDrillState(newDrill);
    if (currentSpec) executeAllWidgets(currentSpec, filterValues, newDrill);
  }

  // ── Handle filter change ──────────────────────────────────────────────────

  function handleFilterChange(key: string, value: string) {
    const newFilters = { ...filterValues, [key]: value };
    setFilterValues(newFilters);
    if (currentSpec) executeAllWidgets(currentSpec, newFilters, drillState);
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
        const res = await api.post('/query', { connectionId: CONNECTION_ID, question: fullQuestion });
        const answer: string = res.data.data?.answer ?? res.data.answer ?? 'No answer available.';
        setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_a', role: 'assistant', text: answer, type: 'query' }]);
      } else {
        const res = await api.post('/dashboards/refine-spec', { connectionId: CONNECTION_ID, refinement: input, currentSpec });
        const newSpec: DashboardSpec = res.data.data.spec;
        const defaults = buildDefaultFilters(newSpec.filters);
        setCurrentSpec(newSpec);
        setFilterValues(defaults);
        setDrillState(null);
        setIsUnsaved(true);
        loadFilterOptions(newSpec.filters);
        executeAllWidgets(newSpec, defaults, null);
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
    setIsAdmin(getTokenPayload()?.role === 'epicdata_admin');
    loadDashboards();
  }, [loadDashboards]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── Helper: discard unsaved dashboard ────────────────────────────────────

  function discardDashboard() {
    setCurrentSpec(null);
    setIsUnsaved(false);
    setActiveId(null);
    setMode('empty');
    setWidgetData({});
    setDrillState(null);
    setChatMessages([]);
  }

  // ── Helper: partition dashboards ─────────────────────────────────────────

  const favorites = dashboards.filter((d) => d.is_favorite);
  const regular = dashboards.filter((d) => !d.is_favorite);

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
          <p className={`text-sm font-medium truncate ${isActive ? 'text-blue-700' : 'text-slate-700'}`}>
            {d.title}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">{relTime(d.updated_at)}</p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
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
        </div>
      </button>
    );
  }

  // ── Create input row ──────────────────────────────────────────────────────

  function CreateInput({ compact }: { compact?: boolean }) {
    return (
      <div className={`flex gap-2 ${compact ? '' : 'w-full max-w-lg'}`}>
        <input
          ref={compact ? undefined : inputRef}
          type="text"
          value={createInput}
          onChange={(e) => setCreateInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && initiateCreate()}
          placeholder={compact ? 'Describe a dashboard…' : 'e.g. Sales overview by product and region'}
          className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white placeholder-slate-400"
          disabled={createLoading}
        />
        <button
          onClick={initiateCreate}
          disabled={createLoading || !createInput.trim()}
          className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {createLoading ? '…' : 'Go'}
        </button>
      </div>
    );
  }

  // ── Render widget by type ─────────────────────────────────────────────────

  function renderWidget(widget: WidgetSpec) {
    const data: WidgetData = widgetData[widget.id] ?? { rows: [], loading: true };
    const colSpan = widget.colSpan ?? 1;

    switch (widget.type) {
      case 'kpi_card':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <KpiCard spec={widget} data={data} />
          </WidgetCard>
        );

      case 'bar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <BarChartWidget
              spec={widget}
              data={data}
              onDrillDown={widget.drillDownSql ? (val) => handleDrillDown(widget.id, val, currentSpec!) : undefined}
              isDrilled={drillState?.widgetId === widget.id}
              drillLabel={drillState?.widgetId === widget.id ? drillState.label : undefined}
            />
          </WidgetCard>
        );

      case 'line_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <LineChartWidget spec={widget} data={data} />
          </WidgetCard>
        );

      case 'vertical_bar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <VerticalBarChartWidget spec={widget} data={data} />
          </WidgetCard>
        );

      case 'stacked_bar_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <StackedBarChartWidget spec={widget} data={data} />
          </WidgetCard>
        );

      case 'pie_chart':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <PieChartWidget spec={widget} data={data} />
          </WidgetCard>
        );

      case 'top_list':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <TopListWidget spec={widget} data={data} />
          </WidgetCard>
        );

      case 'data_table':
        return (
          <WidgetCard key={widget.id} spec={widget} colSpan={colSpan}>
            <DataTableWidget spec={widget} data={data} />
          </WidgetCard>
        );

      default:
        return null;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen overflow-hidden bg-slate-50 flex flex-col">
      <Nav />

      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 57px)' }}>

        {/* ── Left sidebar ── */}
        <aside className="w-56 bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden">
          {/* Sidebar header */}
          <div className="px-3 py-3 border-b border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Dashboards</span>
              <button
                onClick={() => { setMode('empty'); setActiveId(null); setCurrentSpec(null); setIsUnsaved(false); }}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                + New
              </button>
            </div>
            <CreateInput compact />
            {createError && <p className="text-xs text-red-500 mt-1">{createError}</p>}
          </div>

          {/* Dashboard list */}
          <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
            {favorites.length > 0 && (
              <>
                <p className="text-xs text-slate-400 uppercase tracking-wider px-1 py-1">⭐ Favorites</p>
                {favorites.map((d) => <DashboardListItem key={d.id} d={d} />)}
                {regular.length > 0 && <div className="my-2 border-t border-slate-100" />}
              </>
            )}
            {regular.map((d) => <DashboardListItem key={d.id} d={d} />)}
            {dashboards.length === 0 && (
              <p className="text-xs text-slate-400 text-center mt-4 px-2">
                No saved dashboards yet
              </p>
            )}
          </div>
        </aside>

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
                  <CreateInput />
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
                <p className="text-base font-semibold text-slate-800 mb-6 leading-snug">&ldquo;{createInput}&rdquo;</p>
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
              <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-start justify-between gap-4 shrink-0">
                <div className="min-w-0">
                  <h1 className="font-bold text-lg text-slate-900 leading-tight">{currentSpec.title}</h1>
                  {currentSpec.description && (
                    <p className="text-sm text-slate-500 mt-0.5 truncate">{currentSpec.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
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
                <div className="bg-white border-b border-slate-200 px-6 py-3 flex flex-wrap items-center gap-4 shrink-0">
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
              <div
                className="grid gap-4 p-4"
                style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
              >
                {currentSpec.widgets.map((widget) => renderWidget(widget))}
              </div>
              </div>

              {/* Bottom chat bar */}
              <div className="bg-white border-t border-slate-200 shrink-0">
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
                    className="flex-1 px-4 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white placeholder-slate-400 disabled:bg-slate-50 disabled:text-slate-400"
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
    </div>
  );
}
