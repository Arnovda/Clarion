'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { getToken, getTokenPayload } from '@/lib/auth';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ─── Constants ────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

interface DataSource {
  type: 'connection' | 'view';
  id: number;
  label: string;
}

function SourceSelector({
  sources,
  selectedId,
  onChange,
}: {
  sources: DataSource[];
  selectedId: string;  // "c:1" or "v:2"
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={selectedId}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400 max-w-[200px]"
    >
      {sources.filter((s) => s.type === 'connection').length > 0 && (
        <optgroup label="Single source">
          {sources.filter((s) => s.type === 'connection').map((s) => (
            <option key={`c:${s.id}`} value={`c:${s.id}`}>{s.label}</option>
          ))}
        </optgroup>
      )}
      {sources.filter((s) => s.type === 'view').length > 0 && (
        <optgroup label="Integration views">
          {sources.filter((s) => s.type === 'view').map((s) => (
            <option key={`v:${s.id}`} value={`v:${s.id}`}>🔗 {s.label}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

const STARTERS = [
  'Who are my top 5 customers by total order value?',
  'What was total revenue last month?',
  'Which products have the highest profit margin?',
  'How many orders did we process this quarter?',
  'What is the average order value per customer?',
  'Which invoices are still unpaid?',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface DebugInfo {
  confirmedTables:        number;
  confirmedColumns:       number;
  confirmedRelationships: number;
  confirmedKpis:          number;
  hint:                   string;
  semanticContext:        string;
  relationshipContext:    string;
  kpiFormulas?:           string;
}

interface EntityMismatch {
  literal:      string;
  alternatives: string[];
}

interface EntityAmbiguity {
  literal:     string;
  tableName:   string;
  columnName:  string;
  rows:        Record<string, unknown>[];
}

interface Message {
  id:                  number;
  role:                'user' | 'assistant';
  text:                string;
  question?:           string;            // stored on assistant messages for repair
  sql?:                string;
  tablesUsed?:         string[];
  confidence?:         number;
  warning?:            string;
  blocked?:            boolean;
  needsClarification?: boolean;           // entity pre-flight: mismatch or ambiguity
  mismatches?:         EntityMismatch[];  // unrecognised literals + fuzzy alternatives
  ambiguities?:        EntityAmbiguity[]; // literals that matched multiple rows
  error?:              boolean;
  debug?:              DebugInfo;
  rows?:               Record<string, unknown>[];
  wasRepaired?:        boolean;           // prevents re-triggering repair on already-fixed answers
  reasoning?:          string;            // Claude's extended thinking, stored for replay
  queryLayer?:         'product' | 'source'; // which data layer was queried
  feedback?:           'up' | 'down' | null; // user feedback
  feedbackComment?:    string;
  serverId?:           number;            // DB id from conversation_messages table
}

interface Conversation {
  id:        number;          // server-side DB id
  title:     string;
  starred:   boolean;
  createdAt: string;
  updatedAt: string;
  messages:  Message[];
}

// ── Ephemeral repair state — never serialised ──────────────────────────────

type RepairEventKind =
  | { kind: 'thinking';     text: string }
  | { kind: 'data_query';   sql: string }
  | { kind: 'query_result'; rows: Record<string, unknown>[]; rowCount: number }
  | { kind: 'revised_sql';  sql: string }
  | { kind: 'clarification'; question: string };

interface RepairState {
  forMessageId:          number;
  events:                RepairEventKind[];
  isActive:              boolean;
  pendingClarification?: string;
  pendingHistory?:       Array<{ role: 'user' | 'assistant'; content: string }>;
}

// ─── SQL formatter ────────────────────────────────────────────────────────────

function formatSql(raw: string): string {
  let sql = raw.replace(/\s+/g, ' ').trim();
  const breaks = [
    'SELECT', 'FROM',
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'JOIN',
    'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
    'UNION ALL', 'UNION', 'EXCEPT', 'INTERSECT',
  ];
  for (const kw of breaks) {
    sql = sql.replace(new RegExp(`\\b(${kw})\\b`, 'gi'), `\n$1`);
  }
  return sql.split('\n').map((l, i) => (i === 0 ? l : '  ' + l.trim())).join('\n').trim();
}

// ─── Bold-text renderer ───────────────────────────────────────────────────────

function BoldText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**')
          ? <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}

// ─── Cell formatter ───────────────────────────────────────────────────────────

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)))) {
    const n = Number(v);
    if (Math.abs(n) >= 10 && String(v).includes('.'))
      return `€${n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return n.toLocaleString('nl-BE', { maximumFractionDigits: 2 });
  }
  return String(v);
}

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
    <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
      {showChart && (
        <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
          <ResponsiveContainer width="100%" height={chartH}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false}
                tickFormatter={(v) => Math.abs(v) >= 1000 ? `€${(v / 1000).toFixed(1)}k` : String(v)} />
              <YAxis type="category" dataKey={labelCol} tick={{ fontSize: 10, fill: '#475569' }} width={130} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(value: unknown) => [formatCellValue(value), valueCol!.replace(/_/g, ' ')]}
                contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e2e8f0' }}
              />
              <Bar dataKey={valueCol!} fill="#3b82f6" radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 text-xs">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {columns.map((col) => (
                <th key={col} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wide text-[10px]">
                  {col.replace(/_/g, ' ')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`border-b border-slate-100 last:border-0 ${i % 2 === 1 ? 'bg-slate-50/50' : 'bg-white'}`}>
                {columns.map((col) => (
                  <td key={col} className={`px-3 py-2 ${numericCols.includes(col) ? 'text-right font-mono text-slate-700' : 'text-slate-700'}`}>
                    {formatCellValue(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length >= 200 && (
          <p className="text-center text-[10px] text-slate-400 py-1.5 bg-slate-50 border-t border-slate-200">
            Showing first 200 rows
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ value }: { value: number }) {
  const pct   = Math.round(value * 100);
  const color = value >= 0.85 ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
              : value >= 0.70 ? 'text-amber-600  bg-amber-50  border-amber-200'
              :                 'text-red-500    bg-red-50    border-red-200';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${color}`}>
      <span className="opacity-60">confidence</span> {pct}%
    </span>
  );
}

// ─── Query layer badge ───────────────────────────────────────────────────────

function QueryLayerBadge({ layer }: { layer: 'product' | 'source' }) {
  const isProduct = layer === 'product';
  const color = isProduct
    ? 'text-violet-600 bg-violet-50 border-violet-200'
    : 'text-slate-500 bg-slate-50 border-slate-200';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${color}`}>
      {isProduct ? '⭐ Star Schema' : '📦 Source'}
    </span>
  );
}

// ─── Low-confidence guide ─────────────────────────────────────────────────────

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
    <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-xs text-orange-900 space-y-2">
      <p className="font-semibold flex items-center gap-1.5">📋 To help me answer this, verify your definitions:</p>
      {issues.length > 0 ? (
        <ul className="space-y-1.5">
          {issues.map((iss) => (
            <li key={iss} className="flex items-start gap-2">
              <span className="text-orange-400 mt-0.5">›</span><span>{iss}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-orange-700">
          Try rephrasing, or improve descriptions in{' '}
          <Link href="/semantic" className="underline">Definitions</Link>.
        </p>
      )}
      <Link href="/semantic"
        className="inline-flex items-center gap-1 mt-1 px-3 py-1.5 bg-orange-100 hover:bg-orange-200 border border-orange-300 rounded-lg text-[11px] font-semibold text-orange-800 transition-colors">
        Open Definitions →
      </Link>
    </div>
  );
}

// ─── Admin debug panel ────────────────────────────────────────────────────────

type DebugTab = 'stats' | 'sql' | 'tables' | 'relationships' | 'kpis';

function AdminDebugPanel({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(!!msg.blocked || !!msg.error);
  const d = msg.debug;

  const tabs: { id: DebugTab; label: string; show: boolean }[] = [
    { id: 'stats',         label: 'Stats',        show: !!d },
    { id: 'sql',           label: 'SQL',           show: !!msg.sql },
    { id: 'tables',        label: 'Table context', show: !!(d?.semanticContext) },
    { id: 'relationships', label: 'Relationships', show: !!(d?.relationshipContext) },
    { id: 'kpis',          label: `KPIs (${d?.confirmedKpis ?? 0})`, show: !!(d?.kpiFormulas) },
  ].filter((t) => t.show);

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
                className={`px-3 py-1.5 text-[10px] font-semibold transition-colors ${tab === t.id ? 'text-white bg-slate-800 border-b-2 border-blue-500' : 'text-slate-400 hover:text-slate-200'}`}>
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

// ─── Ephemeral thinking panel ─────────────────────────────────────────────────

function ThinkingPanel({
  repair, onClarify,
}: {
  repair: RepairState;
  onClarify: (answer: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => void;
}) {
  const [clarifyInput, setClarifyInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [repair.events.length]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full">
        <div className="bg-slate-850 bg-[#0f172a] rounded-2xl rounded-bl-md overflow-hidden border border-slate-700/60 shadow-lg text-xs">

          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700/60 bg-slate-800/80">
            {repair.isActive ? (
              <span className="flex gap-0.5">
                {[0,1,2].map((i) => (
                  <span key={i} className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
            ) : (
              <span className="w-4 h-4 text-emerald-400">✓</span>
            )}
            <span className="text-slate-200 font-semibold tracking-wide">
              {repair.isActive ? 'Investigating…' : 'Investigation complete'}
            </span>
          </div>

          {/* Events */}
          <div className="p-4 space-y-3">
            {repair.events.map((ev, i) => {
              if (ev.kind === 'thinking') return (
                <div key={i} className="flex gap-2.5">
                  <span className="text-slate-500 flex-shrink-0 mt-0.5">💭</span>
                  <p className="text-slate-300 leading-relaxed">{ev.text}</p>
                </div>
              );

              if (ev.kind === 'data_query') return (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-400 flex-shrink-0">🔍</span>
                    <span className="text-blue-300 font-semibold">Running diagnostic</span>
                  </div>
                  <pre className="ml-6 text-emerald-400 font-mono text-[10px] bg-black/40 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {formatSql(ev.sql)}
                  </pre>
                </div>
              );

              if (ev.kind === 'query_result') return (
                <div key={i} className="ml-6 space-y-1">
                  <p className="text-slate-500 text-[10px]">
                    → {ev.rowCount} row{ev.rowCount !== 1 ? 's' : ''} returned
                  </p>
                  {ev.rows.length > 0 && (
                    <pre className="text-slate-400 font-mono text-[10px] bg-black/40 rounded-lg px-3 py-2 overflow-x-auto max-h-28 leading-relaxed">
                      {JSON.stringify(ev.rows.slice(0, 6), null, 2)}
                    </pre>
                  )}
                </div>
              );

              if (ev.kind === 'revised_sql') return (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-amber-400 flex-shrink-0">✏️</span>
                    <span className="text-amber-300 font-semibold">Revised query</span>
                  </div>
                  <pre className="ml-6 text-emerald-400 font-mono text-[10px] bg-black/40 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {formatSql(ev.sql)}
                  </pre>
                </div>
              );

              if (ev.kind === 'clarification') return (
                <div key={i} className="flex gap-2.5">
                  <span className="text-amber-400 flex-shrink-0 mt-0.5">❓</span>
                  <p className="text-amber-200 leading-relaxed">{ev.question}</p>
                </div>
              );

              return null;
            })}

            {/* Clarification input */}
            {repair.pendingClarification && repair.pendingHistory && (
              <div className="ml-6 flex gap-2 pt-1">
                <input
                  value={clarifyInput}
                  onChange={(e) => setClarifyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && clarifyInput.trim()) {
                      onClarify(clarifyInput.trim(), repair.pendingHistory!);
                      setClarifyInput('');
                    }
                  }}
                  placeholder="Your answer…"
                  className="flex-1 bg-slate-700 text-slate-200 rounded-lg px-3 py-1.5 text-xs placeholder-slate-500 outline-none focus:ring-1 focus:ring-blue-500 border border-slate-600"
                  autoFocus
                />
                <button
                  onClick={() => {
                    if (!clarifyInput.trim()) return;
                    onClarify(clarifyInput.trim(), repair.pendingHistory!);
                    setClarifyInput('');
                  }}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition-colors"
                >
                  Send
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Chat sidebar ─────────────────────────────────────────────────────────────

function ChatSidebar({
  conversations, activeId, onSelect, onNew, onDelete, onStar, starFilter, onToggleStarFilter,
}: {
  conversations: Conversation[];
  activeId:      number | null;
  onSelect:      (id: number) => void;
  onNew:         () => void;
  onDelete:      (id: number) => void;
  onStar:        (id: number) => void;
  starFilter:    boolean;
  onToggleStarFilter: () => void;
}) {
  function relTime(ts: string) {
    const d = Date.now() - new Date(ts).getTime();
    const m = Math.floor(d / 60000);
    const h = Math.floor(d / 3600000);
    const dy = Math.floor(d / 86400000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${dy}d ago`;
  }

  return (
    <aside className="w-56 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
      <div className="flex-shrink-0 p-3 border-b border-slate-100 space-y-2">
        <button onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New chat
        </button>
        <button onClick={onToggleStarFilter}
          className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg transition-colors border ${
            starFilter ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
          }`}>
          <span>{starFilter ? '★' : '☆'}</span>
          {starFilter ? 'Showing starred' : 'Show starred'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {conversations.length === 0 && (
          <p className="text-center text-[11px] text-slate-400 mt-8 px-4 leading-relaxed">
            {starFilter ? 'No starred conversations' : 'Your conversations will appear here'}
          </p>
        )}
        {conversations.map((conv) => (
          <div key={conv.id}
            className={`group relative flex items-start gap-2 px-3 py-2.5 cursor-pointer transition-colors border-l-2 ${
              conv.id === activeId ? 'bg-blue-50 border-blue-500' : 'border-transparent hover:bg-slate-50'
            }`}
            onClick={() => onSelect(conv.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                {conv.starred && <span className="text-amber-400 text-[10px] flex-shrink-0">★</span>}
                <p className={`text-xs font-medium truncate leading-snug ${conv.id === activeId ? 'text-blue-700' : 'text-slate-700'}`}>
                  {conv.title}
                </p>
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5">{relTime(conv.updatedAt)}</p>
            </div>
            <div className="flex-shrink-0 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-all mt-0.5">
              <button
                onClick={(e) => { e.stopPropagation(); onStar(conv.id); }}
                className="p-0.5 rounded text-slate-300 hover:text-amber-400 transition-colors"
                title={conv.starred ? 'Unstar' : 'Star'}
              >
                <span className="text-[10px]">{conv.starred ? '★' : '☆'}</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(conv.id); }}
                className="p-0.5 rounded text-slate-300 hover:text-red-400 transition-colors"
                title="Delete"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, showSql, isAdmin, onSend, onFeedback, onExport, conversationId }: {
  msg: Message; showSql: boolean; isAdmin: boolean;
  onSend: (q: string) => void;
  onFeedback: (msgId: number, serverId: number, feedback: 'up' | 'down' | null, comment?: string) => void;
  onExport: (format: 'csv' | 'xlsx', conversationId: number, messageServerId?: number) => void;
  conversationId: number | null;
}) {
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
        <div className="max-w-[75%] bg-blue-600 text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed shadow-sm">
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
            <div className="bg-blue-50 border border-blue-200 rounded-2xl rounded-bl-md px-4 py-4 text-sm text-blue-900 shadow-sm space-y-4">
              <div className="flex items-start gap-2">
                <span className="text-blue-400 mt-0.5 flex-shrink-0">🔎</span>
                <p className="leading-relaxed font-medium">
                  I found multiple records named{' '}
                  <span className="font-mono bg-blue-100 px-1 py-0.5 rounded text-blue-700">
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
                    const idVal = row['id'] ?? row['customer_id'] ?? row['ID'];
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
                        className="w-full text-left px-4 py-3 bg-white hover:bg-blue-100 border border-blue-200 hover:border-blue-400 rounded-xl transition-colors shadow-sm group"
                      >
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            {displayFields.map(([k, v]) => (
                              <div key={k} className="flex gap-2 text-[11px]">
                                <span className="text-slate-400 min-w-[80px] capitalize">{k.replace(/_/g, ' ')}</span>
                                <span className="text-slate-700 font-medium">{String(v)}</span>
                              </div>
                            ))}
                          </div>
                          <span className="text-[11px] text-blue-500 group-hover:text-blue-700 font-semibold ml-4 flex-shrink-0">
                            Use this →
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}

              <p className="text-[11px] text-blue-400 pl-1">
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
            <div className="bg-blue-50 border border-blue-200 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-blue-900 shadow-sm space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-blue-400 mt-0.5 flex-shrink-0">🔎</span>
                <p className="leading-relaxed font-medium">
                  I couldn&apos;t find an exact match in your data. Did you mean one of these?
                </p>
              </div>
              {msg.mismatches.map((m) => (
                <div key={m.literal} className="pl-6 space-y-1.5">
                  <p className="text-[11px] text-blue-600 font-semibold">
                    Instead of <span className="font-mono bg-blue-100 px-1 py-0.5 rounded">&quot;{m.literal}&quot;</span>:
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
                          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
                        >
                          {alt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="pl-6 text-[11px] text-blue-500">
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
          <div className="bg-amber-50 border border-amber-200 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-amber-800 shadow-sm">
            <div className="flex items-start gap-2">
              <span className="text-amber-400 mt-0.5 flex-shrink-0">⚠</span>
              <p className="leading-relaxed">{msg.text}</p>
            </div>
            {(msg.confidence !== undefined || msg.queryLayer) && (
              <div className="mt-2 pl-5 flex items-center gap-2">
                {msg.confidence !== undefined && <ConfidenceBadge value={msg.confidence} />}
                {msg.queryLayer && <QueryLayerBadge layer={msg.queryLayer} />}
              </div>
            )}
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
        <div className="max-w-[80%] bg-red-50 border border-red-200 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-red-700 shadow-sm">
          <div className="flex items-start gap-2">
            <span className="flex-shrink-0 mt-0.5">✕</span>
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
                ? 'bg-violet-500 ring-2 ring-violet-300 ring-offset-1 shadow-lg shadow-violet-200'
                : 'bg-violet-100 hover:bg-violet-200 hover:shadow-md hover:shadow-violet-100'
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
            style={{ filter: 'drop-shadow(0 4px 14px rgba(109,40,217,0.18))' }}
          >
            {/* Tail pointing left toward the brain */}
            <div className="absolute -left-[9px] top-[10px] w-0 h-0"
              style={{ borderTop:'8px solid transparent', borderBottom:'8px solid transparent', borderRight:'9px solid #ddd6fe' }} />
            <div className="absolute -left-[7px] top-[11px] w-0 h-0"
              style={{ borderTop:'7px solid transparent', borderBottom:'7px solid transparent', borderRight:'8px solid white' }} />

            {/* Bubble body */}
            <div className="bg-white border border-violet-200 rounded-2xl rounded-tl-sm overflow-hidden">
              <div className="px-3 py-1.5 bg-violet-50 border-b border-violet-100 flex items-center gap-1.5">
                <span className="text-[9px] font-bold text-violet-500 uppercase tracking-widest">Reasoning</span>
              </div>
              <div className="px-3 py-2.5 max-h-64 overflow-y-auto">
                <p className="text-[11px] text-slate-500 leading-relaxed whitespace-pre-wrap">
                  {msg.reasoning}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right column: answer bubble — shape never changes */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className={`bg-white border rounded-2xl rounded-bl-md px-4 py-3 text-sm shadow-sm space-y-2.5 ${
          msg.wasRepaired ? 'border-emerald-300' : 'border-slate-200'
        }`}>
          {msg.wasRepaired && (
            <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 font-semibold">
              <span>✓</span> Corrected after investigation
            </div>
          )}
          <p className="text-slate-800 leading-relaxed"><BoldText text={msg.text} /></p>
          {msg.rows && msg.rows.length > 0 && <ResultVisualizer rows={msg.rows} />}
          {msg.warning && !msg.wasRepaired && (
            <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 text-xs text-yellow-800">
              <span className="flex-shrink-0 mt-0.5">⚠</span>
              <span>{msg.warning}</span>
            </div>
          )}
          {isAdmin && (msg.confidence !== undefined || msg.sql) && (
            <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-slate-100">
              {msg.confidence !== undefined && <ConfidenceBadge value={msg.confidence} />}
              {msg.queryLayer && <QueryLayerBadge layer={msg.queryLayer} />}
              {msg.tablesUsed && msg.tablesUsed.length > 0 && (
                <span className="text-[10px] text-slate-400">tables: {msg.tablesUsed.join(', ')}</span>
              )}
              {msg.sql && showSql && (
                <button onClick={() => setSqlOpen((o) => !o)}
                  className="ml-auto text-[10px] font-medium text-slate-400 hover:text-blue-600 transition-colors flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                  {sqlOpen ? 'Hide SQL' : 'View SQL'}
                </button>
              )}
            </div>
          )}
          {isAdmin && showSql && sqlOpen && msg.sql && (
            <pre className="text-[11px] bg-slate-900 text-emerald-400 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed font-mono">
              {formatSql(msg.sql)}
            </pre>
          )}
          {/* Feedback + Export row */}
          {msg.role === 'assistant' && !msg.error && !msg.blocked && (
            <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
              {/* Feedback buttons */}
              {msg.serverId && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onFeedback(msg.id, msg.serverId!, msg.feedback === 'up' ? null : 'up')}
                    className={`p-1 rounded transition-colors ${msg.feedback === 'up' ? 'text-emerald-600 bg-emerald-50' : 'text-slate-300 hover:text-emerald-500'}`}
                    title="Good answer"
                  >
                    <svg className="w-3.5 h-3.5" fill={msg.feedback === 'up' ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => onFeedback(msg.id, msg.serverId!, msg.feedback === 'down' ? null : 'down')}
                    className={`p-1 rounded transition-colors ${msg.feedback === 'down' ? 'text-red-500 bg-red-50' : 'text-slate-300 hover:text-red-400'}`}
                    title="Incorrect answer"
                  >
                    <svg className="w-3.5 h-3.5" fill={msg.feedback === 'down' ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z" />
                    </svg>
                  </button>
                  {msg.feedback && (
                    <span className={`text-[10px] ml-1 ${msg.feedback === 'up' ? 'text-emerald-500' : 'text-red-400'}`}>
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
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                    title="Export as CSV"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    CSV
                  </button>
                  <button
                    onClick={() => onExport('xlsx', conversationId, msg.serverId)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-slate-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors"
                    title="Export as Excel"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
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

// ─── Live thinking bubble ────────────────────────────────────────────────────

function ThinkingBubble({
  phase, liveText, sql, confidence,
}: {
  phase:      string;
  liveText:   string;
  sql:        string | null;
  confidence: number | null;
}) {
  // Word-by-word display of live reasoning — ~220 ms/word (readable pace)
  const [displayed, setDisplayed] = useState('');
  const fullRef = useRef('');
  const posRef  = useRef(0);

  useEffect(() => { fullRef.current = liveText; }, [liveText]);

  useEffect(() => {
    if (liveText === '') { setDisplayed(''); posRef.current = 0; }
  }, [liveText]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const full = fullRef.current;
      let pos = posRef.current;
      if (pos >= full.length) { setTimeout(tick, 40); return; }
      while (pos < full.length && (full[pos] === ' ' || full[pos] === '\n')) pos++;
      while (pos < full.length && full[pos] !== ' '  && full[pos] !== '\n') pos++;
      if (pos < full.length && full[pos] === ' ') pos++;
      posRef.current = pos;
      setDisplayed(full.slice(0, pos));
      setTimeout(tick, 220);
    };
    const t = setTimeout(tick, 100);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  const isExecuting = phase === 'Running your query…' || phase === 'Formatting answer…';

  return (
    <div className="flex justify-start gap-2">
      {/* Pulsing brain while thinking */}
      <div className="flex-shrink-0 w-7 h-7 mt-1 rounded-full bg-violet-200 flex items-center justify-center animate-pulse">
        <span className="text-sm">🧠</span>
      </div>

      <div className="max-w-[85%] w-full bg-white border border-slate-200 rounded-2xl rounded-bl-md overflow-hidden shadow-sm">
        {/* Phase header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 bg-slate-50">
          {isExecuting ? (
            <svg className="w-3.5 h-3.5 text-emerald-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
            </svg>
          ) : (
            <span className="flex gap-0.5 flex-shrink-0">
              {[0,1,2].map((i) => (
                <span key={i} className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
          )}
          <span className="text-xs font-semibold text-slate-600">{phase || 'Loading…'}</span>
        </div>

        {/* Word-by-word reasoning — plain grey text, no scroll, grows naturally */}
        {displayed && (
          <div className="px-4 pt-3 pb-2">
            <p className="text-[11px] text-slate-400 leading-relaxed whitespace-pre-wrap">
              {displayed}
              <span className="inline-block w-[2px] h-[11px] bg-slate-300 ml-[1px] align-middle animate-pulse" />
            </p>
          </div>
        )}

        {/* SQL preview once generated */}
        {sql && (
          <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-900 space-y-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Generated SQL</span>
              {confidence !== null && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${confidence >= 0.8 ? 'bg-emerald-900 text-emerald-400' : confidence >= 0.7 ? 'bg-amber-900 text-amber-400' : 'bg-red-900 text-red-400'}`}>
                  {Math.round(confidence * 100)}% conf
                </span>
              )}
            </div>
            <pre className="text-[10px] text-emerald-400 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-28">
              {formatSql(sql)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onStarter, productContext }: { onStarter: (q: string) => void; productContext?: { name: string; kpis: string[] } | null }) {
  // Build suggested questions: product KPIs first, then generic starters
  const kpiQuestions = (productContext?.kpis ?? []).slice(0, 6).map((kpi) => `What is the ${kpi}?`);
  const questions = kpiQuestions.length > 0
    ? kpiQuestions
    : STARTERS;

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-16">
      <div className="text-5xl mb-4">💬</div>
      {productContext ? (
        <>
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Ask about {productContext.name}</h2>
          <p className="text-sm text-slate-500 mb-8 max-w-md">
            Ask questions about your {productContext.name.toLowerCase()} data in plain English.
          </p>
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Ask your data anything</h2>
          <p className="text-sm text-slate-500 mb-8 max-w-md">
            Type a question in plain English and get an instant answer. No SQL needed.
          </p>
        </>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
        {questions.map((q) => (
          <button key={q} onClick={() => onStarter(q)}
            className="text-left px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-all shadow-sm">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function QueryPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId,      setActiveId]      = useState<number | null>(null);
  const [messages,      setMessages]      = useState<Message[]>([]);
  const [input,         setInput]         = useState('');
  const [loading,        setLoading]        = useState(false);
  const [showSql,        setShowSql]        = useState(false);
  const [isAdmin,        setIsAdmin]        = useState(false);
  const [starFilter,     setStarFilter]     = useState(false);

  // URL params (e.g. ?connectionId=5&productId=3&productName=Sales from Data Products)
  const searchParams = useSearchParams();
  const urlConnectionId = searchParams.get('connectionId');
  const urlProductId = searchParams.get('productId');
  const urlProductName = searchParams.get('productName');

  // Product context — shown when navigating from Data Products page
  const [productContext, setProductContext] = useState<{ name: string; kpis: string[] } | null>(null);

  // Data source selection (silent — no UI picker)
  const [sources,       setSources]       = useState<DataSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<string>('');

  // Domain filter
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);
  const [selectedDomains,  setSelectedDomains]  = useState<string[]>([]);

  // Ephemeral repair state — never persisted
  const [repairState, setRepairState] = useState<RepairState | null>(null);

  // Live thinking state — shown while /think SSE stream is open
  const [thinkingPhase, setThinkingPhase] = useState<string>('');
  const [thinkingText,  setThinkingText]  = useState<string>('');
  const [thinkingSql,   setThinkingSql]   = useState<string | null>(null);
  const [thinkingConf,  setThinkingConf]  = useState<number | null>(null);

  const nextId      = useRef(0);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);

  useEffect(() => { setIsAdmin(getTokenPayload()?.role === 'admin'); }, []);

  // Load product context (KPIs) when navigating from Data Products
  useEffect(() => {
    if (urlProductId && urlProductName) {
      api.get(`/products/${urlProductId}/kpis`)
        .then((res) => {
          const kpiNames = (res.data.data ?? []).map((k: { name: string }) => k.name);
          setProductContext({ name: urlProductName, kpis: kpiNames });
        })
        .catch(() => {
          setProductContext({ name: urlProductName, kpis: [] });
        });
    }
  }, [urlProductId, urlProductName]);

  // Load available connections + integration views (silent — no UI picker shown)
  useEffect(() => {
    Promise.all([
      api.get('/connections').catch(() => ({ data: { data: [] } })),
      api.get('/cross-views').catch(() => ({ data: { data: [] } })),
    ]).then(([connRes, viewRes]) => {
      const conns = (connRes.data.data ?? []) as { id: number; name: string }[];
      const views = (viewRes.data.data ?? []) as { id: number; name: string }[];
      const all: DataSource[] = [
        ...conns.map((c) => ({ type: 'connection' as const, id: c.id, label: c.name })),
        ...views.map((v) => ({ type: 'view' as const, id: v.id, label: v.name })),
      ];
      setSources(all);

      // Priority: URL param > localStorage > first source
      if (urlConnectionId && all.some((s) => s.type === 'connection' && s.id === Number(urlConnectionId))) {
        const key = `c:${urlConnectionId}`;
        setSelectedSource(key);
        localStorage.setItem('databridge_query_source', key);
      } else {
        const saved = localStorage.getItem('databridge_query_source');
        if (saved && all.some((s) => `${s.type === 'connection' ? 'c' : 'v'}:${s.id}` === saved)) {
          setSelectedSource(saved);
        } else if (all.length > 0) {
          setSelectedSource(`c:${all[0].id}`);
        }
      }
      // Load domain tags for the first connection
      const firstConn = conns[0];
      if (firstConn) {
        api.get(`/semantic/domains?connectionId=${firstConn.id}`)
          .then((r) => setAvailableDomains(r.data.data ?? []))
          .catch(() => {});
      }
    });
  }, []);

  // Load conversations from server
  const loadConversations = useCallback(async (filterStarred?: boolean) => {
    try {
      const url = filterStarred ? '/conversations?starred=true' : '/conversations';
      const res = await api.get(url);
      const convs = (res.data.data ?? []).map((c: Record<string, unknown>) => ({
        id: c.id as number,
        title: c.title as string,
        starred: c.starred as boolean,
        createdAt: c.created_at as string,
        updatedAt: c.updated_at as string,
        messages: [], // loaded on select
      }));
      setConversations(convs);
      return convs as Conversation[];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    loadConversations(starFilter).then((convs) => {
      if (convs.length > 0 && !activeId) {
        selectConversation(convs[0].id);
      }
      initialized.current = true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starFilter]);

  // Helper: persist a message to the server
  async function persistMessage(conversationId: number, msg: Partial<Message> & { role: string; text: string }): Promise<number | undefined> {
    try {
      const res = await api.post(`/conversations/${conversationId}/messages`, {
        role: msg.role,
        content: msg.text,
        question: msg.question,
        sql: msg.sql,
        tablesUsed: msg.tablesUsed,
        confidence: msg.confidence,
        warning: msg.warning,
        blocked: msg.blocked,
        needsClarification: msg.needsClarification,
        mismatches: msg.mismatches,
        ambiguities: msg.ambiguities,
        error: msg.error,
        debug: msg.debug,
        rows: msg.rows,
        wasRepaired: msg.wasRepaired,
        reasoning: msg.reasoning,
        queryLayer: msg.queryLayer,
      });
      return res.data.data?.id as number | undefined;
    } catch { /* non-fatal — message still shown locally */ }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, repairState?.events.length]);

  // ── Conversation management (server-side) ──

  async function startNewConversation() {
    try {
      const res = await api.post('/conversations', { sourceKey: selectedSource });
      const conv: Conversation = {
        id: res.data.data.id,
        title: res.data.data.title,
        starred: false,
        createdAt: res.data.data.created_at,
        updatedAt: res.data.data.updated_at,
        messages: [],
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setMessages([]);
      setRepairState(null);
      nextId.current = 0;
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // Fallback: still allow local usage
      const tempId = -Date.now();
      setConversations((prev) => [{ id: tempId, title: 'New conversation', starred: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }, ...prev]);
      setActiveId(tempId);
      setMessages([]);
      setRepairState(null);
      nextId.current = 0;
    }
  }

  async function selectConversation(id: number) {
    if (id === activeId) return;
    setActiveId(id);
    setRepairState(null);
    try {
      const res = await api.get(`/conversations/${id}`);
      const data = res.data.data;
      const msgs: Message[] = (data.messages ?? []).map((m: Record<string, unknown>) => ({
        id: m.id as number,
        serverId: m.id as number,
        role: m.role as 'user' | 'assistant',
        text: m.content as string,
        question: m.question as string | undefined,
        sql: m.sql as string | undefined,
        tablesUsed: m.tables_used ? (typeof m.tables_used === 'string' ? JSON.parse(m.tables_used as string) : m.tables_used) : undefined,
        confidence: m.confidence as number | undefined,
        warning: m.warning as string | undefined,
        blocked: m.blocked as boolean | undefined,
        needsClarification: m.needs_clarification as boolean | undefined,
        mismatches: m.mismatches ? (typeof m.mismatches === 'string' ? JSON.parse(m.mismatches as string) : m.mismatches) : undefined,
        ambiguities: m.ambiguities ? (typeof m.ambiguities === 'string' ? JSON.parse(m.ambiguities as string) : m.ambiguities) : undefined,
        error: m.error as boolean | undefined,
        debug: m.debug ? (typeof m.debug === 'string' ? JSON.parse(m.debug as string) : m.debug) : undefined,
        rows: m.rows ? (typeof m.rows === 'string' ? JSON.parse(m.rows as string) : m.rows) : undefined,
        wasRepaired: m.was_repaired as boolean | undefined,
        reasoning: m.reasoning as string | undefined,
        queryLayer: m.query_layer as 'product' | 'source' | undefined,
        feedback: m.feedback as 'up' | 'down' | null,
        feedbackComment: m.feedback_comment as string | undefined,
      }));
      setMessages(msgs);
      nextId.current = msgs.length > 0 ? Math.max(...msgs.map((m) => m.id)) + 1 : 0;
    } catch {
      setMessages([]);
      nextId.current = 0;
    }
  }

  async function deleteConversation(id: number) {
    try { await api.delete(`/conversations/${id}`); } catch { /* non-fatal */ }
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (id === activeId) {
        if (next.length > 0) { selectConversation(next[0].id); }
        else { setActiveId(null); setMessages([]); }
        setRepairState(null);
      }
      return next;
    });
  }

  async function toggleStar(id: number) {
    try {
      const res = await api.patch(`/conversations/${id}/star`);
      const newStarred = res.data.data.starred;
      setConversations((prev) =>
        prev.map((c) => c.id === id ? { ...c, starred: newStarred } : c)
          .filter((c) => !starFilter || c.starred)
      );
    } catch { /* non-fatal */ }
  }

  async function handleFeedback(msgId: number, serverId: number, feedback: 'up' | 'down' | null, comment?: string) {
    try {
      await api.patch(`/conversations/messages/${serverId}/feedback`, { feedback, comment });
      setMessages((prev) => prev.map((m) =>
        m.id === msgId ? { ...m, feedback, feedbackComment: comment } : m
      ));
    } catch { /* non-fatal */ }
  }

  function handleExport(format: 'csv' | 'xlsx', conversationId: number, messageServerId?: number) {
    const params = messageServerId ? `?messageId=${messageServerId}` : '';
    const url = `${BACKEND_URL}/api/conversations/${conversationId}/export/${format}${params}`;
    // Open in new tab to trigger download, with auth token
    const token = getToken();
    // Use fetch + blob for authenticated download
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `databridge-export-${conversationId}.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => alert('Export failed'));
  }

  // ── Repair stream ──

  async function startRepair(params: {
    messageId: number;
    question: string;
    originalSql: string;
    originalRows: Record<string, unknown>[];
    warning: string;
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    clarificationAnswer?: string;
  }) {
    setRepairState({ forMessageId: params.messageId, events: [], isActive: true });

    const token = getToken();
    let response: Response;
    try {
      response = await fetch(`${BACKEND_URL}/api/query/repair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          connectionId:        selectedSource.startsWith('c:') ? Number(selectedSource.split(':')[1]) : 1,
          question:            params.question,
          originalSql:         params.originalSql,
          originalRows:        params.originalRows,
          warning:             params.warning,
          conversationHistory: params.conversationHistory,
          clarificationAnswer: params.clarificationAnswer,
        }),
      });
    } catch {
      setRepairState((prev) => prev
        ? { ...prev, isActive: false, events: [...prev.events, { kind: 'thinking', text: '⚠ Could not reach the backend. Please try again.' }] }
        : null,
      );
      return;
    }

    const reader  = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    // Defined before the loop so it can be called from inside it cleanly
    const handleEvent = (event: Record<string, unknown>) => {
      const type = event.type as string;

      if (type === 'thinking') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'thinking', text: event.text as string }] }
          : null);

      } else if (type === 'data_query') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'data_query', sql: event.sql as string }] }
          : null);

      } else if (type === 'query_result') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, {
              kind: 'query_result',
              rows: event.rows as Record<string, unknown>[],
              rowCount: event.rowCount as number,
            }] }
          : null);

      } else if (type === 'revised_sql') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'revised_sql', sql: event.sql as string }] }
          : null);

      } else if (type === 'clarification') {
        setRepairState((prev) => prev
          ? {
              ...prev,
              isActive: false,
              events: [...prev.events, { kind: 'clarification', question: event.question as string }],
              pendingClarification: event.question as string,
              pendingHistory: event.conversationHistory as Array<{ role: 'user' | 'assistant'; content: string }>,
            }
          : null);

      } else if (type === 'revised_answer') {
        setMessages((prev) => prev.map((m) =>
          m.id === params.messageId
            ? {
                ...m,
                text:        event.answer as string,
                sql:         event.sql    as string,
                rows:        event.rows   as Record<string, unknown>[],
                confidence:  event.confidence as number,
                warning:     (event.warning as string | null) ?? undefined,
                wasRepaired: true,
              }
            : m,
        ));
        setRepairState((prev) => prev ? { ...prev, isActive: false } : null);

      } else if (type === 'error') {
        setRepairState((prev) => prev
          ? { ...prev, isActive: false, events: [...prev.events, { kind: 'thinking', text: `⚠ ${event.text as string}` }] }
          : null);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });

      // When done=true keep ALL lines (no trailing pop); otherwise keep the last
      // incomplete line in buffer for the next chunk
      const lines = buffer.split('\n');
      buffer = done ? '' : (lines.pop() ?? '');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { handleEvent(JSON.parse(line.slice(6)) as Record<string, unknown>); }
        catch { /* skip malformed line */ }
      }

      if (done) break;
    }

    setRepairState((prev) => prev ? { ...prev, isActive: false } : null);
  }

  function handleClarify(answer: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
    if (!repairState) return;
    // Find the question for this message
    const msgId = repairState.forMessageId;
    const assistantMsg = messages.find((m) => m.id === msgId);
    if (!assistantMsg) return;

    setRepairState((prev) => prev
      ? { ...prev, isActive: true, pendingClarification: undefined, pendingHistory: undefined }
      : null,
    );

    startRepair({
      messageId:           msgId,
      question:            assistantMsg.question ?? '',
      originalSql:         assistantMsg.sql ?? '',
      originalRows:        assistantMsg.rows ?? [],
      warning:             assistantMsg.warning ?? '',
      conversationHistory: history,
      clarificationAnswer: answer,
    });
  }

  // ── Send a question ──

  const send = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || loading) return;

    setRepairState(null); // clear any active repair when asking a new question

    let cid = activeId;
    if (!cid) {
      // Create a new conversation on the server
      try {
        const res = await api.post('/conversations', { title: q.slice(0, 80), sourceKey: selectedSource });
        cid = res.data.data.id;
        const conv: Conversation = {
          id: cid!,
          title: q.slice(0, 80),
          starred: false,
          createdAt: res.data.data.created_at,
          updatedAt: res.data.data.updated_at,
          messages: [],
        };
        setConversations((prev) => [conv, ...prev]);
      } catch {
        cid = -Date.now();
        setConversations((prev) => [{
          id: cid!, title: q.slice(0, 80), starred: false,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [],
        }, ...prev]);
      }
      setActiveId(cid);
    }

    setInput('');
    const userMsgId = nextId.current++;
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: q }]);
    // Persist user message to server
    if (cid && cid > 0) persistMessage(cid, { role: 'user', text: q });
    setLoading(true);
    setThinkingPhase('');
    setThinkingText('');
    setThinkingSql(null);
    setThinkingConf(null);

    try {
      // Build prior-Q context for follow-ups
      let fullQuestion = q;
      const prior = messages.filter((m) => m.role === 'assistant').slice(-1)[0];
      const priorQ = messages.filter((m) => m.role === 'user').slice(-1)[0];
      if (prior && priorQ && priorQ.text !== q) {
        fullQuestion = `Previous question: "${priorQ.text}"\nPrevious answer: "${prior.text.slice(0, 400)}"\n\nFollow-up: ${q}`;
      }

      const isCrossView = selectedSource.startsWith('v:');
      const sourceId    = Number(selectedSource.split(':')[1]);

      // Cross-view queries use the regular (non-streaming) route
      if (isCrossView) {
        const res = await api.post('/query/cross-view', { viewId: sourceId, question: fullQuestion });
        const d   = res.data.data;
        const assistantId = nextId.current++;
        const assistantMsg: Message = {
          id: assistantId, role: 'assistant', text: d.answer, question: q,
          sql: d.sql, tablesUsed: d.tablesUsed, confidence: d.confidence, warning: d.warning,
          blocked: d.blocked, needsClarification: d.needsClarification,
          ambiguities: d.ambiguities, mismatches: d.mismatches, debug: d.debug, rows: d.rows,
          queryLayer: d.queryLayer,
        };
        // Persist to server
        if (cid && cid > 0) {
          const serverId = await persistMessage(cid, assistantMsg);
          if (serverId) assistantMsg.serverId = serverId;
        }
        setMessages((prev) => [...prev, assistantMsg]);
        if (d.warning && !d.blocked && d.sql && d.rows) {
          startRepair({ messageId: assistantId, question: q, originalSql: d.sql, originalRows: d.rows, warning: d.warning });
        }
        return;
      }

      // Single-source: use the streaming /think endpoint
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/query/think`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          connectionId: sourceId,
          question:     fullQuestion,
          ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
        }),
      });

      const reader  = response.body!.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   assistantId = -1;
      let   accumulatedThinking = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });

        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; }
          catch { continue; }

          const type = event.type as string;

          if (type === 'phase') {
            setThinkingPhase(event.text as string);

          } else if (type === 'thinking') {
            accumulatedThinking += event.text as string;
            setThinkingText((prev) => prev + (event.text as string));

          } else if (type === 'sql_ready') {
            setThinkingSql(event.sql as string);
            setThinkingConf(event.confidence as number);

          } else if (type === 'done') {
            const d = event.data as {
              answer: string; confidence: number; blocked?: boolean; sql?: string;
              tablesUsed?: string[]; warning?: string; rows?: Record<string, unknown>[];
              debug?: DebugInfo; needsClarification?: boolean;
              ambiguities?: EntityAmbiguity[]; mismatches?: EntityMismatch[];
              queryLayer?: 'product' | 'source';
            };
            assistantId = nextId.current++;
            const assistantMsg: Message = {
              id: assistantId, role: 'assistant', text: d.answer, question: q,
              sql: d.sql, tablesUsed: d.tablesUsed, confidence: d.confidence, warning: d.warning,
              blocked: d.blocked, needsClarification: d.needsClarification,
              ambiguities: d.ambiguities, mismatches: d.mismatches, debug: d.debug, rows: d.rows,
              reasoning: accumulatedThinking || undefined,
              queryLayer: d.queryLayer,
            };
            // Persist to server
            if (cid && cid > 0) {
              persistMessage(cid, assistantMsg).then((serverId) => {
                if (serverId) {
                  setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, serverId } : m));
                }
              });
            }
            setMessages((prev) => [...prev, assistantMsg]);
            if (d.warning && !d.blocked && d.sql && d.rows) {
              startRepair({ messageId: assistantId, question: q, originalSql: d.sql, originalRows: d.rows, warning: d.warning });
            }

          } else if (type === 'error') {
            setMessages((prev) => [...prev, {
              id: nextId.current++, role: 'assistant',
              text: (event.message as string) || 'Something went wrong. Please try again.',
              error: true,
            }]);
          }
        }

        if (done) break;
      }

    } catch {
      setMessages((prev) => [
        ...prev,
        { id: nextId.current++, role: 'assistant', text: 'Something went wrong. Please try again.', error: true },
      ]);
    } finally {
      setLoading(false);
      setThinkingPhase('');
      setThinkingText('');
      setThinkingSql(null);
      setThinkingConf(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeId, selectedSource]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  // ── Render ──

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 p-3 space-y-2">
        <button onClick={startNewConversation}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 gradient-primary text-white text-body-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New chat
        </button>
        <button onClick={() => setStarFilter((f) => !f)}
          className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-label-md font-medium rounded-lg transition-colors ${
            starFilter ? 'bg-amber-500/10 text-amber-600' : 'text-on-surface-variant hover:bg-surface-container'
          }`}>
          <span>{starFilter ? '★' : '☆'}</span>
          {starFilter ? 'Showing starred' : 'Show starred'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {conversations.length === 0 && (
          <p className="text-center text-label-sm text-on-surface-variant/50 mt-8 px-4 leading-relaxed">
            {starFilter ? 'No starred conversations' : 'Your conversations will appear here'}
          </p>
        )}
        {conversations.map((conv) => (
          <div key={conv.id}
            className={`group relative flex items-start gap-2 px-3 py-2.5 cursor-pointer transition-all ${
              conv.id === activeId
                ? 'bg-surface-container-highest border-l-2 border-cyan-400'
                : 'border-l-2 border-transparent hover:bg-surface-container'
            }`}
            onClick={() => selectConversation(conv.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                {conv.starred && <span className="text-amber-400 text-label-sm flex-shrink-0">★</span>}
                <p className={`text-body-sm font-medium truncate leading-snug ${
                  conv.id === activeId ? 'text-on-surface' : 'text-on-surface-variant'
                }`}>
                  {conv.title}
                </p>
              </div>
              <p className="text-label-sm text-on-surface-variant/50 mt-0.5">
                {(() => {
                  const d = Date.now() - new Date(conv.updatedAt).getTime();
                  const m = Math.floor(d / 60000); const h = Math.floor(d / 3600000); const dy = Math.floor(d / 86400000);
                  if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; if (h < 24) return `${h}h ago`; return `${dy}d ago`;
                })()}
              </p>
            </div>
            <div className="flex-shrink-0 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-all mt-0.5">
              <button onClick={(e) => { e.stopPropagation(); toggleStar(conv.id); }}
                className="p-0.5 rounded text-on-surface-variant/30 hover:text-amber-400 transition-colors"
                title={conv.starred ? 'Unstar' : 'Star'}>
                <span className="text-label-sm">{conv.starred ? '★' : '☆'}</span>
              </button>
              <button onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                className="p-0.5 rounded text-on-surface-variant/30 hover:text-error transition-colors" title="Delete">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <AppShell
      title="Ask your Data"
      showSearch={false}
      contextPanel={sidebarContent}
    >
      <div className="flex flex-col h-full">
        {/* Sub-header: source selector + show SQL toggle */}
        <div className="flex-shrink-0 px-6 py-2 flex items-center justify-between ghost-border-b">
          <div className="flex items-center gap-3">
            {sources.length > 1 && (
              <SourceSelector sources={sources} selectedId={selectedSource} onChange={(id) => { setSelectedSource(id); localStorage.setItem('databridge_query_source', id); }} />
            )}
          </div>
          <div className="flex items-center gap-4">
            {isAdmin && (
              <label className="flex items-center gap-2 text-label-md text-on-surface-variant cursor-pointer select-none">
                <div onClick={() => setShowSql((s) => !s)}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${showSql ? 'bg-cyan-500' : 'bg-outline-variant'}`}>
                  <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${showSql ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                Show SQL
              </label>
            )}
            {messages.length > 0 && (
              <button onClick={() => {
                if (activeId && activeId > 0) {
                  api.delete(`/conversations/${activeId}`).catch(() => {});
                  setConversations((prev) => prev.filter((c) => c.id !== activeId));
                }
                setActiveId(null); setMessages([]); setRepairState(null);
              }}
                className="text-label-md text-on-surface-variant hover:text-on-surface transition-colors">
                Clear chat
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto w-full px-4 py-6">
            {messages.length === 0 && !loading ? (
              <EmptyState onStarter={send} productContext={productContext} />
            ) : (
              <div className="space-y-4">
                {messages.map((m) => (
                  <div key={m.id}>
                    <MessageBubble msg={m} showSql={showSql} isAdmin={isAdmin} onSend={send} onFeedback={handleFeedback} onExport={handleExport} conversationId={activeId} />
                    {repairState?.forMessageId === m.id && (
                      <div className="mt-3">
                        <ThinkingPanel repair={repairState} onClarify={handleClarify} />
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <ThinkingBubble
                    phase={thinkingPhase}
                    liveText={thinkingText}
                    sql={thinkingSql}
                    confidence={thinkingConf}
                  />
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input */}
        <div className="flex-shrink-0 px-4 py-3 ghost-border-t bg-surface">
          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="e.g. What were my top 5 customers last month?"
              disabled={loading}
              autoComplete="off"
              className="flex-1 rounded-xl px-4 py-2.5 text-body-md bg-surface-container-lowest text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 focus:shadow-glow-teal disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            />
            <button type="submit" disabled={loading || !input.trim()}
              className="px-5 py-2.5 gradient-primary text-on-primary rounded-xl text-title-md hover:opacity-90 active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2">
              {loading ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
              {loading ? 'Thinking' : 'Ask'}
            </button>
          </form>
        </div>
      </div>
    </AppShell>
  );
}
