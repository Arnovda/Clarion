'use client';

import { useState, useEffect, useCallback } from 'react';
import Nav from '@/components/Nav';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Gap {
  id: number;
  question_text: string;
  gap_description: string;
  resolved: boolean;
  created_at: string;
}

interface QueryLogRow {
  id: number;
  user_id: string;
  question_text: string;
  generated_sql: string;
  confidence_score: number;
  executed: boolean;
  was_flagged: boolean;
  flag_reason: string | null;
  created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatSql(sql: string): string {
  const keywords = ['SELECT', 'FROM', 'LEFT JOIN', 'JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT'];
  let result = sql;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw}\\b`, 'gi');
    result = result.replace(re, `\n${kw}`);
  }
  return result.trim();
}

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  if (pct >= 85) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-800">
        {pct}%
      </span>
    );
  }
  if (pct >= 70) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800">
        {pct}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800">
      {pct}%
    </span>
  );
}

function StatusBadge({ row }: { row: QueryLogRow }) {
  if (row.was_flagged) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">
        Flagged
      </span>
    );
  }
  if (row.executed) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700">
        Executed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">
      Blocked
    </span>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function GapsPage() {
  const role = getTokenPayload()?.role;
  const isAdmin = role === 'epicdata_admin';

  const [activeTab, setActiveTab] = useState<'gaps' | 'log'>('gaps');

  // Gaps state
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [gapsLoading, setGapsLoading] = useState(true);

  // Query log state
  const [logRows, setLogRows] = useState<QueryLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const loadGaps = useCallback(async () => {
    setGapsLoading(true);
    try {
      const res = await api.get('/reports/gaps');
      setGaps(res.data.data ?? []);
    } catch {
      setGaps([]);
    } finally {
      setGapsLoading(false);
    }
  }, []);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const res = await api.get('/reports/query-log');
      setLogRows(res.data.data ?? []);
    } catch {
      setLogRows([]);
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadGaps();
    loadLog();
  }, [isAdmin, loadGaps, loadLog]);

  async function resolveGap(id: number) {
    await api.patch(`/reports/gaps/${id}/resolve`);
    await loadGaps();
  }

  function toggleRow(id: number) {
    setExpandedRow((prev) => (prev === id ? null : id));
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50">
        <Nav />
        <div className="max-w-4xl mx-auto pt-16 px-4 text-center">
          <div className="bg-white rounded-xl border border-slate-200 p-12 inline-block">
            <p className="text-2xl font-bold text-slate-800 mb-2">Access denied</p>
            <p className="text-slate-500 text-sm">This page is only available to EpicData admins.</p>
          </div>
        </div>
      </div>
    );
  }

  const unresolvedCount = gaps.filter((g) => !g.resolved).length;

  // Log stats
  const totalLog = logRows.length;
  const executedLog = logRows.filter((r) => r.executed).length;
  const flaggedLog = logRows.filter((r) => r.was_flagged).length;
  const avgConfidence =
    totalLog > 0
      ? Math.round((logRows.reduce((sum, r) => sum + (r.confidence_score ?? 0), 0) / totalLog) * 100)
      : 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav />

      <div className="max-w-4xl mx-auto pt-8 px-4 pb-16">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Admin — Gaps &amp; Log</h1>
        <p className="text-slate-500 text-sm mb-6">
          Review questions the AI couldn&apos;t answer confidently and inspect all query history.
        </p>

        {/* Tab bar */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex border-b border-slate-200">
            <button
              onClick={() => setActiveTab('gaps')}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'gaps'
                  ? 'border-b-2 border-blue-600 text-blue-600 bg-white'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Definition Gaps
              {unresolvedCount > 0 && (
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs font-bold">
                  {unresolvedCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('log')}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === 'log'
                  ? 'border-b-2 border-blue-600 text-blue-600 bg-white'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Query Log
            </button>
          </div>

          {/* ── Tab 1: Definition Gaps ── */}
          {activeTab === 'gaps' && (
            <div className="p-6">
              {gapsLoading && (
                <p className="text-sm text-slate-400 text-center py-8">Loading…</p>
              )}

              {!gapsLoading && gaps.length === 0 && (
                <div className="text-center text-slate-400 text-sm py-12">
                  No definition gaps yet. Keep an eye on this page as users start asking questions.
                </div>
              )}

              {!gapsLoading && gaps.length > 0 && (
                <div className="space-y-3">
                  {gaps.map((g) => (
                    <div
                      key={g.id}
                      className={`rounded-lg border p-4 transition-opacity ${
                        g.resolved
                          ? 'border-slate-100 bg-slate-50 opacity-50'
                          : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-800 leading-snug">
                            &ldquo;{g.question_text}&rdquo;
                          </p>
                          <p className="text-sm text-slate-500 mt-1">{g.gap_description}</p>
                          <p className="text-xs text-slate-400 mt-1">
                            {new Date(g.created_at).toLocaleDateString('nl-BE')}
                          </p>
                        </div>
                        <div className="shrink-0">
                          {!g.resolved ? (
                            <button
                              onClick={() => resolveGap(g.id)}
                              className="px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors whitespace-nowrap"
                            >
                              Mark resolved
                            </button>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                              ✓ Resolved
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab 2: Query Log ── */}
          {activeTab === 'log' && (
            <div className="p-6">
              {/* Stat bar */}
              {!logLoading && totalLog > 0 && (
                <div className="flex gap-6 mb-5 text-sm">
                  <div>
                    <span className="text-slate-400">Total</span>{' '}
                    <span className="font-semibold text-slate-800">{totalLog}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Executed</span>{' '}
                    <span className="font-semibold text-green-700">{executedLog}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Flagged</span>{' '}
                    <span className="font-semibold text-red-600">{flaggedLog}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Avg confidence</span>{' '}
                    <span className="font-semibold text-slate-800">{avgConfidence}%</span>
                  </div>
                </div>
              )}

              {logLoading && (
                <p className="text-sm text-slate-400 text-center py-8">Loading…</p>
              )}

              {!logLoading && logRows.length === 0 && (
                <div className="text-center text-slate-400 text-sm py-12">
                  No queries logged yet.
                </div>
              )}

              {!logLoading && logRows.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">
                        <th className="px-4 py-3">Question</th>
                        <th className="px-4 py-3 whitespace-nowrap">Confidence</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3 whitespace-nowrap">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logRows.map((row) => (
                        <>
                          <tr
                            key={row.id}
                            onClick={() => toggleRow(row.id)}
                            className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                          >
                            <td className="px-4 py-3 text-slate-800 max-w-xs truncate">
                              {row.question_text}
                            </td>
                            <td className="px-4 py-3">
                              <ConfidenceBadge score={row.confidence_score ?? 0} />
                            </td>
                            <td className="px-4 py-3">
                              <StatusBadge row={row} />
                            </td>
                            <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                              {relativeTime(row.created_at)}
                            </td>
                          </tr>
                          {expandedRow === row.id && (
                            <tr key={`${row.id}-expanded`} className="bg-slate-950">
                              <td colSpan={4} className="px-4 py-4">
                                <pre className="bg-slate-900 rounded-lg p-4 text-green-400 font-mono text-xs overflow-x-auto whitespace-pre-wrap break-words">
                                  {row.generated_sql
                                    ? formatSql(row.generated_sql)
                                    : '-- No SQL generated'}
                                </pre>
                                {row.flag_reason && (
                                  <p className="mt-2 text-xs text-red-400 font-medium">
                                    Flag reason: {row.flag_reason}
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
