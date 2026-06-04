'use client';

/**
 * MessageBubble — the assistant/user chat bubble and all its leaf helpers
 * (result chart + table, forecast chart, low-confidence guide, admin debug).
 *
 * Only `MessageBubble` is exported publicly; the helpers stay module-private.
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, PieChart, Pie, Cell,
  ResponsiveContainer, ComposedChart, Line, Area, ReferenceLine,
} from 'recharts';
import { Code, ThumbsUp, ThumbsDown, FileDown, BarChart3, LineChart as LineIcon, PieChart as PieIcon, Layers, Table as TableIcon, Eye, EyeOff } from 'lucide-react';
import { BoldText, ConfidenceBadge, QueryLayerBadge } from './components';
import { formatSql, formatCellValue, pickLabelColumn } from './utils';
import { OBSERVATORY, SERIES } from '@/lib/observatory';
import type { DebugInfo, ForecastData, Message, VisualizationHint, VisualizationType } from './types';
import InvestigationView from '@/components/investigate/InvestigationView';
import type { Investigation } from '@/lib/investigationTypes';

// ─── Technical-column detection ──────────────────────────────────────────────
//
// Safety net for when the NL→SQL prompt rules slip and a technical
// identifier (UUID, surrogate key) lands in the result. The toggle lets
// users opt back in for debugging.
//
// Detection is based on the column NAME + a sampled VALUE, since we
// don't have schema metadata at this layer:
//   - value matches a UUID/GUID pattern → technical
//   - column_name ends in `_key`        → technical (Kimball surrogate)
//   - column_name ends in `_id` AND value looks like a UUID → technical
//   - column_name is exactly `id`       → technical
// All other columns (including business identifiers like `invoice_number`,
// `customer_code`, `sku`) stay visible.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sampleValue(rows: Record<string, unknown>[], col: string): unknown {
  for (const r of rows) {
    const v = r[col];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function looksTechnical(col: string, sample: unknown): boolean {
  if (typeof sample === 'string' && UUID_RE.test(sample)) return true;
  const lower = col.toLowerCase();
  if (lower === 'id' || lower.endsWith('_key')) return true;
  if (lower.endsWith('_id') && typeof sample === 'string' && UUID_RE.test(sample)) return true;
  return false;
}

// ─── Result visualizer ───────────────────────────────────────────────────────

function ResultVisualizer({ rows, hint }: { rows: Record<string, unknown>[]; hint?: VisualizationHint }) {
  // ── Derive columns + numeric detection ──
  const { columns, numericCols, defaultLabelCol, defaultValueCol } = (() => {
    if (!rows || rows.length === 0) {
      return { columns: [] as string[], numericCols: [] as string[], defaultLabelCol: undefined as string | undefined, defaultValueCol: undefined as string | undefined };
    }
    const columns = Object.keys(rows[0]);
    const numericCols = columns.filter((col) =>
      rows.some((r) => r[col] !== null && r[col] !== undefined) &&
      rows.every((r) =>
        r[col] === null || r[col] === undefined ||
        typeof r[col] === 'number' ||
        (typeof r[col] === 'string' && !isNaN(Number(r[col])) && (r[col] as string) !== ''),
      ),
    );
    const labelCol = pickLabelColumn(columns, numericCols);
    const isPctCol = (c: string) => /(_pct|_percent|_percentage|_rate|_ratio|_share)$/i.test(c);
    const isIdCol  = (c: string) => /(_id|_key|_nr|_number|_code)$/i.test(c);
    const candidateValueCols = numericCols.filter((c) => !isIdCol(c));
    const absoluteCols = candidateValueCols.filter((c) => !isPctCol(c));
    const valueColPool = absoluteCols.length > 0 ? absoluteCols : candidateValueCols;
    const valueCol = valueColPool.length > 0
      ? valueColPool.reduce((best, col) => {
          const maxBest = Math.max(...rows.map((r) => Number(r[best]) || 0));
          const maxCol  = Math.max(...rows.map((r) => Number(r[col])  || 0));
          return maxCol > maxBest ? col : best;
        })
      : undefined;
    return { columns, numericCols, defaultLabelCol: labelCol, defaultValueCol: valueCol };
  })();

  // Resolve the columns the chart will use — hint takes priority, fall back to heuristics
  const xKey    = (hint?.xKey    && columns.includes(hint.xKey))    ? hint.xKey    : defaultLabelCol;
  const yKey    = (hint?.yKey    && columns.includes(hint.yKey))    ? hint.yKey    : defaultValueCol;
  const groupBy = (hint?.groupBy && columns.includes(hint.groupBy)) ? hint.groupBy : undefined;

  // Decide an initial chart type — hint wins, otherwise heuristic
  const heuristicType: VisualizationType = (() => {
    if (!xKey || !yKey) return 'table';
    if (rows.length > 60) return 'table';
    // Two-cat + numeric → stacked
    const otherCats = columns.filter((c) => c !== xKey && c !== yKey && !numericCols.includes(c));
    if (otherCats.length >= 1 && rows.length >= 2) return 'stacked_bar';
    return 'bar';
  })();
  const initialType: VisualizationType = hint?.type ?? heuristicType;

  const [active, setActive] = useState<VisualizationType>(initialType);

  if (!rows || rows.length === 0) return null;

  // ── Build chart-ready data per type ──
  const isPct = (c?: string) => !!c && /(_pct|_percent|_percentage|_rate|_ratio|_share)$/i.test(c);
  const tickFmt = (v: number) => {
    if (isPct(yKey)) return `${Number(v).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
  };

  // For stacked bar: pivot rows into one row per xKey with a column per groupBy value
  const pivoted = (() => {
    if (active !== 'stacked_bar' || !xKey || !yKey || !groupBy) return null;
    const map = new Map<string, Record<string, unknown>>();
    const groups = new Set<string>();
    for (const r of rows) {
      const x = String(r[xKey] ?? '');
      const g = String(r[groupBy] ?? '');
      groups.add(g);
      const acc = map.get(x) ?? { [xKey]: x };
      acc[g] = (Number(acc[g]) || 0) + (Number(r[yKey]) || 0);
      map.set(x, acc);
    }
    return { data: Array.from(map.values()), groups: Array.from(groups) };
  })();

  const chartH = Math.min(Math.max(rows.length * 26, 220), 360);
  const colourOf = (i: number) => SERIES[i % SERIES.length] ?? OBSERVATORY.ocean;

  // ── Toolbar ──
  const toolbarBtn = (t: VisualizationType, label: string, Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>) => {
    const ok = t === 'stacked_bar' ? !!groupBy : t === 'pie' ? !!xKey && !!yKey && rows.length <= 12 : t === 'table' ? true : !!xKey && !!yKey;
    if (!ok) return null;
    const isActive = active === t;
    return (
      <button
        key={t}
        onClick={() => setActive(t)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
          isActive ? 'bg-ocean text-white' : 'text-muted hover:text-ink hover:bg-softer'
        }`}
        title={label}
      >
        <Icon size={12} strokeWidth={2} className="-mt-px" />
        {label}
      </button>
    );
  };

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="flex items-center gap-1 -mb-1">
        {toolbarBtn('bar',         'Bar',     BarChart3)}
        {toolbarBtn('line',        'Line',    LineIcon)}
        {toolbarBtn('stacked_bar', 'Stacked', Layers)}
        {toolbarBtn('pie',         'Pie',     PieIcon)}
        {toolbarBtn('table',       'Table',   TableIcon)}
      </div>

      {active === 'bar' && xKey && yKey && (
        <div className="rounded-md bg-softer border border-line p-3">
          <ResponsiveContainer width="100%" height={chartH}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(13,28,47,0.08)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: OBSERVATORY.muted }} axisLine={false} tickLine={false} tickFormatter={tickFmt} />
              <YAxis type="category" dataKey={xKey} tick={{ fontSize: 10, fill: OBSERVATORY.ink }} width={140} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(value: unknown) => [formatCellValue(value, yKey), yKey.replace(/_/g, ' ')]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${OBSERVATORY.line}`, background: OBSERVATORY.raised }}
              />
              <Bar dataKey={yKey} fill={OBSERVATORY.ocean} radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {active === 'line' && xKey && yKey && (
        <div className="rounded-md bg-softer border border-line p-3">
          <ResponsiveContainer width="100%" height={chartH}>
            <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(13,28,47,0.08)" />
              <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: OBSERVATORY.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: OBSERVATORY.muted }} axisLine={false} tickLine={false} tickFormatter={tickFmt} />
              <Tooltip
                formatter={(value: unknown) => [formatCellValue(value, yKey), yKey.replace(/_/g, ' ')]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${OBSERVATORY.line}`, background: OBSERVATORY.raised }}
              />
              <Line type="monotone" dataKey={yKey} stroke={OBSERVATORY.ocean} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {active === 'stacked_bar' && pivoted && xKey && (
        <div className="rounded-md bg-softer border border-line p-3">
          <ResponsiveContainer width="100%" height={chartH}>
            <BarChart data={pivoted.data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(13,28,47,0.08)" />
              <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: OBSERVATORY.muted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: OBSERVATORY.muted }} axisLine={false} tickLine={false} tickFormatter={tickFmt} />
              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${OBSERVATORY.line}`, background: OBSERVATORY.raised }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {pivoted.groups.map((g, i) => (
                <Bar key={g} dataKey={g} stackId="a" fill={colourOf(i)} maxBarSize={36} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {active === 'pie' && xKey && yKey && (
        <div className="rounded-md bg-softer border border-line p-3">
          <ResponsiveContainer width="100%" height={chartH}>
            <PieChart>
              <Pie data={rows} dataKey={yKey} nameKey={xKey} outerRadius={Math.min(chartH / 2 - 24, 130)} label={(e: { name?: string }) => e.name ?? ''}>
                {rows.map((_, i) => <Cell key={i} fill={colourOf(i)} />)}
              </Pie>
              <Tooltip
                formatter={(value: unknown) => [formatCellValue(value, yKey), yKey.replace(/_/g, ' ')]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${OBSERVATORY.line}`, background: OBSERVATORY.raised }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      <ResultDataTable
        rows={rows}
        columns={columns}
        numericCols={numericCols}
      />
    </div>
  );
}

// ─── Result data table — with technical-column safety net ───────────────────
//
// Hides UUID / surrogate-key columns by default. The NL→SQL prompt
// forbids them in SELECT, but if one slips through (legacy product,
// AI mistake, debug request) the user shouldn't have to wade through
// columns of "f8706af1-74cf-..." to find a recognisable identifier.
// Toggle restores them for the curious / debugging.

function ResultDataTable({
  rows, columns, numericCols,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  numericCols: string[];
}) {
  const [showTechnical, setShowTechnical] = useState(false);

  // Detect technical-shape columns from name + sampled value. Computed
  // once per render — not in a useMemo because columns array shape is
  // stable for the bubble.
  const technicalCols = columns.filter((c) => looksTechnical(c, sampleValue(rows, c)));
  const visibleCols = showTechnical
    ? columns
    : columns.filter((c) => !technicalCols.includes(c));

  return (
    <div className="overflow-x-auto rounded-md border border-line text-[12px] bg-raised">
      <table className="w-full">
        <thead>
          <tr className="bg-softer border-b border-line">
            {visibleCols.map((col) => (
              <th key={col} className="px-3 py-2 text-left font-mono font-medium text-muted uppercase tracking-[0.08em] text-[10px]">
                {col.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={`border-b border-line last:border-0 ${i % 2 === 1 ? 'bg-softer/50' : ''}`}>
              {visibleCols.map((col) => (
                <td key={col} className={`px-3 py-2 ${numericCols.includes(col) ? 'text-right font-mono text-ink' : 'text-ink'}`}>
                  {formatCellValue(row[col], col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(technicalCols.length > 0 || rows.length >= 200) && (
        <div className="px-3 py-1.5 bg-softer border-t border-line flex items-center gap-3 text-[10px] font-mono tracking-[0.06em] uppercase text-muted">
          {rows.length >= 200 && <span>Showing first 200 rows</span>}
          {technicalCols.length > 0 && (
            <button
              type="button"
              onClick={() => setShowTechnical((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 hover:text-ink transition-colors"
              title={
                showTechnical
                  ? 'Hide technical ID columns (UUIDs, surrogate keys)'
                  : `Show ${technicalCols.length} hidden technical ID column${technicalCols.length === 1 ? '' : 's'}`
              }
            >
              {showTechnical
                ? <><EyeOff className="w-3 h-3" strokeWidth={2} /> Hide tech IDs</>
                : <><Eye className="w-3 h-3" strokeWidth={2} /> {technicalCols.length} hidden ID{technicalCols.length === 1 ? '' : 's'}</>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Forecast chart — Observatory-styled ─────────────────────────────────────

function ForecastChart({ forecast }: { forecast: ForecastData }) {
  // Merge historical and forecast into a single dataset for the ComposedChart
  const lastHistDate = forecast.historical.length > 0
    ? forecast.historical[forecast.historical.length - 1].date
    : null;

  const chartData = [
    ...forecast.historical.map((h) => ({
      date: h.date,
      historical: h.value,
      forecast: h.date === lastHistDate ? h.value : undefined as number | undefined,
      lower: undefined as number | undefined,
      upper: undefined as number | undefined,
      range: undefined as [number, number] | undefined,
    })),
    ...forecast.predicted.map((p) => ({
      date: p.date,
      historical: undefined as number | undefined,
      forecast: p.value,
      lower: p.lower,
      upper: p.upper,
      range: [p.lower, p.upper] as [number, number],
    })),
  ];

  const allValues = [
    ...forecast.historical.map((h) => h.value),
    ...forecast.predicted.map((p) => p.upper),
    ...forecast.predicted.map((p) => p.lower),
  ].filter((v) => v !== undefined && !isNaN(v));
  const minVal  = Math.min(...allValues);
  const maxVal  = Math.max(...allValues);
  const padding = (maxVal - minVal) * 0.1 || 1;

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="rounded-md bg-softer border border-line p-4">
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={chartData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
            <defs>
              <linearGradient id="forecastGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={OBSERVATORY.plum} stopOpacity={0.22} />
                <stop offset="95%" stopColor={OBSERVATORY.plum} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(13,28,47,0.08)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: OBSERVATORY.muted }}
              axisLine={{ stroke: OBSERVATORY.line }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: OBSERVATORY.muted }}
              axisLine={{ stroke: OBSERVATORY.line }}
              tickLine={false}
              domain={[Math.floor(minVal - padding), Math.ceil(maxVal + padding)]}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))}
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                borderRadius: 8,
                border: `1px solid ${OBSERVATORY.line}`,
                background: OBSERVATORY.raised,
                color: OBSERVATORY.ink,
              }}
              formatter={(value, name) => {
                if (name === 'range') return [null as unknown as string, null as unknown as string];
                const label = name === 'historical' ? 'Actual' : 'Forecast';
                const n = typeof value === 'number' ? value : Number(value);
                return [n.toLocaleString('en-US', { maximumFractionDigits: 2 }), label];
              }}
            />
            {/* Vertical reference line at the boundary between historical and forecast */}
            {lastHistDate && (
              <ReferenceLine
                x={lastHistDate}
                stroke={OBSERVATORY.muted2}
                strokeDasharray="6 4"
                strokeWidth={1.5}
                label={{
                  value: 'Forecast',
                  position: 'insideTopRight',
                  fill: OBSERVATORY.plum,
                  fontSize: 10,
                  fontWeight: 600,
                }}
              />
            )}
            {/* Confidence interval shaded area */}
            <Area
              type="monotone"
              dataKey="range"
              fill="url(#forecastGradient)"
              stroke="none"
              connectNulls={false}
              isAnimationActive={false}
            />
            {/* Historical line — solid ocean */}
            <Line
              type="monotone"
              dataKey="historical"
              stroke={OBSERVATORY.ocean}
              strokeWidth={2.5}
              dot={{ r: 3, fill: OBSERVATORY.ocean, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: OBSERVATORY.ocean, strokeWidth: 2, stroke: OBSERVATORY.raised }}
              connectNulls={false}
              isAnimationActive={false}
            />
            {/* Forecast line — dashed plum */}
            <Line
              type="monotone"
              dataKey="forecast"
              stroke={OBSERVATORY.plum}
              strokeWidth={2.5}
              strokeDasharray="8 4"
              dot={{ r: 3, fill: OBSERVATORY.plum, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: OBSERVATORY.plum, strokeWidth: 2, stroke: OBSERVATORY.raised }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {/* Forecast metadata bar */}
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded border font-mono font-semibold tracking-[0.06em] uppercase text-[10px]"
          style={{ background: `${OBSERVATORY.plum}18`, borderColor: OBSERVATORY.line, color: OBSERVATORY.plum }}
        >
          {forecast.method}
        </span>
        <span className="text-muted">
          {forecast.periods} {forecast.periodUnit}{forecast.periods !== 1 ? 's' : ''} ahead
        </span>
        {forecast.r2 > 0 && (
          <span className="text-muted-2">
            R² = {forecast.r2.toFixed(3)}
          </span>
        )}
        <div className="flex items-center gap-3 ml-auto text-[10px]">
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 rounded inline-block" style={{ background: OBSERVATORY.ocean }} />
            <span className="text-muted">Historical</span>
          </span>
          <span className="flex items-center gap-1">
            <span
              className="w-4 h-0.5 rounded inline-block"
              style={{ backgroundImage: `repeating-linear-gradient(90deg, ${OBSERVATORY.plum} 0, ${OBSERVATORY.plum} 4px, transparent 4px, transparent 8px)` }}
            />
            <span className="text-muted">Forecast</span>
          </span>
          <span className="flex items-center gap-1">
            <span
              className="w-3 h-3 rounded inline-block border"
              style={{ background: `${OBSERVATORY.plum}1a`, borderColor: OBSERVATORY.line }}
            />
            <span className="text-muted">95% CI</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Block reason + sub-scores + uncertainty notes ──────────────────────────

function BlockReasonPanel({ msg }: { msg: Message }) {
  const sub = msg.subScores;
  const subEntries = [
    { label: 'Schema',  v: sub?.schema },
    { label: 'Joins',   v: sub?.join },
    { label: 'Formula', v: sub?.formula },
  ].filter((e): e is { label: string; v: number } => typeof e.v === 'number');
  const notes = msg.uncertaintyNotes ?? [];
  if (!msg.flagReason && subEntries.length === 0 && notes.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-line bg-raised px-4 py-3 text-[12px] text-ink-2 space-y-2">
      {msg.flagReason && (
        <div>
          <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-warn">Why blocked</span>
          <p className="mt-1 leading-relaxed">{msg.flagReason}</p>
        </div>
      )}
      {subEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {subEntries.map((e) => {
            const pct = Math.round(e.v * 100);
            const low = e.v < 0.5;
            return (
              <span
                key={e.label}
                className={`px-2 py-0.5 rounded-md text-[11px] font-mono tracking-[0.04em] border ${
                  low ? 'bg-err-soft/30 border-err/40 text-err' : 'bg-canvas border-line text-ink-3'
                }`}
              >
                {e.label} {pct}%
              </span>
            );
          })}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="space-y-1 list-disc pl-4 text-ink-3">
          {notes.map((n, i) => (<li key={i}>{n}</li>))}
        </ul>
      )}
    </div>
  );
}

