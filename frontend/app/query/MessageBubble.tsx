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
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ComposedChart, Line, Area, ReferenceLine,
} from 'recharts';
import { Code, ThumbsUp, ThumbsDown, FileDown } from 'lucide-react';
import { BoldText, ConfidenceBadge, QueryLayerBadge } from './components';
import { formatSql, formatCellValue } from './utils';
import { OBSERVATORY } from '@/lib/observatory';
import type { DebugInfo, ForecastData, Message } from './types';

// ─── Result visualizer ───────────────────────────────────────────────────────

function ResultVisualizer({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows || rows.length === 0) return null;
  const columns = Object.keys(rows[0]);
  const numericCols = columns.filter((col) =>
    rows.some((r) => r[col] !== null && r[col] !== undefined) &&
    rows.every((r) =>
      r[col] === null || r[col] === undefined ||
      typeof r[col] === 'number' ||
      (typeof r[col] === 'string' && !isNaN(Number(r[col])) && (r[col] as string) !== ''),
    ),
  );
  const labelCol = columns.find((c) => !numericCols.includes(c));
  const valueCol = numericCols.length > 0
    ? numericCols.reduce((best, col) => {
        const maxBest = Math.max(...rows.map((r) => Number(r[best]) || 0));
        const maxCol  = Math.max(...rows.map((r) => Number(r[col])  || 0));
        return maxCol > maxBest ? col : best;
      })
    : undefined;
  const showChart = !!(labelCol && valueCol && rows.length >= 2 && rows.length <= 25);
  const chartData = showChart ? rows.map((r) => ({ ...r, [valueCol!]: Number(r[valueCol!]) })) : [];
  const chartH    = showChart ? Math.min(rows.length * 34 + 48, 320) : 0;

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      {showChart && (
        <div className="rounded-md bg-softer border border-line p-3">
          <ResponsiveContainer width="100%" height={chartH}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(13,28,47,0.08)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: OBSERVATORY.muted }} axisLine={false} tickLine={false}
                tickFormatter={(v) => Math.abs(v) >= 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v)} />
              <YAxis type="category" dataKey={labelCol} tick={{ fontSize: 10, fill: OBSERVATORY.ink }} width={130} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(value: unknown) => [formatCellValue(value), valueCol!.replace(/_/g, ' ')]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${OBSERVATORY.line}`, background: OBSERVATORY.raised }}
              />
              <Bar dataKey={valueCol!} fill={OBSERVATORY.ocean} radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-line text-[12px] bg-raised">
        <table className="w-full">
          <thead>
            <tr className="bg-softer border-b border-line">
              {columns.map((col) => (
                <th key={col} className="px-3 py-2 text-left font-mono font-medium text-muted uppercase tracking-[0.08em] text-[10px]">
                  {col.replace(/_/g, ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`border-b border-line last:border-0 ${i % 2 === 1 ? 'bg-softer/50' : ''}`}>
                {columns.map((col) => (
                  <td key={col} className={`px-3 py-2 ${numericCols.includes(col) ? 'text-right font-mono text-ink' : 'text-ink'}`}>
                    {formatCellValue(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length >= 200 && (
          <p className="text-center text-[10px] font-mono tracking-[0.06em] uppercase text-muted py-1.5 bg-softer border-t border-line">
            Showing first 200 rows
          </p>
        )}
      </div>
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
          <Link href="/semantic" className="underline text-ocean hover:text-ocean-hover">Definitions</Link>.
        </p>
      )}
      <Link
        href="/semantic"
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
}

export default function MessageBubble({
  msg, showSql, isAdmin, onSend, onFeedback, onExport, conversationId,
}: MessageBubbleProps) {
  const [sqlOpen,       setSqlOpen]       = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
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
          {msg.forecast ? <ForecastChart forecast={msg.forecast} /> : (msg.rows && msg.rows.length > 0 && <ResultVisualizer rows={msg.rows} />)}
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
