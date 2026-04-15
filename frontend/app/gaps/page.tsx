'use client';

import { useState, useEffect, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import Pagination from '@/components/Pagination';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import { usePagination } from '@/lib/hooks/useDebounce';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Gap {
  id: number;
  question_text: string;
  gap_description: string;
  resolved: boolean;
  hit_count: number;
  last_hit_at: string;
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
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000); const h = Math.floor(d / 3600000); const dy = Math.floor(d / 86400000);
  if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; if (h < 24) return `${h}h ago`; return `${dy}d ago`;
}

function formatSql(sql: string): string {
  const kws = ['SELECT', 'FROM', 'LEFT JOIN', 'JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT'];
  let result = sql;
  for (const kw of kws) result = result.replace(new RegExp(`\\b${kw}\\b`, 'gi'), `\n${kw}`);
  return result.trim();
}

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls = pct >= 85 ? 'bg-amber-500/10 text-amber-700' : pct >= 70 ? 'bg-amber-500/10 text-amber-600' : 'bg-error/10 text-error';
  return <span className={`text-label-md px-2 py-0.5 rounded-pill font-semibold ${cls}`}>{pct}%</span>;
}

function StatusBadge({ row }: { row: QueryLogRow }) {
  if (row.was_flagged) return <span className="text-label-md px-2 py-0.5 rounded-pill font-semibold bg-error/10 text-error">Flagged</span>;
  if (row.executed) return <span className="text-label-md px-2 py-0.5 rounded-pill font-semibold bg-green-100 text-green-700">Executed</span>;
  return <span className="text-label-md px-2 py-0.5 rounded-pill font-semibold bg-amber-100 text-amber-700">Blocked</span>;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function GapsPage() {
  const role = getTokenPayload()?.role;
  const isAdminUser = role === 'admin';

  const [activePill, setActivePill] = useState('gaps');
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [gapsLoading, setGapsLoading] = useState(true);
  const gapsPag = usePagination(50);
  const [logRows, setLogRows] = useState<QueryLogRow[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const logPag = usePagination(50);

  // Approval queue
  interface PendingItem { id: number; type: 'table' | 'column' | 'kpi'; name: string; description: string; status: string; updated_at: string; }
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);

  const loadGaps = useCallback(async (page = 1) => {
    setGapsLoading(true);
    try {
      const res = await api.get(`/reports/gaps?page=${page}&limit=${gapsPag.limit}`);
      setGaps(res.data.data ?? []);
      if (res.data.pagination) gapsPag.setTotal(res.data.pagination.total);
    } catch { setGaps([]); } finally { setGapsLoading(false); }
  }, [gapsPag.limit]);

  const loadLog = useCallback(async (page = 1) => {
    setLogLoading(true);
    try {
      const res = await api.get(`/reports/query-log?page=${page}&limit=${logPag.limit}`);
      setLogRows(res.data.data ?? []);
      if (res.data.pagination) logPag.setTotal(res.data.pagination.total);
    } catch { setLogRows([]); } finally { setLogLoading(false); }
  }, [logPag.limit]);

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const res = await api.get('/semantic/pending-approvals');
      setPendingItems(res.data.data ?? []);
    } catch { setPendingItems([]); } finally { setPendingLoading(false); }
  }, []);

  useEffect(() => { if (isAdminUser) loadGaps(gapsPag.page); }, [isAdminUser, gapsPag.page, loadGaps]);
  useEffect(() => { if (isAdminUser) loadLog(logPag.page); }, [isAdminUser, logPag.page, loadLog]);
  useEffect(() => { if (isAdminUser) loadPending(); }, [isAdminUser, loadPending]);

  async function resolveGap(id: number) { await api.patch(`/reports/gaps/${id}/resolve`); await loadGaps(); }

  const unresolvedCount = gaps.filter((g) => !g.resolved).length;
  const totalLog = logRows.length;
  const executedLog = logRows.filter((r) => r.executed).length;
  const flaggedLog = logRows.filter((r) => r.was_flagged).length;
  const avgConf = totalLog > 0 ? Math.round((logRows.reduce((s, r) => s + (r.confidence_score ?? 0), 0) / totalLog) * 100) : 0;

  const contextPanel = (
    <div className="p-4 space-y-6">
      <div>
        <div className="text-label-md text-on-surface-variant font-semibold uppercase tracking-wider mb-3">Summary</div>
        <div className="space-y-2">
          <div className="flex items-center justify-between px-2">
            <span className="text-body-sm text-on-surface-variant">Open gaps</span>
            <span className={`text-body-sm font-bold ${unresolvedCount > 0 ? 'text-error' : 'text-on-surface'}`}>{unresolvedCount}</span>
          </div>
          <div className="flex items-center justify-between px-2">
            <span className="text-body-sm text-on-surface-variant">Pending approvals</span>
            <span className={`text-body-sm font-bold ${pendingItems.length > 0 ? 'text-amber-600' : 'text-on-surface'}`}>{pendingItems.length}</span>
          </div>
          <div className="flex items-center justify-between px-2">
            <span className="text-body-sm text-on-surface-variant">Queries logged</span>
            <span className="text-body-sm font-bold text-on-surface">{logPag.total}</span>
          </div>
          <div className="flex items-center justify-between px-2">
            <span className="text-body-sm text-on-surface-variant">Avg confidence</span>
            <span className="text-body-sm font-bold text-on-surface">{avgConf}%</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <AppShell
      title="Review Queue"
      subtitle="Questions the AI couldn't answer and query history"
      contextPanel={contextPanel}
      pills={[
        { key: 'gaps', label: `Gaps${unresolvedCount > 0 ? ` (${unresolvedCount})` : ''}` },
        { key: 'approvals', label: `Approvals${pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}` },
        { key: 'log', label: 'Query Log' },
      ]}
      activePill={activePill}
      onPillChange={setActivePill}
    >
      {activePill === 'approvals' ? (
        <div className="p-6 max-w-4xl">
          {pendingLoading && <p className="text-body-sm text-on-surface-variant text-center py-8">Loading...</p>}

          {!pendingLoading && pendingItems.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">&#10003;</div>
              <h3 className="text-title-md font-semibold text-on-surface mb-1">All caught up!</h3>
              <p className="text-body-sm text-on-surface-variant max-w-sm mx-auto">
                No definitions are waiting for approval. AI drafts and changes will appear here when they need review.
              </p>
            </div>
          )}

          {!pendingLoading && pendingItems.length > 0 && (
            <div className="space-y-2">
              {pendingItems.map((item) => (
                <div key={`${item.type}-${item.id}`}
                  className="flex items-center gap-4 rounded-2xl bg-surface-container-lowest shadow-ambient p-4 hover:bg-surface-container-low transition-colors cursor-pointer"
                  onClick={() => {
                    window.location.href = '/semantic';
                  }}
                >
                  <div className="flex-shrink-0">
                    <span className={`inline-block text-label-md px-2 py-0.5 rounded-pill font-semibold capitalize ${
                      item.type === 'table' ? 'bg-blue-100 text-blue-700' :
                      item.type === 'column' ? 'bg-purple-100 text-purple-700' :
                      'bg-amber-100 text-amber-700'
                    }`}>{item.type}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-body-sm font-semibold text-on-surface truncate">{item.name}</p>
                    {item.description && (
                      <p className="text-label-md text-on-surface-variant truncate">{item.description}</p>
                    )}
                  </div>
                  <div className="flex-shrink-0">
                    <span className={`text-label-md px-2 py-0.5 rounded-pill font-semibold ${
                      item.status === 'ai_draft' ? 'bg-amber-500/10 text-amber-600' :
                      item.status === 'pending' ? 'bg-blue-500/10 text-blue-600' :
                      'bg-slate-100 text-slate-500'
                    }`}>{item.status === 'ai_draft' ? 'AI Draft' : item.status}</span>
                  </div>
                  <div className="flex-shrink-0 text-label-sm text-on-surface-variant/50">
                    {relativeTime(item.updated_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : activePill === 'gaps' ? (
        <div className="p-6 max-w-4xl">
          {gapsLoading && <p className="text-body-sm text-on-surface-variant text-center py-8">Loading...</p>}

          {!gapsLoading && gaps.length === 0 && (
            <div className="text-center text-on-surface-variant text-body-md py-16">
              No definition gaps yet. They'll appear here as users ask questions.
            </div>
          )}

          {!gapsLoading && gaps.length > 0 && (
            <div className="space-y-3">
              {gaps.map((g) => (
                <div key={g.id}
                  className={`rounded-2xl p-5 transition-opacity ${
                    g.resolved ? 'bg-surface-container-low opacity-50' : 'bg-surface-container-lowest shadow-ambient'
                  }`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-body-md font-semibold text-on-surface leading-snug">&ldquo;{g.question_text}&rdquo;</p>
                      <p className="text-body-sm text-on-surface-variant mt-1">{g.gap_description}</p>
                      <div className="flex items-center gap-2 mt-2">
                        {g.hit_count > 1 && (
                          <span className="text-label-md px-2 py-0.5 rounded-pill font-semibold bg-primary/10 text-primary">
                            blocked {g.hit_count} questions
                          </span>
                        )}
                        <span className="text-label-sm text-on-surface-variant/50">{new Date(g.created_at).toLocaleDateString('nl-BE')}</span>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {!g.resolved ? (
                        <button onClick={() => resolveGap(g.id)}
                          className="px-3.5 py-1.5 text-label-lg font-semibold bg-green-600 text-white rounded-xl hover:bg-green-700 transition-colors">
                          Mark resolved
                        </button>
                      ) : (
                        <span className="text-label-md px-2.5 py-1 rounded-pill font-semibold bg-green-100 text-green-700">Resolved</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4">
            <Pagination page={gapsPag.page} totalPages={gapsPag.totalPages} hasNext={gapsPag.hasNext}
              hasPrev={gapsPag.hasPrev} onPrev={gapsPag.prevPage} onNext={gapsPag.nextPage}
              onGoTo={gapsPag.goToPage} total={gapsPag.total} />
          </div>
        </div>
      ) : (
        <div className="p-6 max-w-5xl">
          {/* Stats bar */}
          {!logLoading && totalLog > 0 && (
            <div className="flex gap-6 mb-5">
              {[
                { label: 'Total', value: totalLog, cls: 'text-on-surface' },
                { label: 'Executed', value: executedLog, cls: 'text-green-700' },
                { label: 'Flagged', value: flaggedLog, cls: 'text-error' },
                { label: 'Avg confidence', value: `${avgConf}%`, cls: 'text-on-surface' },
              ].map((s) => (
                <div key={s.label} className="text-body-sm">
                  <span className="text-on-surface-variant">{s.label} </span>
                  <span className={`font-bold ${s.cls}`}>{s.value}</span>
                </div>
              ))}
            </div>
          )}

          {logLoading && <p className="text-body-sm text-on-surface-variant text-center py-8">Loading...</p>}
          {!logLoading && logRows.length === 0 && (
            <div className="text-center text-on-surface-variant text-body-md py-16">No queries logged yet.</div>
          )}

          {!logLoading && logRows.length > 0 && (
            <div className="bg-surface-container-lowest rounded-2xl shadow-ambient overflow-hidden">
              <table className="w-full text-body-sm">
                <thead>
                  <tr className="bg-surface-container-low">
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Question</th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Confidence</th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Status</th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">When</th>
                  </tr>
                </thead>
                <tbody>
                  {logRows.map((row) => (
                    <tr key={row.id} onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                      className="border-t border-outline-variant/10 hover:bg-surface-container-low cursor-pointer transition-colors">
                      <td className="px-5 py-3 text-on-surface max-w-xs truncate">{row.question_text}</td>
                      <td className="px-5 py-3"><ConfidenceBadge score={row.confidence_score ?? 0} /></td>
                      <td className="px-5 py-3"><StatusBadge row={row} /></td>
                      <td className="px-5 py-3 text-on-surface-variant">{relativeTime(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {expandedRow && (() => {
                const row = logRows.find((r) => r.id === expandedRow);
                if (!row) return null;
                return (
                  <div className="bg-inverse-surface p-5">
                    <pre className="text-green-400 font-mono text-label-md overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {row.generated_sql ? formatSql(row.generated_sql) : '-- No SQL generated'}
                    </pre>
                    {row.flag_reason && <p className="mt-2 text-label-md text-error font-medium">Flag: {row.flag_reason}</p>}
                  </div>
                );
              })()}
            </div>
          )}
          <div className="mt-4">
            <Pagination page={logPag.page} totalPages={logPag.totalPages} hasNext={logPag.hasNext}
              hasPrev={logPag.hasPrev} onPrev={logPag.prevPage} onNext={logPag.nextPage}
              onGoTo={logPag.goToPage} total={logPag.total} />
          </div>
        </div>
      )}
    </AppShell>
  );
}
