'use client';

/**
 * Pre-chat landing for /query — big serif headline + input + starter chips.
 * Starter questions are personalised: AI generates them from the tenant's
 * actual products + KPIs + dimension columns (cached server-side for 24h).
 * Falls back to generic starters when the AI hasn't run yet or the tenant
 * has no products. When arrived from a data product, the product-context
 * KPI suggestions still take precedence.
 */

import { useEffect, useState, type FormEvent } from 'react';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import { BadgeCheck, Clock3, Square, Trash2 } from 'lucide-react';

interface PersonalisedStarter {
  question: string;
  kind: 'trend' | 'compare' | 'rank' | 'why' | 'state';
}

/** One movement bullet from today's morning brief (services/morningBriefService). */
interface BriefBullet {
  kind:   'movement' | 'steady' | 'warn';
  label:  string;
  delta:  string;
  detail: string;
}

interface SavedQuestionRow {
  id:           number;
  question:     string;
  verified:     boolean;
  times_used:   number;
  creator_name: string | null;
  created_by:   number;
}

const FALLBACK_STARTERS: PersonalisedStarter[] = [
  { question: 'Who are my top 5 customers by total order value?', kind: 'rank' },
  { question: 'What was total revenue last month?', kind: 'state' },
  { question: 'Which products have the highest profit margin?', kind: 'rank' },
  { question: 'How many orders did we process this quarter?', kind: 'state' },
];

interface EmptyStateProps {
  onStarter:      (q: string) => void;
  productContext?: { name: string; kpis: string[] } | null;
  input:          string;
  setInput:       (v: string) => void;
  onSubmit:       (e: FormEvent) => void;
  loading?:       boolean;
  /** Stop the question that is running. Present whenever `loading` can be true. */
  onStop?:        () => void;
  /** Admin + analyst per the role table — gates the source-layer toggle. */
  canQuerySource?: boolean;
  useSourceLayer?: boolean;
  setUseSourceLayer?: (v: boolean) => void;
}

