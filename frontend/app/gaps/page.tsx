'use client';

import { useState, useEffect, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import Pagination from '@/components/Pagination';
import api from '@/lib/api';
import { usePagination } from '@/lib/hooks/useDebounce';
import { useToast } from '@/components/ui/Toast';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Gap {
  id: number;
  question_text: string | null; // null for feedback-reported gaps (no query_log row)
  gap_description: string;
  resolved: boolean;
  hit_count: number;
  last_hit_at: string;
  created_at: string;
  // Present for feedback-reported gaps since R3 (LEFT join on the flagged
  // conversation message) — powers "Fix & verify".
  message_question?: string | null;
  message_answer?: string | null;
  message_sql?: string | null;
  message_query_layer?: 'product' | 'source' | null;
  message_source_key?: string | null; // "c:<connectionId>" or "v:<viewId>"
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

const BADGE_CLS = 'text-[10px] font-mono tracking-[0.08em] uppercase px-2 py-0.5 rounded border border-line';

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls = pct >= 85 ? 'bg-ok-soft text-ok' : pct >= 70 ? 'bg-warn-soft text-warn' : 'bg-err-soft text-err';
  return <span className={`${BADGE_CLS} ${cls}`}>{pct}%</span>;
}

function StatusBadge({ row }: { row: QueryLogRow }) {
  if (row.was_flagged) return <span className={`${BADGE_CLS} bg-err-soft text-err`}>Flagged</span>;
  if (row.executed) return <span className={`${BADGE_CLS} bg-ok-soft text-ok`}>Executed</span>;
  return <span className={`${BADGE_CLS} bg-warn-soft text-warn`}>Blocked</span>;
}

// ─── Main page ────────────────────────────────────────────────────────────────

function GapsPageInner() {
  const toast = useToast();

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

  useEffect(() => { loadGaps(gapsPag.page); }, [gapsPag.page, loadGaps]);
  useEffect(() => { loadLog(logPag.page); }, [logPag.page, loadLog]);
  useEffect(() => { loadPending(); }, [loadPending]);

  async function resolveGap(id: number) {
    try {
      await api.patch(`/reports/gaps/${id}/resolve`);
      await loadGaps();
      toast.success('Gap resolved');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Please try again.';
      toast.error('Could not resolve gap', { description: msg });
    }
  }

  // "Fix & verify" — a thumbs-down gap whose corrected/current SQL is on the
  // flagged message becomes a VERIFIED saved question in one click: the next
  // time anyone asks this exact question, Ask AI runs the approved SQL and the
  // answer card says "Verified by your team". Then the gap is resolved.
  const [fixingId, setFixingId] = useState<number | null>(null);
  async function fixAndVerify(g: Gap) {
    const question = g.message_question ?? g.question_text;
    const sourceKey = g.message_source_key ?? '';
    if (!question || !g.message_sql || !sourceKey.startsWith('c:')) return;
    setFixingId(g.id);
    try {
      try {
        await api.post('/saved-questions', {
          question,
          sql: g.message_sql,
          connectionId: Number(sourceKey.slice(2)),
          dataLayer: g.message_query_layer ?? 'product',
          verified: true,
        });
      } catch (err) {
        // Already saved is fine — the question exists; still resolve the gap.
        if ((err as { response?: { status?: number } })?.response?.status !== 409) throw err;
      }
      await api.patch(`/reports/gaps/${g.id}/resolve`);
      await loadGaps();
      toast.success('Saved as a verified question', { description: 'Ask AI will reuse this exact query for this question.' });
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Please try again.';
      toast.error('Could not verify', { description: msg });
    } finally {
      setFixingId(null);
    }
  }

  const unresolvedCount = gaps.filter((g) => !g.resolved).length;
  const totalLog = logRows.length;
  const executedLog = logRows.filter((r) => r.executed).length;
  const flaggedLog = logRows.filter((r) => r.was_flagged).length;
  const avgConf = totalLog > 0 ? Math.round((logRows.reduce((s, r) => s + (r.confidence_score ?? 0), 0) / totalLog) * 100) : 0;

  const contextPanel = (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-5 pb-3">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Summary</p>
      </div>
      <div className="px-4 space-y-2">
        {[
          { label: 'Open gaps',        value: unresolvedCount,   alert: unresolvedCount > 0 ? 'err' : null },
          { label: 'AI suggestions',   value: pendingItems.length, alert: pendingItems.length > 0 ? 'warn' : null },
          { label: 'Queries logged',   value: logPag.total,      alert: null },
          { label: 'Avg confidence',   value: `${avgConf}%`,     alert: null },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between">
            <span className="text-[12px] text-ink-3">{row.label}</span>
            <span className={`text-[13px] font-medium tabular-nums ${
              row.alert === 'err' ? 'text-err' : row.alert === 'warn' ? 'text-warn' : 'text-ink'
            }`}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <AppShell
      contextPanel={contextPanel}
      pills={[
        { key: 'gaps', label: `Gaps${unresolvedCount > 0 ? ` (${unresolvedCount})` : ''}` },
        { key: 'approvals', label: `AI Suggestions${pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}` },
        { key: 'log', label: 'Query Log' },
      ]}
      activePill={activePill}
      onPillChange={setActivePill}
    >
      <div className="max-w-4xl mx-auto px-6 pt-10 pb-10 space-y-6">
        <header>
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">
            {activePill === 'gaps' ? 'Gaps' : activePill === 'approvals' ? 'AI suggestions' : 'Query log'}
          </p>
          <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
            {activePill === 'gaps'
              ? "Questions the AI couldn't answer"
              : activePill === 'approvals'
                ? 'AI-generated definitions pending review'
                : 'Full query history'}
          </h1>
        </header>

        {activePill === 'approvals' ? (
          <>
            {pendingLoading && <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted text-center py-8">Loading…</p>}

            {!pendingLoading && pendingItems.length === 0 && (
              <div className="bg-raised border border-line rounded-lg p-12 text-center">
                <p className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em] mb-2">All caught up.</p>
                <p className="text-[13px] text-ink-3 max-w-md mx-auto leading-relaxed">
                  No AI suggestions pending. New AI-generated definitions will appear here for optional review. Suggestions are auto-confirmed if not reviewed.
                </p>
              </div>
            )}

            {!pendingLoading && pendingItems.length > 0 && (
              <div className="space-y-2">
                {pendingItems.map((item) => (
                  <button
                    key={`${item.type}-${item.id}`}
                    onClick={() => { window.location.href = '/semantic'; }}
                    className="w-full flex items-center gap-4 rounded-lg bg-raised border border-line hover:border-line-strong hover:bg-softer p-4 text-left transition-colors"
                  >
                    <span className={`${BADGE_CLS} capitalize flex-shrink-0 ${
                      item.type === 'table' ? 'bg-ocean-softer text-ocean' :
                      item.type === 'column' ? 'bg-ai-soft text-ai' :
                      'bg-warn-soft text-warn'
                    }`}>{item.type}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-ink truncate">{item.name}</p>
                      {item.description && (
                        <p className="text-[12px] text-ink-3 truncate mt-0.5">{item.description}</p>
                      )}
                    </div>
                    <span className={`${BADGE_CLS} flex-shrink-0 ${
                      item.status === 'ai_draft' || item.status === 'pending'
                        ? 'bg-warn-soft text-warn'
                        : 'bg-softer text-muted'
                    }`}>{item.status === 'ai_draft' ? 'AI Suggested' : item.status === 'pending' ? 'AI Suggested' : item.status}</span>
                    <span className="flex-shrink-0 text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2">
                      {relativeTime(item.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : activePill === 'gaps' ? (
          <>
            {gapsLoading && <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted text-center py-8">Loading…</p>}

            {!gapsLoading && gaps.length === 0 && (
              <div className="bg-raised border border-line rounded-lg p-12 text-center">
                <p className="text-[13px] text-ink-3 leading-relaxed">
                  No definition gaps yet. They&rsquo;ll appear here as users ask questions.
                </p>
              </div>
            )}

            {!gapsLoading && gaps.length > 0 && (
              <div className="space-y-3">
                {gaps.map((g) => (
                  <div key={g.id}
                    className={`rounded-lg p-5 border border-line transition-opacity ${
                      g.resolved ? 'bg-softer opacity-60' : 'bg-raised'
                    }`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        {/* Feedback-reported gaps have no query_log row — their
                            question lives inside gap_description, so lead with
                            that instead of empty quotes. */}
                        <p className="font-display text-[18px] italic text-ink-2 leading-snug">
                          {g.question_text ? <>&ldquo;{g.question_text}&rdquo;</> : g.gap_description}
                        </p>
                        {g.question_text && (
                          <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">{g.gap_description}</p>
                        )}
                        {/* Feedback gap with the flagged message attached —
                            show what the user was told, so the reviewer can
                            judge the answer without leaving this page. */}
                        {g.message_answer && (
                          <p className="text-[12.5px] text-muted mt-2 leading-relaxed line-clamp-3">
                            <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-2 mr-1.5">Answer given</span>
                            {g.message_answer}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-3">
                          {g.hit_count > 1 && (
                            <span className={`${BADGE_CLS} bg-ocean-softer text-ocean`}>
                              blocked {g.hit_count} questions
                            </span>
                          )}
                          <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2">{new Date(g.created_at).toLocaleDateString('nl-BE')}</span>
                        </div>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-2">
                        {!g.resolved ? (
                          <>
                            {(g.message_question ?? g.question_text) && g.message_sql && (g.message_source_key ?? '').startsWith('c:') && (
                              <button onClick={() => fixAndVerify(g)}
                                disabled={fixingId === g.id}
                                title="Save this question with its query as team-verified, then resolve the gap"
                                className="px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors disabled:opacity-50">
                                {fixingId === g.id ? 'Verifying…' : 'Fix & verify'}
                              </button>
                            )}
                            <button onClick={() => resolveGap(g.id)}
                              className="px-3 py-1.5 text-[12px] font-medium border border-line text-ink-3 rounded-md hover:border-line-strong hover:text-ink transition-colors">
                              Mark resolved
                            </button>
                          </>
                        ) : (
                          <span className={`${BADGE_CLS} bg-ok-soft text-ok`}>Resolved</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Pagination page={gapsPag.page} totalPages={gapsPag.totalPages} hasNext={gapsPag.hasNext}
                hasPrev={gapsPag.hasPrev} onPrev={gapsPag.prevPage} onNext={gapsPag.nextPage}
                onGoTo={gapsPag.goToPage} total={gapsPag.total} />
            </div>
          </>
        ) : (
          <>
            {/* Stats bar */}
            {!logLoading && totalLog > 0 && (
              <div className="flex gap-6 pb-3 border-b border-line">
                {[
                  { label: 'Total',          value: totalLog,    tone: 'text-ink' },
                  { label: 'Executed',       value: executedLog, tone: 'text-ok' },
                  { label: 'Flagged',        value: flaggedLog,  tone: 'text-err' },
                  { label: 'Avg confidence', value: `${avgConf}%`, tone: 'text-ink' },
                ].map((s) => (
                  <div key={s.label} className="flex flex-col">
                    <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted">{s.label}</span>
                    <span className={`text-[18px] font-medium tabular-nums mt-1 ${s.tone}`}>{s.value}</span>
                  </div>
                ))}
              </div>
            )}

            {logLoading && <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted text-center py-8">Loading…</p>}
            {!logLoading && logRows.length === 0 && (
              <div className="bg-raised border border-line rounded-lg p-12 text-center">
                <p className="text-[13px] text-ink-3">No queries logged yet.</p>
              </div>
            )}

            {!logLoading && logRows.length > 0 && (
              <div className="bg-raised border border-line rounded-lg overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-softer border-b border-line">
                      <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Question</th>
                      <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Confidence</th>
                      <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Status</th>
                      <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logRows.map((row) => (
                      <tr key={row.id} onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                        className="border-b border-line last:border-b-0 hover:bg-softer cursor-pointer transition-colors">
                        <td className="px-5 py-3 text-ink-2 max-w-xs truncate">{row.question_text}</td>
                        <td className="px-5 py-3"><ConfidenceBadge score={row.confidence_score ?? 0} /></td>
                        <td className="px-5 py-3"><StatusBadge row={row} /></td>
                        <td className="px-5 py-3 text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2">{relativeTime(row.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {expandedRow && (() => {
                  const row = logRows.find((r) => r.id === expandedRow);
                  if (!row) return null;
                  return (
                    <div className="bg-ink p-5 border-t border-line">
                      {row.flag_reason && (
                        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-md bg-err-soft/15 border border-err/40">
                          <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-err mt-0.5">Blocked</span>
                          <p className="text-[12px] text-err/90 leading-relaxed">{row.flag_reason}</p>
                        </div>
                      )}
                      <pre className="text-white/80 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                        {row.generated_sql ? formatSql(row.generated_sql) : '-- No SQL generated'}
                      </pre>
                    </div>
                  );
                })()}
              </div>
            )}
            <div>
              <Pagination page={logPag.page} totalPages={logPag.totalPages} hasNext={logPag.hasNext}
                hasPrev={logPag.hasPrev} onPrev={logPag.prevPage} onNext={logPag.nextPage}
                onGoTo={logPag.goToPage} total={logPag.total} />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

export default function GapsPage() {
  return (
    <RequireRole roles={['admin']}>
      <GapsPageInner />
    </RequireRole>
  );
}