// ─── Low-confidence guide — Observatory-styled ──────────────────────────────

function LowConfidenceGuide({ confidence, debug }: { confidence?: number; debug?: DebugInfo }) {
  if (confidence === undefined || confidence >= 0.5) return null;
  const issues: string[] = [];
  if ((debug?.confirmedTables ?? 0) === 0)
    issues.push('No table definitions found — run Setup to profile your database first.');
  else if ((debug?.confirmedColumns ?? 0) === 0)
    issues.push('Column descriptions are missing — open Definitions → Tables & Columns.');
  if ((debug?.confirmedRelationships ?? 0) === 0 && (debug?.confirmedTables ?? 0) > 0)
    issues.push('No relationships defined — open Definitions → Relationships.');
  if ((debug?.confirmedKpis ?? 0) === 0 && (debug?.confirmedTables ?? 0) > 0)
    issues.push('No KPI formulas defined — open Definitions → KPIs.');

  return (
    <div className="mt-3 rounded-md border border-line bg-warn-soft px-4 py-3 text-[12px] text-ink-2 space-y-2">
      <p className="font-semibold flex items-center gap-1.5 text-warn">
        <span>📋</span> To help me answer this, verify your definitions:
      </p>
      {issues.length > 0 ? (
        <ul className="space-y-1.5">
          {issues.map((iss) => (
            <li key={iss} className="flex items-start gap-2">
              <span className="text-warn mt-0.5">›</span><span>{iss}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-3">
          Try rephrasing, or improve descriptions in{' '}
          <Link href="/catalog" className="underline text-ocean hover:text-ocean-hover">Definitions</Link>.
        </p>
      )}
      <Link
        href="/catalog"
        className="inline-flex items-center gap-1 mt-1 px-3 py-1.5 bg-raised border border-line rounded-md text-[11px] font-mono tracking-[0.06em] uppercase text-ink-2 hover:text-ocean hover:border-ocean/40 transition-colors"
      >
        Open Definitions →
      </Link>
    </div>
  );
}

// ─── Admin debug panel ───────────────────────────────────────────────────────

type DebugTab = 'stats' | 'sql' | 'tables' | 'relationships' | 'kpis';

function AdminDebugPanel({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(!!msg.blocked || !!msg.error);
  const d = msg.debug;

  const tabs = ([
    { id: 'stats',         label: 'Stats',         show: !!d },
    { id: 'sql',           label: 'SQL',           show: !!msg.sql },
    { id: 'tables',        label: 'Table context', show: !!(d?.semanticContext) },
    { id: 'relationships', label: 'Relationships', show: !!(d?.relationshipContext) },
    { id: 'kpis',          label: `KPIs (${d?.confirmedKpis ?? 0})`, show: !!(d?.kpiFormulas) },
  ] as Array<{ id: DebugTab; label: string; show: boolean }>).filter((t) => t.show);

  const [tab, setTab] = useState<DebugTab>(tabs[0]?.id ?? 'stats');
  useEffect(() => {
    if (!tabs.find((t) => t.id === tab) && tabs.length > 0) setTab(tabs[0].id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="bg-slate-900 rounded-xl text-xs overflow-hidden shadow-md">
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-slate-300 hover:text-white transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">⚙</span>
          <span className="font-semibold">Admin debug</span>
          {d?.confirmedTables === 0 && (
            <span className="bg-red-600 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide">No context</span>
          )}
        </div>
        <span className="text-slate-500 text-[10px]">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>

      {open && (
        <>
          {tabs.length === 0 && (
            <div className="p-3">
              <p className="text-red-400 font-semibold mb-2">⚠ No debug data received from backend</p>
              <pre className="text-slate-400 whitespace-pre-wrap break-all text-[10px] max-h-48 overflow-y-auto">
                {JSON.stringify({ sql: msg.sql, debug: msg.debug, confidence: msg.confidence }, null, 2)}
              </pre>
            </div>
          )}
          <div className="flex border-t border-b border-slate-800">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 text-[10px] font-semibold transition-colors ${tab === t.id ? 'text-white bg-slate-800 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="p-3">
            {tab === 'stats' && d && (
              <div className="space-y-1.5">
                {([
                  { label: 'Tables in context',        val: d.confirmedTables,        warn: d.confirmedTables === 0 },
                  { label: 'Columns in context',       val: d.confirmedColumns,       warn: d.confirmedColumns === 0 },
                  { label: 'Relationships in context', val: d.confirmedRelationships, warn: d.confirmedRelationships === 0 },
                  { label: 'KPIs in context',          val: d.confirmedKpis,          warn: false },
                ] as { label: string; val: number; warn: boolean }[]).map(({ label, val, warn }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-slate-400">{label}</span>
                    <span className={`font-bold tabular-nums ${warn ? 'text-red-400' : 'text-emerald-400'}`}>{val}</span>
                  </div>
                ))}
                <div className="mt-3 pt-2 border-t border-slate-800">
                  <p className="text-amber-400 leading-relaxed">{d.hint}</p>
                </div>
                {msg.tablesUsed && msg.tablesUsed.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="text-slate-500 mr-1">Claude used:</span>
                    {msg.tablesUsed.map((t) => (
                      <span key={t} className="bg-slate-700 text-slate-300 px-2 py-0.5 rounded font-mono">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab === 'sql' && msg.sql && (
              <pre className="text-emerald-400 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
                {formatSql(msg.sql)}
              </pre>
            )}
            {tab === 'tables' && d?.semanticContext && (
              <pre className="text-slate-300 whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-64 overflow-y-auto">
                {d.semanticContext}
              </pre>
            )}
            {tab === 'relationships' && d?.relationshipContext && (
              <pre className="text-slate-300 whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-64 overflow-y-auto">
                {d.relationshipContext}
              </pre>
            )}
            {tab === 'kpis' && d?.kpiFormulas && (
              <pre className="text-violet-300 whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-64 overflow-y-auto">
                {d.kpiFormulas}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Message bubble (public) ─────────────────────────────────────────────────

interface MessageBubbleProps {
  msg:            Message;
  showSql:        boolean;
  isAdmin:        boolean;
  onSend:         (q: string) => void;
  onFeedback:     (msgId: number, serverId: number, feedback: 'up' | 'down' | null, comment?: string) => void;
  onExport:       (format: 'csv' | 'xlsx', conversationId: number, messageServerId?: number) => void;
  conversationId: number | null;
  /** Optional: re-fetch a persisted investigation's full trail from
   *  /api/investigations/:id and hydrate the message in place. Called by
   *  the "Replay full trail" button on rehydrated investigate-mode
   *  messages whose steps[] is empty (steps aren't persisted row-by-row;
   *  only the conclusion + investigation_id survive). */
  onReplayInvestigation?: (msgId: number, investigationId: number) => Promise<void> | void;
}

export default function MessageBubble({
  msg, showSql, isAdmin, onSend, onFeedback, onExport, conversationId, onReplayInvestigation,
}: MessageBubbleProps) {
  const [sqlOpen,       setSqlOpen]       = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const brainRef = useRef<HTMLDivElement>(null);

  function toggleReasoning() {
    setReasoningOpen((o) => !o);
  }

  useEffect(() => {
    if (!reasoningOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (brainRef.current && !brainRef.current.contains(e.target as Node)) {
        setReasoningOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [reasoningOpen]);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] font-display italic text-[18px] leading-[1.4] text-ink-2 tracking-[-0.005em] py-1">
          {msg.text}
        </div>
      </div>
    );
  }

  // ── Investigate-mode message: embed the investigation trail inline ────────
  if (msg.mode === 'investigate' && msg.investigation) {
    const inv = msg.investigation;
    // Build a minimal Investigation shape from the message state for the
    // renderer. Once concluded, the full hydrated object lives at inv.full.
    const investigation: Investigation | null = inv.full ?? (
      inv.streamStatus === 'done' || inv.streamStatus === 'failed'
        ? {
            id: inv.id ?? 0,
            question: inv.question,
            focus: inv.focus,
            status: inv.streamStatus === 'done' ? 'concluded' : 'failed',
            conclusion: inv.conclusion,
            conclusion_confidence: inv.conclusionConfidence,
            failure_reason: inv.failureReason,
            steps: inv.steps,
          }
        : null
    );
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] w-full space-y-2">
          {/* Detective header — visible cue that this is investigate mode */}
          <div className="flex items-center gap-2 pl-1">
            <span className="text-[18px] leading-none" role="img" aria-label="Detective">🕵️</span>
            <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">
              Investigate mode
            </span>
            <StreamStatusPill status={inv.streamStatus} />
          </div>
          {/* Inline trail */}
          <div className="border border-line rounded-lg overflow-hidden bg-raised">
            <InvestigationView
              investigation={investigation}
              steps={inv.steps}
              streamStatus={inv.streamStatus}
              errorReason={inv.failureReason}
            />
          </div>
          {/* Replay full trail — only when this is a rehydrated message
              from history (steps weren't persisted row-by-row, only the
              conclusion + investigation_id survive in `debug` JSONB).
              Click fetches /api/investigations/:id and re-renders the
              steps inline, no slide-over. */}
          {inv.streamStatus === 'done'
            && inv.steps.length === 0
            && inv.id
            && onReplayInvestigation && (
            <div className="pl-1">
              <button
                onClick={async () => {
                  if (replayLoading) return;
                  setReplayLoading(true);
                  try { await onReplayInvestigation(msg.id, inv.id!); }
                  finally { setReplayLoading(false); }
                }}
                disabled={replayLoading}
                className="text-[11px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {replayLoading ? 'Loading trail…' : '→ Replay full trail'}
              </button>
            </div>
          )}
          {/* Follow-up chips after conclusion (Phase 2) */}
          {inv.streamStatus === 'done' && inv.conclusion && (
            <div className="pl-1 pt-1">
              <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 mb-2">
                Follow-up questions
              </div>
              <div className="flex flex-wrap gap-1.5">
                {/* Prefer the AI's context-aware follow-ups (written from the
                    trail); fall back to the heuristic only for older
                    investigations concluded before that shipped. */}
                {((inv.full?.conclusion_followups?.length
                    ? inv.full.conclusion_followups
                    : buildFollowUps()
                  )).map((fu) => (
                  <button
                    key={fu}
                    onClick={() => onSend(fu)}
                    className="px-2.5 py-1 text-[12px] font-medium rounded-md border border-line bg-raised text-ink-2 hover:bg-soft hover:border-ocean/40 transition-colors"
                  >
                    {fu}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (msg.blocked) {
    // ── Entity ambiguity: same name, multiple records ─────────────────────────
    if (msg.needsClarification && msg.ambiguities && msg.ambiguities.length > 0) {
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] space-y-2">
            <div className="bg-raised border border-line rounded-lg px-5 py-4 text-[14px] text-ink space-y-4">
              <div className="flex items-start gap-2">
                <span className="text-ocean mt-0.5 flex-shrink-0">🔎</span>
                <p className="leading-relaxed">
                  I found multiple records named{' '}
                  <span className="font-mono text-[12px] bg-ocean-softer px-1.5 py-0.5 rounded text-ocean">
                    &quot;{msg.ambiguities[0].literal}&quot;
                  </span>.
                  Which one did you mean?
                </p>
              </div>

              {msg.ambiguities.map((amb) => (
                <div key={amb.literal} className="space-y-2">
                  {amb.rows.map((row, idx) => {
                    // Pick the best label fields for display — exclude the matched col and long values
                    const SKIP = new Set([amb.columnName]);
                    const displayFields = Object.entries(row)
                      .filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined && String(v).length < 60)
                      .slice(0, 5);

                    // Build a disambiguated question using the primary key (id) if present
                    const idVal   = row['id'] ?? row['customer_id'] ?? row['ID'];
                    const cityVal = row['city'] ?? row['stad'] ?? row['gemeente'] ?? '';
                    const vatVal  = row['vat_number'] ?? row['btw_nummer'] ?? row['vat'] ?? '';
                    const suffix  = [
                      idVal   ? `ID ${idVal}`    : null,
                      cityVal ? String(cityVal)  : null,
                      vatVal  ? String(vatVal)   : null,
                    ].filter(Boolean).join(', ');

                    const correctedQ = idVal
                      ? `${msg.question ?? ''} (for ${amb.literal} with customer_id = ${idVal})`
                      : `${msg.question ?? ''} (${suffix})`;

                    return (
                      <button
                        key={idx}
                        onClick={() => onSend(correctedQ)}
                        className="w-full text-left px-4 py-3 bg-softer border border-line rounded-md hover:bg-ocean-softer hover:border-ocean/40 transition-colors group"
                      >
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            {displayFields.map(([k, v]) => (
                              <div key={k} className="flex gap-2 text-[11px]">
                                <span className="text-muted min-w-[80px] capitalize">{k.replace(/_/g, ' ')}</span>
                                <span className="text-ink font-medium">{String(v)}</span>
                              </div>
                            ))}
                          </div>
                          <span className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean ml-4 flex-shrink-0">
                            Use this →
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}

              <p className="text-[11px] font-mono tracking-[0.06em] uppercase text-muted pl-1">
                Click a record to re-run your question filtered to that specific entry.
              </p>
            </div>
            {isAdmin && <AdminDebugPanel msg={msg} />}
          </div>
        </div>
      );
    }

    // ── Entity pre-flight: unrecognised literal with fuzzy alternatives ────────
    if (msg.needsClarification && msg.mismatches && msg.mismatches.length > 0) {
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] space-y-2">
            <div className="bg-raised border border-line rounded-lg px-5 py-4 text-[14px] text-ink space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-ocean mt-0.5 flex-shrink-0">🔎</span>
                <p className="leading-relaxed">
                  I couldn&apos;t find an exact match in your data. Did you mean one of these?
                </p>
              </div>
              {msg.mismatches.map((m) => (
                <div key={m.literal} className="pl-6 space-y-1.5">
                  <p className="text-[11px] font-mono tracking-[0.06em] uppercase text-muted">
                    Instead of <span className="font-mono normal-case tracking-normal text-[12px] bg-softer px-1.5 py-0.5 rounded text-ink">&quot;{m.literal}&quot;</span>:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {m.alternatives.map((alt) => {
                      const correctedQ = (msg.question ?? '').replace(
                        new RegExp(m.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                        alt,
                      ) || `${msg.question ?? ''} (about "${alt}")`;
                      return (
                        <button
                          key={alt}
                          onClick={() => onSend(correctedQ)}
                          className="px-2.5 py-1 bg-ocean text-white text-[12px] font-medium rounded-md hover:bg-ocean-hover transition-colors"
                        >
                          {alt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="pl-6 text-[11px] font-mono tracking-[0.06em] uppercase text-muted">
                Click a suggestion to re-run the question with the correct name, or type a new question below.
              </p>
            </div>
            {isAdmin && <AdminDebugPanel msg={msg} />}
          </div>
        </div>
      );
    }

    // ── Standard blocked / low-confidence ────────────────────────────────────
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] space-y-2">
          <div className="bg-warn-soft border border-line rounded-lg px-5 py-4 text-[14px] text-ink-2">
            <div className="flex items-start gap-2">
              <span className="text-warn mt-0.5 flex-shrink-0">⚠</span>
              <p className="leading-relaxed">{msg.text}</p>
            </div>
            {(msg.confidence !== undefined || msg.queryLayer) && (
              <div className="mt-2 pl-5 flex items-center gap-2">
                {msg.confidence !== undefined && <ConfidenceBadge value={msg.confidence} />}
                {msg.queryLayer && <QueryLayerBadge layer={msg.queryLayer} />}
              </div>
            )}
            <BlockReasonPanel msg={msg} />
            <LowConfidenceGuide confidence={msg.confidence} debug={msg.debug} />
          </div>
          {isAdmin && <AdminDebugPanel msg={msg} />}
        </div>
      </div>
    );
  }

  if (msg.error) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-err-soft border border-line rounded-lg px-5 py-4 text-[14px] text-ink-2">
          <div className="flex items-start gap-2">
            <span className="flex-shrink-0 mt-0.5 text-err">✕</span>
            <p className="leading-relaxed">{msg.text}</p>
          </div>
          {isAdmin && (msg.errorDetail || msg.errorStack) && (
            <ErrorDetail detail={msg.errorDetail} stack={msg.errorStack} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-2 items-start">
      {/* Left column: brain button — speech bubble floats absolutely so layout never shifts */}
      <div ref={brainRef} className="relative flex-shrink-0 pt-1">
        {msg.reasoning ? (
          <button
            onClick={toggleReasoning}
            title={reasoningOpen ? 'Hide reasoning' : 'Show reasoning'}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
              reasoningOpen
                ? 'bg-ai text-white shadow-2'
                : 'bg-ai-soft hover:bg-ai/15 border border-line'
            }`}
          >
            <span className="text-sm leading-none">🧠</span>
          </button>
        ) : (
          <div className="w-7" />
        )}

        {/* Comic speech bubble — absolutely positioned, overlays chat, never shifts layout */}
        {reasoningOpen && msg.reasoning && (
          <div
            className="absolute z-30 top-0 left-9 w-72"
            style={{ filter: 'drop-shadow(0 6px 18px rgba(13,28,47,0.12))' }}
          >
            {/* Tail pointing left toward the brain */}
            <div className="absolute -left-[9px] top-[10px] w-0 h-0"
              style={{ borderTop:'8px solid transparent', borderBottom:'8px solid transparent', borderRight:'9px solid var(--line)' }} />
            <div className="absolute -left-[7px] top-[11px] w-0 h-0"
              style={{ borderTop:'7px solid transparent', borderBottom:'7px solid transparent', borderRight:'8px solid var(--surface-raised)' }} />

            {/* Bubble body */}
            <div className="bg-raised border border-line rounded-lg overflow-hidden shadow-2">
              <div className="px-3 py-1.5 bg-softer border-b border-line flex items-center gap-1.5">
                <span className="text-[9px] font-mono font-semibold text-ai uppercase tracking-[0.12em]">Reasoning</span>
              </div>
              <div className="px-3 py-2.5 max-h-64 overflow-y-auto">
                <p className="text-[11px] text-ink-3 leading-relaxed whitespace-pre-wrap">
                  {msg.reasoning}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right column: answer bubble — shape never changes */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className={`bg-raised border border-line rounded-lg px-5 py-4 text-[14px] space-y-3 ${
          msg.wasRepaired ? 'border-l-2 border-l-ocean' : ''
        }`}>
          {msg.wasRepaired && (
            <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.08em] uppercase text-ok">
              <span>✓</span> Corrected after investigation
            </div>
          )}
          <p className="text-ink leading-relaxed"><BoldText text={msg.text} /></p>

          {/* Clarify intent — show ambiguity + clickable interpretation chips.
              The chips send the interpretation as a follow-up message via onSend,
              which goes through the existing conversation-history flow so Claude
              has full context for the next turn. */}
          {msg.intent === 'clarify' && msg.options && msg.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {msg.options.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => onSend(opt.interpretation)}
                  className="px-3 py-1.5 rounded-md border border-ocean/30 bg-ocean-softer/40 text-[12px] text-ocean hover:bg-ocean-softer hover:border-ocean/60 transition-colors text-left"
                  title={opt.interpretation}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {msg.forecast
            ? <ForecastChart forecast={msg.forecast} />
            : (msg.rows && msg.rows.length > 0 && (
                isKpiShaped(msg.rows)
                  ? <AnswerKpis row={msg.rows[0]} />
                  : <ResultVisualizer rows={msg.rows} hint={msg.visualization} />
              ))}

          {/* Assumptions footnote — small italic line under the answer.
              Stays subtle so it doesn't compete with the main result. Each
              assumption stands on its own line for scanability. */}
          {msg.assumptions && msg.assumptions.length > 0 && (
            <div className="text-[11px] text-ink-3 italic leading-relaxed border-t border-line/60 pt-2">
              <span className="font-mono not-italic uppercase tracking-[0.08em] text-muted text-[10px] mr-1">Assumed</span>
              {msg.assumptions.map((a, i) => (
                <span key={i} className="block">— {a}</span>
              ))}
            </div>
          )}

          {msg.warning && !msg.wasRepaired && (
            <div className="flex items-start gap-2 bg-warn-soft border border-line rounded-md px-3 py-2 text-[12px] text-ink-2">
              <span className="flex-shrink-0 mt-0.5 text-warn">⚠</span>
              <span>{msg.warning}</span>
            </div>
          )}
          {isAdmin && (msg.confidence !== undefined || msg.sql) && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line">
              {msg.confidence !== undefined && <ConfidenceBadge value={msg.confidence} />}
              {msg.queryLayer && <QueryLayerBadge layer={msg.queryLayer} />}
              {msg.tablesUsed && msg.tablesUsed.length > 0 && (
                <span className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted">tables: {msg.tablesUsed.join(', ')}</span>
              )}
              {msg.sql && showSql && (
                <button onClick={() => setSqlOpen((o) => !o)}
                  className="ml-auto text-[10px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ocean transition-colors flex items-center gap-1">
                  <Code className="w-3 h-3" strokeWidth={2} />
                  {sqlOpen ? 'Hide SQL' : 'View SQL'}
                </button>
              )}
            </div>
          )}
          {isAdmin && showSql && sqlOpen && msg.sql && (
            <pre className="text-[11px] bg-ink text-white/90 rounded-md p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed font-mono">
              {formatSql(msg.sql)}
            </pre>
          )}
          {/* Feedback + Export row */}
          {msg.role === 'assistant' && !msg.error && !msg.blocked && (
            <div className="flex items-center gap-2 pt-2 border-t border-line">
              {/* Feedback buttons */}
              {msg.serverId && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onFeedback(msg.id, msg.serverId!, msg.feedback === 'up' ? null : 'up')}
                    className={`p-1 rounded transition-colors ${msg.feedback === 'up' ? 'text-ok bg-ok-soft' : 'text-muted-2 hover:text-ok'}`}
                    title="Good answer"
                  >
                    <ThumbsUp
                      className="w-3.5 h-3.5"
                      strokeWidth={2}
                      fill={msg.feedback === 'up' ? 'currentColor' : 'none'}
                    />
                  </button>
                  <button
                    onClick={() => onFeedback(msg.id, msg.serverId!, msg.feedback === 'down' ? null : 'down')}
                    className={`p-1 rounded transition-colors ${msg.feedback === 'down' ? 'text-err bg-err-soft' : 'text-muted-2 hover:text-err'}`}
                    title="Incorrect answer"
                  >
                    <ThumbsDown
                      className="w-3.5 h-3.5"
                      strokeWidth={2}
                      fill={msg.feedback === 'down' ? 'currentColor' : 'none'}
                    />
                  </button>
                  {msg.feedback && (
                    <span className={`text-[10px] font-mono tracking-[0.06em] uppercase ml-1 ${msg.feedback === 'up' ? 'text-ok' : 'text-err'}`}>
                      {msg.feedback === 'up' ? 'Helpful' : 'Reported'}
                    </span>
                  )}
                </div>
              )}
              {/* Why? chip — escalates the answered question into an investigation.
                  The heuristic classifier in `lib/questionMode.ts` picks up the
                  "why" prefix and routes back to investigate mode (when a
                  product context is active). */}
              {msg.question && !msg.error && !msg.blocked && (
                <button
                  onClick={() => onSend(`Why ${cleanForWhy(msg.question!)}?`)}
                  className="ml-2 flex items-center gap-1 px-2 py-1 text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 hover:text-ocean hover:bg-ocean-softer rounded transition-colors"
                  title="Investigate the cause"
                >
                  <span aria-hidden="true">🕵️</span>
                  Why?
                </button>
              )}
              {/* Export buttons */}
              {msg.rows && msg.rows.length > 0 && conversationId && (
                <div className="flex items-center gap-1 ml-auto">
                  <button
                    onClick={() => onExport('csv', conversationId, msg.serverId)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ocean hover:bg-ocean-softer rounded transition-colors"
                    title="Export as CSV"
                  >
                    <FileDown className="w-3 h-3" strokeWidth={2} />
                    CSV
                  </button>
                  <button
                    onClick={() => onExport('xlsx', conversationId, msg.serverId)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ok hover:bg-ok-soft rounded transition-colors"
                    title="Export as Excel"
                  >
                    <FileDown className="w-3 h-3" strokeWidth={2} />
                    Excel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {isAdmin && <AdminDebugPanel msg={msg} />}
      </div>
    </div>
  );
}

// Admin/analyst-only — surfaces the real backend error so query failures
// can be diagnosed without tailing container logs.
function ErrorDetail({ detail, stack }: { detail?: string; stack?: string }) {
  const [open, setOpen] = useState(false);
  const [showStack, setShowStack] = useState(false);
  return (
    <div className="mt-2.5 text-[12px]">
      <button
        onClick={() => setOpen(!open)}
        className="font-mono text-[10px] uppercase tracking-wider text-err hover:underline"
      >
        {open ? 'hide details' : 'show error details'}
      </button>
      {open && (
        <div className="mt-1.5 px-2.5 py-2 rounded bg-white border border-line space-y-2">
          {detail && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted mb-1">Error</div>
              <pre className="font-mono text-[11px] whitespace-pre-wrap break-words text-ink leading-snug">
                {detail}
              </pre>
            </div>
          )}
          {stack && (
            <div>
              <button
                onClick={() => setShowStack(!showStack)}
                className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
              >
                {showStack ? 'hide stack' : 'show stack'}
              </button>
              {showStack && (
                <pre className="mt-1 font-mono text-[10px] whitespace-pre-wrap break-words text-muted2 leading-snug max-h-60 overflow-y-auto">
                  {stack}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── KPI tiles for single-row aggregate answers ─────────────────────────────
//
// When a question like "what was our gross margin last month?" returns a
// single row with multiple numeric columns, the result is KPI-shaped, not
// chart-shaped. Render it as a tile grid (Revenue · Cost · Gross margin ·
// Top mover) to match the marketing journey's "answer leads with the
// numbers, not a table" pattern.
//
// Heuristic: rows.length === 1 AND ≥2 columns AND ≥1 of them is numeric
// (excluding id-shaped columns that AI sometimes leaks into aggregates).
// Multi-row responses still go to ResultVisualizer for chart/table.

function isKpiShaped(rows: Record<string, unknown>[]): boolean {
  if (!rows || rows.length !== 1) return false;
  const row = rows[0];
  const cols = Object.keys(row);
  if (cols.length < 2 || cols.length > 6) return false;
  const isIdCol = (c: string) => /(_id|_key|_nr|_number|_code|^id$)/i.test(c);
  const isNumeric = (v: unknown) =>
    typeof v === 'number'
    || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)));
  // Need at least one numeric non-id column for the grid to make sense.
  const numericNonId = cols.filter((c) => !isIdCol(c) && isNumeric(row[c]));
  return numericNonId.length >= 1;
}

function AnswerKpis({ row }: { row: Record<string, unknown> }) {
  const isIdCol = (c: string) => /(_id|_key|_nr|_number|_code|^id$)/i.test(c);
  const entries = Object.entries(row)
    .filter(([k, v]) => v != null && v !== '' && !isIdCol(k))
    .slice(0, 6);
  if (entries.length === 0) return null;
  // 4 cols on wide screens, 2 on narrow. Mirrors the journey's KPI strip.
  const gridCols = entries.length >= 4 ? 'sm:grid-cols-4' : entries.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';
  return (
    <div className={`grid grid-cols-2 ${gridCols} gap-2 mt-3`}>
      {entries.map(([key, value]) => (
        <div key={key} className="bg-raised border border-line rounded-md px-3 py-2.5">
          <p className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted leading-tight mb-1.5">
            {humaniseKpiLabel(key)}
          </p>
          <p className="font-mono text-[20px] leading-none tabular-nums tracking-[-0.01em] text-ink">
            {formatKpiValue(value, key)}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Convert a column key like "gross_margin_pct" → "Gross margin %" for the tile label. */
function humaniseKpiLabel(key: string): string {
  let label = key.replace(/_/g, ' ').trim();
  // Common suffix → percent symbol replacement at the end of the label.
  if (/(_pct|_percent|_percentage|_rate|_ratio|_share)$/i.test(key)) {
    label = label.replace(/(pct|percent|percentage|rate|ratio|share)$/i, '').trim() + ' %';
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Format a value with the right precision + currency / percent hints based
 *  on the column key. Falls back to the existing formatCellValue. */
function formatKpiValue(value: unknown, key: string): string {
  if (value == null || value === '') return '—';
  const isPct = /(_pct|_percent|_percentage|_rate|_ratio|_share)$/i.test(key);
  const isMoney = /(amount|revenue|cost|price|total|value|spend|cogs|gmv|arr|mrr)/i.test(key);
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(num)) {
    if (isPct) return `${num.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
    if (isMoney) {
      if (Math.abs(num) >= 1_000_000) return `€${(num / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })}M`;
      if (Math.abs(num) >= 1_000) return `€${(num / 1_000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k`;
      return `€${num.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
    }
    if (Math.abs(num) >= 10_000) return num.toLocaleString('en-GB', { maximumFractionDigits: 0 });
    return num.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  }
  return formatCellValue(value);
}

// ─── Helpers for investigate-mode messages ──────────────────────────────────

function StreamStatusPill({ status }: { status: 'idle' | 'starting' | 'running' | 'done' | 'failed' }) {
  const map: Record<string, { label: string; cls: string }> = {
    starting:  { label: 'starting',  cls: 'bg-ocean/10 text-ocean border-ocean/20' },
    running:   { label: 'running',   cls: 'bg-ocean/10 text-ocean border-ocean/20' },
    done:      { label: 'concluded', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    failed:    { label: 'failed',    cls: 'bg-red-50 text-red-700 border-red-200' },
    idle:      { label: '',          cls: '' },
  };
  const v = map[status] ?? map.idle;
  if (!v.label) return null;
  return (
    <span className={`px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.1em] rounded border ${v.cls}`}>
      {v.label}
    </span>
  );
}

/**
 * Strip a leading "Why" / "How come" / "Investigate" / question mark so we
 * can re-prefix it cleanly. Used by the "Why?" escalate chip to convert
 * "Revenue last month?" into "Why Revenue last month?".
 */
function cleanForWhy(q: string): string {
  return q
    .replace(/^\s*(why|how come|investigate|explain|tell me why|find out why)\b[\s,:]*/i, '')
    .replace(/\?+\s*$/, '')
    .trim();
}

/**
 * Fallback follow-up chips for investigations concluded before the AI
 * started writing its own (see conclusion_followups). Deliberately
 * standalone — "this" refers to the conclusion just shown — so they're
 * always grammatical, unlike the old version which interpolated the raw
 * question into "Show me <X> broken down by month" and produced nonsense
 * for diagnostic asks like "why don't you show any data?".
 */
function buildFollowUps(): string[] {
  return [
    'Break this down by month',
    'Which segments contributed most?',
    'How does this compare to last year?',
  ];
}
