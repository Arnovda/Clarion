'use client';

/**
 * Shared helpers used by TableDetailPanel and ProductTableDetailPanel.
 * Lives here so the two "layer" panels don't duplicate identical logic.
 */

import { useState } from 'react';
import api from '@/lib/api';

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Parse a `domains` field that may arrive as JSON string, array, or null. */
export function parseDomains(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try { return JSON.parse(raw as string) ?? []; } catch { return []; }
}

/** Parse an `example_values` field with the same tolerance. */
export function parseExamples(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(raw as string);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return [];
}

/** Classify a SQL data type into a dtype-* visual category. */
export function classifyType(dt: string): { cls: string; icon: string } {
  const t = (dt ?? '').toLowerCase();
  if (/^(varchar|char|text|string|nvarchar|nchar|clob)/.test(t))                      return { cls: 'dtype-text',    icon: 'Aa' };
  if (/^(int|big|small|tiny|float|double|decimal|numeric|real|money|serial)/.test(t)) return { cls: 'dtype-numeric', icon: '#' };
  if (/^(date|time|timestamp|datetime|interval)/.test(t))                             return { cls: 'dtype-date',    icon: '&#128197;' };
  if (/^(bool|boolean|bit)/.test(t))                                                  return { cls: 'dtype-bool',    icon: '&#10003;' };
  if (/^(json|jsonb|xml|array)/.test(t))                                              return { cls: 'dtype-json',    icon: '{ }' };
  return { cls: 'dtype-other', icon: '?' };
}

/** Three-bucket completeness score used to drive the heatmap row colour. */
export function completenessBucket(
  hasDescription: boolean,
  hasRole: boolean,
  isConfirmed: boolean,
): 'complete' | 'partial' | 'incomplete' {
  const score = Number(hasDescription) + Number(hasRole) + Number(isConfirmed);
  return score >= 3 ? 'complete' : score >= 1 ? 'partial' : 'incomplete';
}

// ─── PreviewTable — shared "load & show 10 rows" control ────────────────────

interface PreviewTableProps {
  /** Endpoint that returns `{ data: { rows, columns } }`. Called on demand. */
  url: string;
}

/**
 * Used by both the source-table and product-table detail panels.
 * Source panels pass `/semantic/preview?connectionId=...&table=...`.
 * Product panels pass `/semantic/product-preview?productTableId=...`.
 */
export function PreviewTable({ url }: PreviewTableProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [rows, setRows]   = useState<Record<string, unknown>[]>([]);
  const [cols, setCols]   = useState<string[]>([]);
  const [errMsg, setErr]  = useState('');

  async function load() {
    setState('loading');
    try {
      const res = await api.get(url);
      setRows(res.data.data.rows);
      setCols(res.data.data.columns);
      setState('done');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load preview';
      setErr(msg);
      setState('error');
    }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={load}
        className="inline-flex items-center gap-2 text-[12px] text-ocean hover:text-ocean-hover font-medium group transition-colors"
      >
        <span className="w-5 h-5 rounded-md bg-ocean-softer group-hover:bg-ocean-soft flex items-center justify-center transition-colors">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        </span>
        Preview data
      </button>
    );
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-2">
        <span className="w-3 h-3 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
        Loading preview…
      </div>
    );
  }

  if (state === 'error') {
    return <p className="text-[12px] text-err">{errMsg}</p>;
  }

  return (
    <div className="mt-3 panel-enter">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted">First {rows.length} rows</span>
        <button onClick={() => setState('idle')} className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 hover:text-ink-2 transition-colors">Hide</button>
      </div>
      <div className="preview-terminal rounded-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} className="px-3 py-2.5 text-left whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-white/[0.04]">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 whitespace-nowrap max-w-[200px] truncate" title={String(row[c] ?? '')}>
                      {row[c] == null ? <span className="text-white/20 italic">null</span> : String(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
