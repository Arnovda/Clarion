'use client';

/**
 * /home — the daily driver.
 *
 * One page that answers "what should I look at right now?" without forcing
 * the user to translate their job into our vocabulary. Three layers,
 * stacked top-to-bottom:
 *
 *   1. HEALTH (gamified)  — single big 0–100 ring + sub-scores. Drives
 *      a sense of "is the platform healthy?" at a glance and creates a
 *      pull to fix the lowest sub-score (definitions / freshness / runs).
 *   2. ATTENTION           — alerts, stale data, failed runs, pending
 *      review. The "what's broken" feed that motivates a return visit.
 *   3. ACT                 — pinned/recent dashboards + recent questions
 *      with one-click replay, plus quick links to ask a new question /
 *      open the catalog.
 *
 * Everything reads from a single GET /api/home/summary so the page is
 * snappy and refreshes on focus.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, Calendar, CheckCircle2, Clock, Database, Boxes,
  RefreshCw, Sparkles, Library, ShieldCheck, ChevronRight, BarChart3,
  Loader2, Star, Plus, X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import api from '@/lib/api';
import { OBSERVATORY } from '@/lib/observatory';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';

// Dynamic import — Pulse pulls in AI-related types and state, no need on first paint.
const PulsePanel = dynamic(() => import('@/components/pulse/PulsePanel'), { ssr: false });

interface HomeSummary {
  health: {
    overall: number | null;
    freshness: number | null;
    definitions: number | null;
    pipelines: number | null;
  };
  freshness: {
    sources:  { fresh: number; total: number };
    products: { fresh: number; total: number };
    stale: Array<{ id: number; name: string; lastSyncedAt: string | null }>;
    staleProducts: Array<{ id: number; name: string; status: string; lastRefreshedAt: string | null; isStale: boolean }>;
    allSources: Array<{ id: number; name: string; connectorType: string | null; lastSyncedAt: string | null; lastSyncStatus: string | null; isStale: boolean }>;
    allProducts: Array<{ id: number; name: string; status: string; lastRefreshedAt: string | null; isStale: boolean }>;
  };
  definitions: {
    tables:        { defined: number; total: number };
    columns:       { defined: number; total: number };
    relationships: { approved: number; total: number };
    pendingReview: { tables: number; columns: number; relationships: number; total: number };
  };
  pipelines: {
    runsThisWeek: number;
    successCount: number;
    failureCount: number;
    activeNow: number;
    successRate: number | null;
  };
  dashboards: Array<{ id: number; title: string; starred: boolean; updatedAt: string | null }>;
  recentQuestions: Array<{ id: number; title: string | null; lastMessageAt: string | null }>;
  alerts: Array<{ id: number; severity: string; message: string; kind: string; createdAt: string | null }>;
}

export default function HomePage() {
  const router = useRouter();
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [userName, setUserName] = useState<string>('');
  const [freshnessOpen, setFreshnessOpen] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.get('/home/summary');
      setSummary(res.data.data as HomeSummary);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('home/summary failed', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh on tab focus so the user always sees current state
  useEffect(() => {
    const onFocus = () => { setRefreshing(true); void load(true); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Greet by display name (cached on the auth profile)
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

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted" />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        Could not load home page.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-bg">
      <div className="max-w-6xl mx-auto px-6 pt-10 pb-12">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <p className="text-[11px] font-mono tracking-[0.14em] uppercase text-muted mb-1">{today}</p>
            <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
              {userName ? `Welcome back, ${userName}` : 'Welcome back'}
            </h1>
          </div>
          <button
            onClick={() => { setRefreshing(true); void load(true); }}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-ink-2 border border-line rounded-md hover:bg-softer disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} strokeWidth={2} />
            Refresh
          </button>
        </div>

        {/* HEALTH section */}
        <section className="mb-10">
          <HealthSection
            summary={summary}
            onJump={(path) => router.push(path)}
            onOpenFreshnessDetail={() => setFreshnessOpen(true)}
          />
        </section>

        {/* ATTENTION section */}
        <section className="mb-10">
          <AttentionSection summary={summary} onJump={(path) => router.push(path)} />
        </section>

        {/* PULSE — your watchlist that powers morning briefs + alerts.
            Sits between Attention (today's issues) and Act (today's
            tools) because it's the bridge: declaring what should
            generate tomorrow's attention items. */}
        <section className="mb-10">
          <PulsePanel />
        </section>

        {/* ACT section */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <DashboardsSection dashboards={summary.dashboards} onJump={(p) => router.push(p)} />
          <RecentQuestionsSection
            questions={summary.recentQuestions}
            onJump={(p) => router.push(p)}
          />
        </section>
      </div>

      {freshnessOpen && (
        <FreshnessDetail
          sources={summary.freshness.allSources}
          products={summary.freshness.allProducts}
          onClose={() => setFreshnessOpen(false)}
          onJumpToPipelines={() => { setFreshnessOpen(false); router.push('/pipelines'); }}
        />
      )}
    </div>
  );
}