export default function EmptyState({
  onStarter,
  productContext,
  input,
  setInput,
  onSubmit,
  loading,
  onStop,
  canQuerySource,
  useSourceLayer,
  setUseSourceLayer,
}: EmptyStateProps) {
  // Personalised starters — fetched once on mount, cached on the server
  // for 24h. Falls back to generic starters until the response lands.
  const [personalised, setPersonalised] = useState<PersonalisedStarter[] | null>(null);
  // Proactive "Since yesterday" — today's morning brief bullets, reused as
  // clickable entry points (the brief already exists server-side; zero AI
  // calls here). Null until (and unless) a brief exists.
  const [briefBullets, setBriefBullets] = useState<BriefBullet[] | null>(null);
  // Saved questions — the tenant's library, Verified first.
  const [saved, setSaved] = useState<SavedQuestionRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/saved-questions');
        const rows = (res.data?.data ?? []) as SavedQuestionRow[];
        if (!cancelled) setSaved(rows);
      } catch { /* the block simply doesn't render */ }
    })();
    if (productContext) return () => { cancelled = true; };  // product context wins for starters/brief
    (async () => {
      try {
        const res = await api.get('/query/starters');
        const data = res.data?.data as { starters?: PersonalisedStarter[] } | undefined;
        if (!cancelled && data?.starters && data.starters.length > 0) {
          setPersonalised(data.starters);
        }
      } catch { /* fall through to defaults */ }
    })();
    (async () => {
      try {
        const res = await api.get('/briefs/today');
        const content = res.data?.data?.content as { bullets?: BriefBullet[] } | undefined;
        if (!cancelled && content?.bullets && content.bullets.length > 0) {
          setBriefBullets(content.bullets.slice(0, 3));
        }
      } catch { /* no brief yet — nothing to show */ }
    })();
    return () => { cancelled = true; };
  }, [productContext]);

  // ── Saved-question curator actions (admin + analyst) ──
  // `canQuerySource` is already "admin or analyst" per the role table, which
  // is exactly the curator set — reused rather than adding a second prop.
  const canCurate = !!canQuerySource;
  const [schedulingId, setSchedulingId] = useState<number | null>(null);
  const [scheduledIds, setScheduledIds] = useState<Set<number>>(new Set());

  const toggleVerify = async (q: SavedQuestionRow) => {
    try {
      await api.patch(`/saved-questions/${q.id}/verify`, { verified: !q.verified });
      setSaved((prev) => (prev ?? []).map((r) => (r.id === q.id ? { ...r, verified: !q.verified } : r)));
    } catch { /* leave as-is */ }
  };

  const removeSaved = async (q: SavedQuestionRow) => {
    if (!window.confirm(`Remove the saved question "${q.question}"?`)) return;
    try {
      await api.delete(`/saved-questions/${q.id}`);
      setSaved((prev) => (prev ?? []).filter((r) => r.id !== q.id));
    } catch { /* leave as-is */ }
  };

  const scheduleSaved = async (q: SavedQuestionRow, cadence: 'daily' | 'weekly') => {
    const email = getTokenPayload()?.email;
    if (!email) return;
    try {
      await api.post('/email-schedules', {
        saved_question_id: q.id,
        name: `${q.question.replace(/\?+\s*$/, '').slice(0, 80)} (${cadence})`,
        recipients: [email],
        // 08:00 daily / Monday 08:00 — server-side cron, same vehicle as
        // dashboard report schedules.
        cron_expression: cadence === 'daily' ? '0 8 * * *' : '0 8 * * 1',
      });
      setScheduledIds((prev) => new Set(prev).add(q.id));
    } catch { /* leave as-is */ } finally {
      setSchedulingId(null);
    }
  };

  // Resolution order: product-context KPIs → personalised → fallback.
  const kpiQuestions = (productContext?.kpis ?? []).slice(0, 4).map((kpi) => ({
    question: `What is the ${kpi}?`,
    kind: 'state' as const,
  }));
  const source = kpiQuestions.length > 0
    ? kpiQuestions
    : (personalised ?? FALLBACK_STARTERS);
  const questions = source.slice(0, 6);

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-16 max-w-[680px] mx-auto w-full">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted font-medium mb-4">
        Ask
      </div>
      <h1 className="font-display font-medium text-[44px] leading-[1.05] tracking-[-0.03em] text-ink m-0 mb-3 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        {productContext ? (
          <>Ask about <em>{productContext.name.toLowerCase()}.</em></>
        ) : (
          <><em>What do you want</em> to know?</>
        )}
      </h1>
      <p className="text-[15px] text-muted leading-[1.55] m-0 mb-10 max-w-[520px]">
        {productContext
          ? `Type a question about your ${productContext.name.toLowerCase()} data. No SQL needed.`
          : 'Type a question in plain language. Claude finds the answer in your connected data.'}
      </p>

      <form onSubmit={onSubmit} className="w-full">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit(e as unknown as FormEvent);
            }
          }}
          rows={2}
          disabled={loading}
          placeholder={productContext
            ? 'e.g. What drove revenue growth last quarter?'
            : 'e.g. Who were our top 5 customers last month?'}
          className="w-full font-display italic text-[20px] leading-[1.45] text-ink px-5 py-4 rounded-md border border-line bg-raised outline-none transition-all duration-1 ease-observatory resize-none placeholder:text-muted-2 focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] disabled:opacity-50"
        />
        <div className="mt-3 flex items-center justify-between gap-3 text-left">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2">
            ⌘ + Enter to send
          </span>
          <div className="flex items-center gap-4">
            {canQuerySource && setUseSourceLayer && (
              <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[10.5px] font-mono uppercase tracking-[0.08em] text-muted-2 hover:text-ink-3 transition-colors">
                <input
                  type="checkbox"
                  checked={!!useSourceLayer}
                  onChange={(e) => setUseSourceLayer(e.target.checked)}
                  className="w-3 h-3 rounded-sm border border-line accent-ocean"
                />
                Query source data
              </label>
            )}
            {loading && onStop ? (
              // A running question is stoppable from the same place it was
              // asked — see stopThinking in page.tsx.
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center gap-2 font-sans font-medium text-[13.5px] leading-none px-[18px] py-[10px] rounded-sm border bg-raised text-ink-2 border-line-strong hover:border-warn hover:text-warn transition-all duration-1 ease-observatory focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]"
              >
                <Square className="w-3 h-3 fill-current" strokeWidth={0} aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="inline-flex items-center gap-2 font-sans font-medium text-[13.5px] leading-none px-[18px] py-[10px] rounded-sm border bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover transition-all duration-1 ease-observatory disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]"
              >
                {loading ? 'Thinking…' : 'Ask →'}
              </button>
            )}
          </div>
        </div>
      </form>

      {/* Proactive entry — today's brief bullets as clickable "why" doors.
          Only renders when a brief exists; deliberately quiet otherwise. */}
      {briefBullets && briefBullets.length > 0 && (
        <div className="mt-10 w-full">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2 font-medium mb-3 text-left">
            Since yesterday
          </div>
          <div className="space-y-2">
            {briefBullets.map((b) => (
              <button
                key={b.label + b.delta}
                type="button"
                onClick={() => onStarter(`Why did ${b.label} change since yesterday?`)}
                className="w-full text-left px-4 py-3 rounded-sm border border-line bg-raised hover:border-line-strong hover:bg-softer transition-colors duration-1 ease-observatory group flex items-start gap-3"
              >
                <span
                  aria-hidden="true"
                  className={`mt-[5px] w-2 h-2 rounded-full shrink-0 ${
                    b.kind === 'warn' ? 'bg-warn' : b.kind === 'movement' ? 'bg-ocean' : 'bg-line-strong'
                  }`}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px] text-ink-2 group-hover:text-ink leading-snug">
                    <span className="font-medium">{b.label}</span>
                    {b.delta && b.delta !== '—' && <span className="text-muted"> · {b.delta}</span>}
                  </span>
                  <span className="block mt-0.5 text-[12px] text-muted leading-snug">{b.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The saved-questions library — Verified first. Clicking asks it;
          curators can verify, schedule an email, or remove. */}
      {saved && saved.length > 0 && (
        <div className="mt-10 w-full">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2 font-medium mb-3 text-left">
            Your saved questions
          </div>
          <div className="space-y-1.5">
            {saved.slice(0, 6).map((q) => (
              <div
                key={q.id}
                className="flex items-center gap-2 px-3 py-2 rounded-sm border border-line bg-raised hover:border-line-strong transition-colors duration-1 ease-observatory group"
              >
                <button
                  type="button"
                  onClick={() => onStarter(q.question)}
                  className="flex-1 min-w-0 text-left text-[13.5px] text-ink-2 group-hover:text-ink leading-snug truncate"
                  title={q.question}
                >
                  {q.question}
                </button>
                {q.verified && (
                  <span className="inline-flex items-center gap-1 text-[9.5px] font-mono uppercase tracking-[0.08em] text-ok shrink-0" title="A curator approved this question's query — Ask AI reuses it verbatim">
                    <BadgeCheck className="w-3 h-3" strokeWidth={2} />
                    Verified
                  </span>
                )}
                {canCurate && (
                  <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => toggleVerify(q)}
                      className={`p-1 rounded hover:bg-softer ${q.verified ? 'text-ok' : 'text-muted-2 hover:text-ok'}`}
                      title={q.verified ? 'Remove verification' : 'Verify — Ask AI will reuse this exact query for this question'}
                    >
                      <BadgeCheck className="w-3.5 h-3.5" strokeWidth={2} />
                    </button>
                    {scheduledIds.has(q.id) ? (
                      <span className="px-1 text-[9.5px] font-mono uppercase tracking-[0.08em] text-ok">Scheduled</span>
                    ) : schedulingId === q.id ? (
                      <span className="flex items-center gap-1 text-[10px]">
                        <button type="button" onClick={() => scheduleSaved(q, 'daily')} className="px-1.5 py-0.5 rounded border border-line hover:border-ocean text-ink-3 hover:text-ocean">Daily</button>
                        <button type="button" onClick={() => scheduleSaved(q, 'weekly')} className="px-1.5 py-0.5 rounded border border-line hover:border-ocean text-ink-3 hover:text-ocean">Weekly</button>
                        <button type="button" onClick={() => setSchedulingId(null)} className="px-1 text-muted-2 hover:text-ink-3">✕</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSchedulingId(q.id)}
                        className="p-1 rounded text-muted-2 hover:text-ocean hover:bg-softer"
                        title="Email me this answer on a schedule"
                      >
                        <Clock3 className="w-3.5 h-3.5" strokeWidth={2} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeSaved(q)}
                      className="p-1 rounded text-muted-2 hover:text-err hover:bg-softer"
                      title="Remove this saved question"
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={2} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-10 w-full">
        <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2 font-medium mb-3 text-left">
          Try one of these
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {questions.map((q) => (
            <button
              key={q.question}
              type="button"
              onClick={() => onStarter(q.question)}
              className="text-left px-4 py-3 rounded-sm border border-line bg-raised hover:border-line-strong hover:bg-softer transition-colors duration-1 ease-observatory group"
            >
              <span className="block text-[13.5px] text-ink-2 group-hover:text-ink leading-snug">
                {q.question}
              </span>
              {q.kind && (
                <span className="block mt-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-2">
                  {q.kind}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
