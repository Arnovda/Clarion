'use client';

/**
 * /home — the standing brief.
 *
 * ONE page for every role. It answers "what should I know this morning?"
 * with a sentence about the user's BUSINESS, then offers the ask box, then
 * the things that moved, then the numbers they watch.
 *
 * WHAT THIS REPLACED, AND WHY (docs/backlog/home-experience.md):
 *   • A 0–100 health ring with four sub-score tiles. Every number on it was
 *     about Clarion, not about the company — and `FRESHNESS 0/100` is the
 *     NORMAL reading for a monthly-close accounting dataset, so the page
 *     taught people to ignore its own signals.
 *   • A "worth your attention" feed of curator chores (pending AI reviews,
 *     unrefreshed subjects) framed as the user's failures. Those moved to
 *     badges on Sources and Build, where the work actually happens.
 *   • `PulsePanel`, a setup wizard rendered in the daily view every single
 *     day. Picking metrics is now behind "Edit" on the board.
 *   • A separate `ViewerHome`. The two shapes have collapsed: this page is
 *     the viewer's page, and the only role-conditional thing on it is the
 *     Refresh action in the operational line.
 *
 * THE GOVERNING RULE: the assistant speaks first. An ask box alone is a
 * PULL interface — it hands the burden of curiosity back to the user every
 * morning, and the premise of this product is that most owners don't know
 * what to ask. So: "here's what I noticed, also ask me anything." If a
 * future change leaves the box alone on the page, that change is wrong.
 *
 * Four fetches, all in parallel, all already tenant-scoped:
 *   /home/summary   freshness + dashboards + recent questions
 *   /briefs/today   the brief, and (R2) the investigation already run for it
 *   /pulse/state    the watched metrics, with deltas and 30 days of history
 *   /query/starters cached 24h per tenant — costs nothing on a page load
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Layers, Loader2, RefreshCw, X } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { canCurate, getRole, type Role } from '@/lib/role';
import { deriveLead, deriveOpsLine } from './lead';
import { AskBox, OpsLine, WatchPanel } from './pieces';
import { MovementCards } from './MovementCards';
import { Board } from './Board';
import { FreshnessDetail } from './FreshnessDetail';
import { DashboardsSection, RecentQuestionsSection } from './sections';
import { QuietCard, ColdStartCard } from './states';
import type { Brief, HomeSummary, PulseTile, QueryStarter } from './types';

// The metric picker. It used to render on the page every single day, with a
// greyed-out "Save 0 entries" button — a setup wizard squatting in the daily
// view. It is the same component, now reached from "Edit" on the board.
const PulsePanel = dynamic(() => import('@/components/pulse/PulsePanel'), { ssr: false });

interface Suggestion {
  key: string;
  label: string;
  rationale: string | null;
  raw: Record<string, unknown>;
}

export default function HomePage() {
  const router = useRouter();
  const jump = useCallback((path: string) => router.push(path), [router]);

  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [tiles, setTiles] = useState<PulseTile[]>([]);
  const [starters, setStarters] = useState<QueryStarter[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [freshnessOpen, setFreshnessOpen] = useState(false);
  const [pulseOpen, setPulseOpen] = useState(false);

  const [watchBusy, setWatchBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => { setRole(getRole()); }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    // Each of the four degrades on its own: a failing starters call must not
    // cost the user the brief. `catch` per promise, never one big try.
    const [s, b, p, st] = await Promise.all([
      api.get('/home/summary').then((r) => r.data?.data as HomeSummary).catch(() => null),
      api.get('/briefs/today').then((r) => r.data?.data as Brief | null).catch(() => null),
      api.get('/pulse/state').then((r) => (r.data?.data ?? []) as PulseTile[]).catch(() => [] as PulseTile[]),
      api.get('/query/starters').then((r) => (r.data?.data?.starters ?? []) as QueryStarter[]).catch(() => [] as QueryStarter[]),
    ]);
    if (s) setSummary(s);
    setBrief(b);
    setTiles(p);
    setStarters(st);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onFocus = () => { setRefreshing(true); void load(true); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  useEffect(() => {
    api.get('/users/profile')
      .then((r) => {
        const u = r.data?.data;
        if (u?.display_name) setUserName(String(u.display_name).split(' ')[0]);
        else if (u?.email) setUserName(String(u.email).split('@')[0]);
      })
      .catch(() => {});
  }, []);

  const today = useMemo(() => new Date().toLocaleDateString('en-GB', {
    weekday: 'long', month: 'long', day: 'numeric',
  }), []);

  const ask = useCallback((q: string) => {
    const trimmed = q.trim();
    jump(trimmed ? `/query?q=${encodeURIComponent(trimmed)}&autoSubmit=1` : '/query');
  }, [jump]);

  // ── Watch: plain English in, proposals back, nothing added silently ──────
  const onWatch = useCallback(async (intent: string) => {
    setWatchBusy(true);
    try {
      const res = await api.post('/pulse/suggest?force=1', { intent });
      const raw = (res.data?.data?.suggestions ?? []) as Array<Record<string, unknown>>;
      setSuggestions(raw.map((s, i) => ({
        key: `${i}-${String(s.label ?? '')}`,
        label: String(s.label ?? 'Untitled'),
        rationale: s.rationale ? String(s.rationale) : null,
        raw: s,
      })));
    } catch {
      setSuggestions([]);
    } finally {
      setWatchBusy(false);
    }
  }, []);

  const onAccept = useCallback(async (key: string) => {
    const s = suggestions.find((x) => x.key === key);
    if (!s) return;
    setSuggestions((prev) => prev.filter((x) => x.key !== key));
    try {
      await api.post('/pulse/apply-suggest', { suggestions: [s.raw] });
      const p = await api.get('/pulse/state').then((r) => (r.data?.data ?? []) as PulseTile[]);
      setTiles(p);
    } catch { /* the chip is already gone; a failed add is visible as its absence */ }
  }, [suggestions]);

  const onRemoveWatch = useCallback(async (id: number) => {
    setTiles((prev) => prev.filter((t) => t.id !== id));
    try { await api.delete(`/pulse/${id}`); } catch { void load(true); }
  }, [load]);

  if (loading || role === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted" />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        Could not load your home page.
      </div>
    );
  }

  const curator = canCurate(role);
  const newestSyncAt = summary.freshness.allSources
    .map((s) => s.lastSyncedAt)
    .filter((d): d is string => !!d)
    .sort()
    .pop() ?? null;

  const lead = deriveLead({
    brief,
    tiles,
    sourceCount: summary.freshness.allSources.length,
    newestSyncAt,
  });

  const ops = deriveOpsLine({
    newestSyncAt,
    staleSources: summary.freshness.stale,
    staleProductCount: summary.freshness.staleProducts.length,
    sourceCount: summary.freshness.allSources.length,
  });

  return (
    <div className="flex-1 overflow-auto bg-bg" data-testid="home">
      {/* Reading width, not dashboard width — a briefing is read. */}
      <div className="max-w-[780px] mx-auto px-6 pt-9 pb-16">

        {/* ── THE LEAD ───────────────────────────────────────────────────
            The largest type on the page is a sentence about the business.
            The page this replaced led with the number 73. */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4 mb-2">
            <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted">
              {today}{userName ? ` · ${userName}` : ''}
            </p>
            <button
              type="button"
              onClick={() => { setRefreshing(true); void load(true); }}
              disabled={refreshing}
              aria-label="Refresh"
              className="shrink-0 inline-flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-muted border border-line rounded-md hover:bg-softer hover:text-ink-2 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn('w-3 h-3', refreshing && 'animate-spin')} strokeWidth={2} />
            </button>
          </div>

          <h1 className="font-display text-[31px] font-normal text-ink leading-[1.28] tracking-[-0.015em] text-balance">
            {lead.emphasis && lead.headline.includes(lead.emphasis) ? (
              <>
                {lead.headline.slice(0, lead.headline.indexOf(lead.emphasis))}
                <em className="not-italic shadow-[inset_0_-0.44em_0_var(--warn-soft)]">{lead.emphasis}</em>
                {lead.headline.slice(lead.headline.indexOf(lead.emphasis) + lead.emphasis.length)}
              </>
            ) : lead.headline}
          </h1>

          {lead.sub.length > 0 && (
            <p className="mt-2.5 flex items-center gap-1.5 flex-wrap text-[13px] text-muted">
              {lead.sub.map((s, i) => (
                <span key={s} className="flex items-center gap-1.5">
                  {i > 0 && <span className="w-[3px] h-[3px] rounded-full bg-muted-2" aria-hidden />}
                  {s}
                </span>
              ))}
            </p>
          )}
        </div>

        {/* ── ASK ────────────────────────────────────────────────────── */}
        <AskBox starters={starters} onAsk={ask} />

        {/* ── WHAT MOVED / QUIET / COLD ──────────────────────────────── */}
        {lead.tone === 'moved' && (
          <section className="mb-8">
            <div className="flex items-baseline justify-between gap-3 mb-3">
              <p className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">What moved</p>
              {tiles.length > lead.cards.length && (
                <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted-2">
                  {tiles.length} watched
                </span>
              )}
            </div>
            <MovementCards
              bullets={lead.cards}
              tiles={tiles}
              investigation={brief?.investigation}
              onAsk={ask}
            />
          </section>
        )}

        {lead.tone === 'quiet' && (
          <section className="mb-8">
            <QuietCard bullets={brief?.content.bullets ?? []} />
          </section>
        )}

        {(lead.tone === 'cold' || lead.tone === 'waiting') && (
          <section className="mb-8">
            <ColdStartCard tone={lead.tone} curator={curator} onJump={jump} />
          </section>
        )}

        {/* ── BOARD ──────────────────────────────────────────────────── */}
        <Board tiles={tiles} onAsk={ask} onEdit={() => setPulseOpen(true)} />

        {/* ── WATCH ──────────────────────────────────────────────────── */}
        <WatchPanel
          watching={tiles}
          onWatch={onWatch}
          onRemove={onRemoveWatch}
          busy={watchBusy}
          suggestions={suggestions.map(({ key, label, rationale }) => ({ key, label, rationale }))}
          onAccept={onAccept}
          onDismissSuggestion={(k) => setSuggestions((prev) => prev.filter((x) => x.key !== k))}
        />

        {/* ── PICK UP WHERE YOU LEFT OFF ─────────────────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
          <DashboardsSection dashboards={summary.dashboards} onJump={jump} />
          <RecentQuestionsSection questions={summary.recentQuestions} onJump={jump} />
        </section>

        <button
          type="button"
          onClick={() => jump('/subjects')}
          className="group w-full flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-3 text-left transition-colors hover:border-ocean mb-6"
        >
          <Layers className="h-4 w-4 shrink-0 text-muted-2" strokeWidth={1.7} aria-hidden />
          <span className="flex-1">
            <span className="block text-[13.5px] text-ink">Subjects</span>
            <span className="block text-[12px] text-muted">Everything your team can ask about, in one place.</span>
          </span>
        </button>

        {/* ── THE ONE OPERATIONAL LINE ───────────────────────────────── */}
        {ops && (
          <OpsLine
            asOf={ops.asOf}
            problem={ops.problem}
            canRefresh={curator}
            onRefresh={() => jump('/pipelines')}
            onDetails={() => setFreshnessOpen(true)}
          />
        )}
      </div>

      {pulseOpen && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Edit your board">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-ink/20"
            onClick={() => { setPulseOpen(false); void load(true); }}
          />
          <div className="relative h-full w-full max-w-[540px] overflow-auto bg-bg border-l border-line shadow-3">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
              <p className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">Edit your board</p>
              <button
                type="button"
                onClick={() => { setPulseOpen(false); void load(true); }}
                aria-label="Close"
                className="rounded p-1 text-muted hover:bg-softer hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
            <div className="p-5">
              <PulsePanel />
            </div>
          </div>
        </div>
      )}

      {freshnessOpen && (
        <FreshnessDetail
          sources={summary.freshness.allSources}
          products={summary.freshness.allProducts}
          onClose={() => setFreshnessOpen(false)}
          onJumpToPipelines={() => { setFreshnessOpen(false); jump('/pipelines'); }}
        />
      )}
    </div>
  );
}