// ─── Health section ─────────────────────────────────────────────────────────

function HealthSection({ summary, onJump, onOpenFreshnessDetail }: { summary: HomeSummary; onJump: (path: string) => void; onOpenFreshnessDetail: () => void }) {
  const overall = summary.health.overall;
  const ringColor = overall == null ? OBSERVATORY.muted2
    : overall >= 80 ? OBSERVATORY.ok
    : overall >= 50 ? OBSERVATORY.warn
    : OBSERVATORY.err;
  const tone = overall == null ? 'No data yet' : overall >= 90 ? 'Excellent'
    : overall >= 75 ? 'Healthy' : overall >= 50 ? 'OK' : overall >= 25 ? 'Needs work' : 'Critical';

  return (
    <div className="bg-raised border border-line rounded-lg p-6">
      <div className="flex items-baseline gap-2 mb-4">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Data health</p>
        <p className="text-[11px] text-muted-2">— a quick measure of fresh data + curated definitions + clean pipeline runs</p>
      </div>
      <div className="flex flex-col lg:flex-row items-stretch gap-6">
        {/* Big ring */}
        <div className="flex items-center gap-5 lg:min-w-[220px]">
          <ScoreRing value={overall} color={ringColor} />
          <div>
            <p className="font-display text-[28px] text-ink leading-none tracking-[-0.02em]">{tone}</p>
            <p className="text-[12px] text-muted mt-1">
              {overall == null
                ? 'Connect a source to start scoring.'
                : overall >= 80
                  ? "You're in a good spot. Keep schedules running."
                  : 'Tackle the lowest sub-score first.'}
            </p>
          </div>
        </div>

        {/* Sub-score tiles */}
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SubScoreTile
            label="Freshness"
            score={summary.health.freshness}
            description={`${summary.freshness.sources.fresh}/${summary.freshness.sources.total} sources synced today, ${summary.freshness.products.fresh}/${summary.freshness.products.total} products refreshed`}
            icon={<RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />}
            // Open the freshness detail panel instead of jumping straight
            // to /pipelines. Users want to SEE which items are stale and
            // when they were last refreshed before deciding what to act on.
            onClick={onOpenFreshnessDetail}
          />
          <SubScoreTile
            label="Definitions"
            score={summary.health.definitions}
            description={`${summary.definitions.tables.defined}/${summary.definitions.tables.total} tables · ${summary.definitions.columns.defined}/${summary.definitions.columns.total} columns · ${summary.definitions.relationships.approved}/${summary.definitions.relationships.total} relationships`}
            icon={<ShieldCheck className="w-3.5 h-3.5" strokeWidth={2} />}
            onClick={() => onJump('/review')}
          />
          <SubScoreTile
            label="Pipelines"
            score={summary.health.pipelines}
            description={`${summary.pipelines.successCount}/${summary.pipelines.runsThisWeek} successful this week${summary.pipelines.activeNow > 0 ? ` · ${summary.pipelines.activeNow} running now` : ''}`}
            icon={<BarChart3 className="w-3.5 h-3.5" strokeWidth={2} />}
            onClick={() => onJump('/pipelines')}
          />
        </div>
      </div>
    </div>
  );
}

