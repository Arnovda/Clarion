'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { AlertCircle, CheckCircle2, BarChart3, Table2, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';

export interface CellOutputData {
  rows?: Record<string, unknown>[];
  columns?: string[];
  rowCount?: number;
  durationMs?: number;
  error?: string;
  suggestedFix?: string;
}

interface Props {
  data: CellOutputData | null;
  status?: string | null;
  onApplyFix?: (sql: string) => void;
}

export default function CellOutput({ data, status, onApplyFix }: Props) {
  const [showProfile, setShowProfile] = useState(false);
  if (!data) return null;

  if (data.error || status === 'error') {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-err/30 bg-err-soft px-3.5 py-2.5 text-[12.5px] text-err">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={2} />
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">{data.error}</pre>
          </div>
        </div>
        {data.suggestedFix && (
          <div className="rounded-md border border-ocean/20 bg-ocean-softer/30 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Sparkles className="w-3 h-3 text-ocean" strokeWidth={2} />
              <span className="text-[10px] font-mono tracking-[0.12em] uppercase text-ocean">AI suggests</span>
            </div>
            <pre className="text-[11.5px] font-mono text-ink-2 leading-relaxed whitespace-pre-wrap mb-2">{data.suggestedFix}</pre>
            {onApplyFix && (
              <button
                onClick={() => onApplyFix(data.suggestedFix!)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium bg-ocean text-white rounded hover:bg-ocean-hover transition-colors"
              >
                Apply fix
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const rows = data.rows ?? [];
  const columns = data.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  if (columns.length === 0) return null;

  const shown = rows.slice(0, 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-2 tracking-[0.06em]">
        <CheckCircle2 className="w-3 h-3 text-ok" strokeWidth={2} />
        <span>{(data.rowCount ?? rows.length).toLocaleString('en-GB')} rows</span>
        {data.durationMs !== undefined && <span>· {data.durationMs}ms</span>}
        <span className="flex-1" />
        <button
          onClick={() => setShowProfile(!showProfile)}
          className="inline-flex items-center gap-1 text-muted hover:text-ink transition-colors"
        >
          <BarChart3 className="w-3 h-3" strokeWidth={2} />
          Profile
          {showProfile ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
        </button>
      </div>

      {/* Inline profiling */}
      {showProfile && rows.length > 0 && (
        <ProfileStrip rows={rows} columns={columns} />
      )}

      {/* Data table */}
      <div className="border border-line rounded-md overflow-hidden text-[11.5px]">
        <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
          <table className="w-full">
            <thead className="bg-softer sticky top-0">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="text-left px-2.5 py-1.5 font-mono text-muted text-[10px] tracking-[0.06em] uppercase font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className="border-t border-line hover:bg-softer/30">
                  {columns.map((c) => (
                    <td key={c} className="px-2.5 py-1.5 text-ink-2 tabular-nums whitespace-nowrap max-w-[250px] truncate">
                      {fmt(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > shown.length && (
          <div className="px-2.5 py-1 bg-softer text-[10px] font-mono text-muted text-center">
            showing {shown.length} of {rows.length} rows
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileStrip({ rows, columns }: { rows: Record<string, unknown>[]; columns: string[] }) {
  return (
    <div className="border border-line rounded-md overflow-hidden text-[11px]">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-softer">
            <tr>
              <th className="text-left px-2.5 py-1 font-mono text-muted text-[9px] tracking-[0.06em] uppercase font-medium">Column</th>
              <th className="text-left px-2.5 py-1 font-mono text-muted text-[9px] tracking-[0.06em] uppercase font-medium">Type</th>
              <th className="text-right px-2.5 py-1 font-mono text-muted text-[9px] tracking-[0.06em] uppercase font-medium">Null %</th>
              <th className="text-right px-2.5 py-1 font-mono text-muted text-[9px] tracking-[0.06em] uppercase font-medium">Unique</th>
              <th className="text-left px-2.5 py-1 font-mono text-muted text-[9px] tracking-[0.06em] uppercase font-medium">Min / Max</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col) => {
              const stats = computeColumnStats(rows, col);
              return (
                <tr key={col} className="border-t border-line">
                  <td className="px-2.5 py-1 font-mono text-ink">{col}</td>
                  <td className="px-2.5 py-1 text-muted-2">{stats.inferredType}</td>
                  <td className={cn('px-2.5 py-1 text-right tabular-nums', stats.nullPct > 0 ? 'text-warn' : 'text-ok')}>
                    {stats.nullPct.toFixed(0)}%
                  </td>
                  <td className="px-2.5 py-1 text-right tabular-nums text-ink-2">{stats.unique.toLocaleString('en-GB')}</td>
                  <td className="px-2.5 py-1 text-muted-2 max-w-[200px] truncate">
                    {stats.min !== null ? `${fmtShort(stats.min)} — ${fmtShort(stats.max)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function computeColumnStats(rows: Record<string, unknown>[], col: string) {
  let nullCount = 0;
  const uniqueVals = new Set<string>();
  let min: unknown = null;
  let max: unknown = null;
  let hasNumber = false;
  let hasString = false;

  for (const row of rows) {
    const v = row[col];
    if (v === null || v === undefined) { nullCount++; continue; }
    uniqueVals.add(String(v));
    if (typeof v === 'number') {
      hasNumber = true;
      if (min === null || v < (min as number)) min = v;
      if (max === null || v > (max as number)) max = v;
    } else {
      hasString = true;
      const s = String(v);
      if (min === null || s < (min as string)) min = s;
      if (max === null || s > (max as string)) max = s;
    }
  }

  const inferredType = hasNumber && !hasString ? 'number' : hasString && !hasNumber ? 'text' : 'mixed';

  return {
    nullPct: rows.length > 0 ? (nullCount / rows.length) * 100 : 0,
    unique: uniqueVals.size,
    min,
    max,
    inferredType,
  };
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString('en-GB');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function fmtShort(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const s = String(v);
  return s.length > 30 ? s.slice(0, 27) + '…' : s;
}