function ScoreRing({ value, color }: { value: number | null; color: string }) {
  const v = value ?? 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const offset = c - (v / 100) * c;
  return (
    <svg width={104} height={104} className="shrink-0">
      <circle cx={52} cy={52} r={r} stroke={OBSERVATORY.softer} strokeWidth={8} fill="none" />
      {value != null && (
        <circle
          cx={52} cy={52} r={r}
          stroke={color} strokeWidth={8} fill="none"
          strokeDasharray={c} strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 52 52)"
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
      )}
      <text
        x={52} y={56}
        textAnchor="middle"
        className="font-display tabular-nums"
        style={{ fontSize: 26, fill: OBSERVATORY.ink, letterSpacing: '-0.02em' }}
      >
        {value == null ? '—' : value}
      </text>
    </svg>
  );
}

function SubScoreTile({
  label, score, description, icon, onClick,
}: {
  label: string;
  score: number | null;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  const color = score == null ? OBSERVATORY.muted2
    : score >= 80 ? OBSERVATORY.ok
    : score >= 50 ? OBSERVATORY.warn
    : OBSERVATORY.err;
  return (
    <button
      onClick={onClick}
      className="bg-soft border border-line rounded-md px-3.5 py-3 text-left hover:border-line-strong hover:bg-softer transition-colors group"
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted inline-flex items-center gap-1.5">
          <span style={{ color }}>{icon}</span>
          {label}
        </p>
        <ChevronRight className="w-3 h-3 text-muted-2 group-hover:text-ink-2" strokeWidth={2} />
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <p className="font-display tabular-nums text-[22px] leading-none tracking-[-0.02em]" style={{ color: OBSERVATORY.ink }}>
          {score == null ? '—' : score}
        </p>
        {score != null && <span className="text-[11px] text-muted-2">/ 100</span>}
        <div className="ml-auto h-1.5 w-16 bg-softer rounded-full overflow-hidden">
          <div
            className="h-full transition-[width]"
            style={{ width: `${score ?? 0}%`, background: color, transitionDuration: '600ms' }}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted leading-relaxed">{description}</p>
    </button>
  );
}

// ─── Attention section ──────────────────────────────────────────────────────

function AttentionSection({ summary, onJump }: { summary: HomeSummary; onJump: (path: string) => void }) {
  type Item = {
    key: string;
    icon: React.ReactNode;
    color: string;
    title: string;
    description: string;
    action?: { label: string; path: string };
  };

  const items: Item[] = [];

  // Failed pipeline runs (last week)
  if (summary.pipelines.failureCount > 0) {
    items.push({
      key: 'failed-runs',
      icon: <AlertTriangle className="w-4 h-4" strokeWidth={1.75} />,
      color: OBSERVATORY.err,
      title: `${summary.pipelines.failureCount} pipeline run${summary.pipelines.failureCount === 1 ? '' : 's'} failed this week`,
      description: 'Investigate which products / tables had errors and re-run.',
      action: { label: 'Open pipelines', path: '/pipelines' },
    });
  }

  // Active runs in progress
  if (summary.pipelines.activeNow > 0) {
    items.push({
      key: 'active-runs',
      icon: <Loader2 className="w-4 h-4 animate-spin" />,
      color: OBSERVATORY.ocean,
      title: `${summary.pipelines.activeNow} pipeline run${summary.pipelines.activeNow === 1 ? '' : 's'} in progress`,
      description: 'Watch live progress on the canvas.',
      action: { label: 'Open pipelines', path: '/pipelines' },
    });
  }

  // Stale sources + products combined into one item — same action ("refresh
  // these"), and the user's mental model is "stale data" not "stale source
  // vs stale product". Click-through to /pipelines is the same destination.
  const stalePieces: string[] = [];
  if (summary.freshness.stale.length > 0) {
    stalePieces.push(`${summary.freshness.stale.length} source${summary.freshness.stale.length === 1 ? '' : 's'}`);
  }
  if (summary.freshness.staleProducts.length > 0) {
    stalePieces.push(`${summary.freshness.staleProducts.length} product${summary.freshness.staleProducts.length === 1 ? '' : 's'}`);
  }
  if (stalePieces.length > 0) {
    const names = [
      ...summary.freshness.stale.map((s) => s.name),
      ...summary.freshness.staleProducts.map((p) => p.name),
    ];
    items.push({
      key: 'stale-data',
      icon: <Clock className="w-4 h-4" strokeWidth={1.75} />,
      color: OBSERVATORY.warn,
      title: `${stalePieces.join(' and ')} not refreshed in 24h`,
      description: names.slice(0, 3).join(', ')
        + (names.length > 3 ? ` + ${names.length - 3} more` : ''),
      action: { label: 'Refresh now', path: '/pipelines' },
    });
  }

  // Pending AI review
  if (summary.definitions.pendingReview.total > 0) {
    items.push({
      key: 'pending-review',
      icon: <Sparkles className="w-4 h-4" strokeWidth={1.75} />,
      color: OBSERVATORY.ai,
      title: `${summary.definitions.pendingReview.total} AI suggestion${summary.definitions.pendingReview.total === 1 ? '' : 's'} pending review`,
      description: `${summary.definitions.pendingReview.tables} tables · ${summary.definitions.pendingReview.columns} columns · ${summary.definitions.pendingReview.relationships} relationships. Confirm or flag to improve query accuracy.`,
      action: { label: 'Review queue', path: '/review' },
    });
  }

  // Quality alerts (sorted critical first)
  for (const a of summary.alerts.slice(0, 5)) {
    const color = a.severity === 'critical' ? OBSERVATORY.err
      : a.severity === 'warning' ? OBSERVATORY.warn
      : OBSERVATORY.muted2;
    items.push({
      key: `alert-${a.id}`,
      icon: <AlertTriangle className="w-4 h-4" strokeWidth={1.75} />,
      color,
      title: a.message,
      description: a.createdAt ? `Detected ${formatRelative(a.createdAt)}` : '',
    });
  }

  if (items.length === 0) {
    return (
      <div className="bg-raised border border-line rounded-lg p-6 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: OBSERVATORY.ok }} strokeWidth={1.75} />
        <div>
          <p className="font-display text-[16px] text-ink leading-tight">All clear.</p>
          <p className="text-[12px] text-muted">No alerts, no failed runs, nothing pending review. Keep going.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line bg-softer/40">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Worth your attention</p>
      </header>
      <div className="divide-y divide-line">
        {items.map((item) => (
          <div key={item.key} className="px-5 py-3 flex items-start gap-3">
            <span className="mt-0.5 shrink-0" style={{ color: item.color }}>{item.icon}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-ink leading-tight">{item.title}</p>
              {item.description && (
                <p className="text-[11.5px] text-muted mt-0.5 leading-relaxed">{item.description}</p>
              )}
            </div>
            {item.action && (
              <button
                onClick={() => onJump(item.action!.path)}
                className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-medium text-ocean border border-ocean/30 rounded-md hover:bg-ocean-softer transition-colors"
              >
                {item.action.label} <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Pinned dashboards ─────────────────────────────────────────────────────

function DashboardsSection({
  dashboards, onJump,
}: {
  dashboards: HomeSummary['dashboards'];
  onJump: (path: string) => void;
}) {
  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line bg-softer/40 flex items-center justify-between">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Your dashboards</p>
        <button
          onClick={() => onJump('/dashboards')}
          className="text-[11px] font-mono tracking-[0.06em] uppercase text-ocean hover:text-ocean-hover"
        >
          Open all
        </button>
      </header>
      <div className="px-5 py-4">
        {dashboards.length === 0 ? (
          <div className="text-center py-6">
            <BarChart3 className="w-6 h-6 mx-auto mb-2 text-muted-2" strokeWidth={1.5} />
            <p className="text-[13px] text-ink-2 mb-3">No dashboards yet</p>
            <button
              onClick={() => onJump('/dashboards')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
              Build a dashboard
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {dashboards.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => onJump(`/dashboards?id=${d.id}`)}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded hover:bg-softer transition-colors group text-left"
                >
                  {d.starred ? (
                    <Star className="w-3.5 h-3.5 shrink-0" fill={OBSERVATORY.warn} stroke={OBSERVATORY.warn} />
                  ) : (
                    <BarChart3 className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.75} />
                  )}
                  <span className="text-[13px] text-ink truncate flex-1">{d.title}</span>
                  {d.updatedAt && (
                    <span className="text-[10.5px] font-mono text-muted-2 shrink-0">
                      {formatRelative(d.updatedAt)}
                    </span>
                  )}
                  <ChevronRight className="w-3 h-3 text-muted-2 opacity-0 group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Recent questions ──────────────────────────────────────────────────────

function RecentQuestionsSection({
  questions, onJump,
}: {
  questions: HomeSummary['recentQuestions'];
  onJump: (path: string) => void;
}) {
  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <header className="px-5 py-3 border-b border-line bg-softer/40 flex items-center justify-between">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Recent questions</p>
        <button
          onClick={() => onJump('/query')}
          className="text-[11px] font-mono tracking-[0.06em] uppercase text-ocean hover:text-ocean-hover inline-flex items-center gap-1"
        >
          <Sparkles className="w-3 h-3" strokeWidth={2} /> Ask a new one
        </button>
      </header>
      <div className="px-5 py-4">
        {questions.length === 0 ? (
          <div className="text-center py-6">
            <Sparkles className="w-6 h-6 mx-auto mb-2 text-muted-2" strokeWidth={1.5} />
            <p className="text-[13px] text-ink-2 mb-3">No questions yet</p>
            <button
              onClick={() => onJump('/query')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
              Ask the AI
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {questions.map((q) => (
              <li key={q.id}>
                <button
                  onClick={() => onJump(`/query?conversationId=${q.id}`)}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded hover:bg-softer transition-colors group text-left"
                >
                  <Library className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.75} />
                  <span className="text-[13px] text-ink truncate flex-1">
                    {q.title || 'Untitled question'}
                  </span>
                  {q.lastMessageAt && (
                    <span className="text-[10.5px] font-mono text-muted-2 shrink-0">
                      {formatRelative(q.lastMessageAt)}
                    </span>
                  )}
                  <ChevronRight className="w-3 h-3 text-muted-2 opacity-0 group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Freshness detail slide-over ───────────────────────────────────────────
//
// Click the Freshness tile → see every source + product with its last
// refresh timestamp BEFORE deciding whether to jump to /pipelines.
// Stale items at top, fresh items below, same row template for both.
// "Refresh now" button at the bottom takes the user to /pipelines (where
// they pick the right scope) — we don't try to one-click refresh from here
// because that would bypass the pipeline-scope decision the user is here
// to make.

function FreshnessDetail({
  sources, products, onClose, onJumpToPipelines,
}: {
  sources: HomeSummary['freshness']['allSources'];
  products: HomeSummary['freshness']['allProducts'];
  onClose: () => void;
  onJumpToPipelines: () => void;
}) {
  // Stale first within each kind, then by oldest refresh
  const orderRows = <T extends { isStale: boolean; lastSyncedAt?: string | null; lastRefreshedAt?: string | null }>(rows: T[]): T[] => {
    return [...rows].sort((a, b) => {
      if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
      const aAt = (a.lastSyncedAt ?? a.lastRefreshedAt) ?? '';
      const bAt = (b.lastSyncedAt ?? b.lastRefreshedAt) ?? '';
      return aAt.localeCompare(bAt);
    });
  };
  const orderedSources = orderRows(sources);
  const orderedProducts = orderRows(products);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sourceCount = sources.length;
  const productCount = products.length;
  const staleSourceCount = sources.filter((s) => s.isStale).length;
  const staleProductCount = products.filter((p) => p.isStale).length;

  return (
    <div className="fixed inset-0 z-40 bg-ink/40 flex items-stretch justify-end" onClick={onClose}>
      <div
        className="bg-raised w-full max-w-[560px] h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-raised border-b border-line px-5 py-3 flex items-start gap-2">
          <Clock className="w-4 h-4 mt-0.5 shrink-0" style={{ color: OBSERVATORY.ocean }} strokeWidth={1.75} />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Freshness</p>
            <h2 className="font-display text-[18px] tracking-[-0.01em] text-ink">
              When was each thing last refreshed?
            </h2>
            <p className="text-[11.5px] text-muted-2 mt-0.5">
              {staleSourceCount + staleProductCount > 0
                ? `${staleSourceCount + staleProductCount} item${staleSourceCount + staleProductCount === 1 ? '' : 's'} not refreshed in the last 24 hours.`
                : 'Everything has been refreshed in the last 24 hours.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-soft text-muted-2 hover:text-ink-2"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-6">
          {/* Sources */}
          <section>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">
              Sources <span className="text-muted-2 normal-case ml-1">{sourceCount} total · {staleSourceCount} stale</span>
            </p>
            {sourceCount === 0 ? (
              <p className="text-[12px] text-muted italic">No sources connected yet.</p>
            ) : (
              <ul className="divide-y divide-line border border-line rounded-md overflow-hidden">
                {orderedSources.map((s) => (
                  <FreshnessRow
                    key={`s-${s.id}`}
                    name={s.name}
                    kind="source"
                    sub={s.connectorType ?? 'source'}
                    lastAt={s.lastSyncedAt}
                    isStale={s.isStale}
                    extra={s.lastSyncStatus}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Products */}
          <section>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">
              Datasets <span className="text-muted-2 normal-case ml-1">{productCount} total · {staleProductCount} stale</span>
            </p>
            {productCount === 0 ? (
              <p className="text-[12px] text-muted italic">No datasets yet.</p>
            ) : (
              <ul className="divide-y divide-line border border-line rounded-md overflow-hidden">
                {orderedProducts.map((p) => (
                  <FreshnessRow
                    key={`p-${p.id}`}
                    name={p.name}
                    kind="product"
                    sub={p.status}
                    lastAt={p.lastRefreshedAt}
                    isStale={p.isStale}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Action */}
          <button
            onClick={onJumpToPipelines}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" strokeWidth={2} />
            Open Refresh
          </button>
          <p className="text-[10.5px] text-muted-2 text-center -mt-2">
            Pick the scope (everything / one source / one dataset) and click <span className="font-medium">Run now</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

function FreshnessRow({
  name, kind, sub, lastAt, isStale, extra,
}: {
  name: string;
  kind: 'source' | 'product';
  sub: string;
  lastAt: string | null;
  isStale: boolean;
  extra?: string | null;
}) {
  const Icon = kind === 'source' ? Database : Boxes;
  const accent = kind === 'source' ? OBSERVATORY.ocean : OBSERVATORY.ai;
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2 mb-0.5">
        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} strokeWidth={1.75} />
        <span className="text-[12.5px] font-medium text-ink truncate">{name}</span>
        <span className={cn(
          'text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-line',
          kind === 'source' ? 'text-ocean bg-ocean-softer' : 'text-ai bg-ai-soft',
        )}>
          {sub}
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-mono shrink-0"
          style={{ color: isStale ? OBSERVATORY.warn : OBSERVATORY.muted2 }}
        >
          <Clock className="w-3 h-3" strokeWidth={1.5} />
          {lastAt ? formatRelative(lastAt) : 'never refreshed'}
          {isStale && lastAt && <span className="font-medium">· stale</span>}
        </span>
      </div>
      {extra && (
        <p className="text-[11px] text-muted-2 ml-6">{extra}</p>
      )}
    </li>
  );
}
