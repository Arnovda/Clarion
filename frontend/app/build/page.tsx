'use client';

/**
 * /build — where a source becomes topics.
 *
 * The tenant-level front door to the bus-matrix flow (the coverage checklist
 * of docs/backlog/warehouse-value-for-smb.md §2.1b, given a home). Studio,
 * analyst+. One list, three kinds of row per source:
 *
 *   1. BUILT      — the topics that exist, each with a show/hide toggle.
 *                   Hiding is the topic selection: everything the template
 *                   can build gets built, visibility is the per-tenant choice
 *                   (activation, not determination).
 *   2. POSSIBLE   — the topics the connector's template would create from
 *                   the synced tables, shown BEFORE building so the promise
 *                   is exactly what the build produces. One button.
 *   3. BLOCKED    — nothing synced yet → points at Sources.
 *
 * Deliberately a list with one button, not a second workshop: everything
 * about a topic's CONTENT (tables, metrics, quality) lives in the topic's
 * own Manage mode; refreshing lives on Refresh. This page manages whether
 * things EXIST. Rebuild is a separate, warned action because it resets
 * product-level edits (retire-and-replace re-creates the products).
 *
 * Vocabulary: business words only — topic, shared data, question. The words
 * fact/dimension/star schema/data product must not appear on this screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Blocks, CheckCircle2, Eye, EyeOff, Library, Loader2, Sparkles, X,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import RequireRole from '@/components/RequireRole';
import { streamSSE } from '@/lib/sse';
import { useToast } from '@/components/ui/Toast';
import { formatRelativeLong } from '@/lib/dates';
import { iconForAnalytics } from '@/components/catalog/entityIcons';
import { cleanTopicName } from '@/app/products/helpers';
import { TOPICS_CHANGED_EVENT } from '@/lib/topicsChanged';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

// ─── Read model (GET /products/build-overview) ─────────────────────────────

interface PlannedTopic {
  name: string;
  description: string;
  kind: 'analytics' | 'reference';
  sampleQuestions: string[];
  sharedData: string[];
}

interface BuiltProduct {
  id: number;
  name: string;
  description: string | null;
  kind: 'analytics' | 'reference';
  status: string | null;
  hidden: boolean;
  templateVersion: number | null;
  tableCount: number;
  lastRefreshedAt: string | null;
}

interface SourceOverview {
  id: number;
  name: string;
  type: string;
  connectorType: string | null;
  profilingStatus: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  tableCount: number;
  hasTemplate: boolean;
  plan: { templateVersion: number; topics: PlannedTopic[] } | null;
  products: BuiltProduct[];
}

interface Overview {
  sources: SourceOverview[];
  unassignedProducts: BuiltProduct[];
}

// ─── Build run state ───────────────────────────────────────────────────────

interface BuildRun {
  connectionId: number;
  jobId: string | null;
  phase: string;
  errors: string[];
  done: boolean;
  ok: boolean;
}

export default function BuildPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <Build />
    </RequireRole>
  );
}

function Build() {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<BuildRun | null>(null);
  // The optional intent — what the user most wants to see. Never steers what
  // gets built (the template is deterministic on purpose); it becomes the
  // first Ask AI question on the finish card, so the loop closes on THEIR
  // words instead of on our output.
  const [intent, setIntent] = useState<Record<number, string>>({});
  const [confirmRebuild, setConfirmRebuild] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef<BuildRun | null>(null);
  runRef.current = run;

  const load = useCallback(async () => {
    try {
      const res = await api.get('/products/build-overview');
      setOverview(res.data?.data ?? { sources: [], unassignedProducts: [] });
    } catch {
      setError('Could not load your sources.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const notifyRail = useCallback(() => {
    try { window.dispatchEvent(new Event(TOPICS_CHANGED_EVENT)); } catch { /* noop */ }
  }, []);

  const attachToJob = useCallback(async (jobId: string, connectionId: number) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ connectionId, jobId, phase: 'Starting…', errors: [], done: false, ok: false });
    try {
      await streamSSE(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
        method: 'GET',
        signal: controller.signal,
        onEvent: (raw) => {
          const e = raw as Record<string, unknown>;
          const type = e.type as string;
          if (type === 'phase' || type === 'log') {
            setRun((r) => (r ? { ...r, phase: String(e.text ?? '') } : r));
          } else if (type === 'error_detail') {
            setRun((r) => (r ? { ...r, errors: [...r.errors, `${String(e.tableName)}: ${String(e.error)}`] } : r));
          } else if (type === 'completed') {
            const result = e.result as { allOk?: boolean } | null;
            setRun((r) => (r ? { ...r, done: true, ok: result?.allOk !== false } : r));
            notifyRail();
            void load();
          } else if (type === 'failed' || type === 'error') {
            setRun((r) => (r ? { ...r, done: true, ok: false, phase: String(e.error ?? e.message ?? 'Build failed') } : r));
            void load();
          }
        },
      });
      // Stream can end without a terminal event (proxy cut) — treat a run
      // that never reported completion as "check the list", not as success.
      setRun((r) => (r && !r.done ? { ...r, done: true, ok: false, phase: 'Connection to the build lost — check below whether your topics appeared.' } : r));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setRun((r) => (r && !r.done ? { ...r, done: true, ok: false, phase: 'Connection to the build lost — check below whether your topics appeared.' } : r));
      void load();
    }
  }, [load, notifyRail]);

  // Reattach: a build started earlier (or in another tab) keeps running on
  // the server; landing here mid-run must show it, not offer a second one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/products/bus-matrix/active');
        const active = res.data?.data as { jobId?: string; connectionId?: number } | null;
        if (!cancelled && active?.jobId && active.connectionId && !runRef.current) {
          void attachToJob(active.jobId, active.connectionId);
        }
      } catch { /* no active job — fine */ }
    })();
    return () => { cancelled = true; };
  }, [attachToJob]);

  const startBuild = useCallback(async (connectionId: number) => {
    setConfirmRebuild(null);
    try {
      const res = await api.post('/products/bus-matrix/start', { connectionId });
      const jobId = res.data?.data?.jobId as string | undefined;
      if (!jobId) throw new Error('No job id returned');
      await attachToJob(jobId, connectionId);
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; jobId?: string } }; message?: string };
      const existingJobId = ax?.response?.data?.jobId;
      if (existingJobId) { void attachToJob(existingJobId, connectionId); return; }
      toast.error('Could not start the build', { description: ax?.response?.data?.error ?? ax?.message ?? 'Unknown error' });
    }
  }, [attachToJob, toast]);

  const cancelBuild = useCallback(async () => {
    const jobId = runRef.current?.jobId;
    if (!jobId) return;
    try {
      await api.post(`/products/bus-matrix/${jobId}/cancel`);
      abortRef.current?.abort();
      setRun(null);
      void load();
    } catch {
      toast.error('Could not cancel the build');
    }
  }, [load, toast]);

  const toggleHidden = useCallback(async (product: BuiltProduct) => {
    const next = !product.hidden;
    // Optimistic — the whole point of the toggle is that it feels free.
    setOverview((o) => o && ({
      ...o,
      sources: o.sources.map((s) => ({
        ...s,
        products: s.products.map((p) => (p.id === product.id ? { ...p, hidden: next } : p)),
      })),
      unassignedProducts: o.unassignedProducts.map((p) => (p.id === product.id ? { ...p, hidden: next } : p)),
    }));
    try {
      await api.put(`/products/${product.id}`, { hidden: next });
      notifyRail();
    } catch {
      toast.error(`Could not ${next ? 'hide' : 'show'} ${cleanTopicName(product.name)}`);
      void load();
    }
  }, [load, notifyRail, toast]);

  const building = run !== null && !run.done;

  return (
    <div className="flex-1 overflow-y-auto px-10 pb-10 pt-10">
      <div className="mx-auto max-w-[880px]">
        <header className="mb-8 flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-ocean-softer text-ocean">
            <Blocks className="h-[22px] w-[22px]" strokeWidth={1.6} aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-ink">Build</h1>
            <p className="mt-1 max-w-[560px] text-[14.5px] leading-[1.6] text-ink-3 [text-wrap:pretty]">
              Turn what your sources contain into topics — the subject areas your team
              asks questions about. Hiding a topic keeps it built; showing it back is instant.
            </p>
          </div>
        </header>

        {error && <p className="text-[13px] text-err">{error}</p>}

        {!overview && !error && (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
            Loading…
          </div>
        )}

        {overview && overview.sources.length === 0 && (
          <div className="rounded-[10px] border border-line bg-raised px-6 py-8 text-center">
            <p className="text-[14px] text-ink-2">No sources connected yet.</p>
            <p className="mt-1 text-[13px] text-muted">Topics are built from a connected source — start there.</p>
            <a href="/sources" className="mt-4 inline-flex items-center gap-1.5 rounded-[8px] bg-ocean px-4 py-2 text-[13px] font-medium text-white hover:opacity-90">
              Connect a source <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </a>
          </div>
        )}

        {overview?.sources.map((src) => (
          <SourceSection
            key={src.id}
            src={src}
            run={run?.connectionId === src.id ? run : null}
            anyBuilding={building}
            intent={intent[src.id] ?? ''}
            onIntent={(v) => setIntent((m) => ({ ...m, [src.id]: v }))}
            confirmingRebuild={confirmRebuild === src.id}
            onConfirmRebuild={(open) => setConfirmRebuild(open ? src.id : null)}
            onBuild={() => void startBuild(src.id)}
            onCancel={() => void cancelBuild()}
            onDismissRun={() => setRun(null)}
            onToggleHidden={(p) => void toggleHidden(p)}
          />
        ))}

        {overview && overview.unassignedProducts.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
              Source removed
            </h2>
            <div className="flex flex-col gap-2">
              {overview.unassignedProducts.map((p) => (
                <TopicRow key={p.id} product={p} onToggleHidden={(x) => void toggleHidden(x)} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── Per-source section ────────────────────────────────────────────────────

function SourceSection({
  src, run, anyBuilding, intent, onIntent,
  confirmingRebuild, onConfirmRebuild, onBuild, onCancel, onDismissRun, onToggleHidden,
}: {
  src: SourceOverview;
  run: BuildRun | null;
  anyBuilding: boolean;
  intent: string;
  onIntent: (v: string) => void;
  confirmingRebuild: boolean;
  onConfirmRebuild: (open: boolean) => void;
  onBuild: () => void;
  onCancel: () => void;
  onDismissRun: () => void;
  onToggleHidden: (p: BuiltProduct) => void;
}) {
  const analytics = src.products.filter((p) => p.kind === 'analytics');
  const reference = src.products.filter((p) => p.kind === 'reference');
  const hasProducts = src.products.length > 0;
  const analysed = src.profilingStatus === 'done';

  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">{src.name}</h2>
        <span className="text-[11.5px] text-muted-2">
          {src.lastSyncedAt ? `synced ${formatRelativeLong(src.lastSyncedAt)}` : 'never synced'}
        </span>
        {src.tableCount > 0 && !analysed && (
          <a href="/sources" className="text-[11.5px] text-warn hover:underline">
            not analysed yet — Analyse first for richer descriptions →
          </a>
        )}
      </div>

      {run && <RunStrip src={src} run={run} intent={intent} onCancel={onCancel} onDismiss={onDismissRun} />}

      {hasProducts && (!run || run.done) && (
        <>
          <div className="flex flex-col gap-2">
            {analytics.map((p) => (
              <TopicRow key={p.id} product={p} onToggleHidden={onToggleHidden} />
            ))}
            {reference.map((p) => (
              <a
                key={p.id}
                href="/shared-data"
                className="group flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-3 transition-colors duration-1 ease-observatory hover:border-ocean"
              >
                <Library className="h-4 w-4 shrink-0 text-ocean" strokeWidth={1.6} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink group-hover:text-ocean">
                  Shared data
                </span>
                <span className="text-[11.5px] text-muted-2">the lookups every topic slices by</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
              </a>
            ))}
          </div>

          {/* Rebuild — separate and warned on purpose: retire-and-replace
              re-creates the products, so edits made ON them (reworded
              questions, metric changes) are reset. Refreshing DATA is the
              Refresh page; this is only for redoing the structure. */}
          {!confirmingRebuild ? (
            <button
              type="button"
              onClick={() => onConfirmRebuild(true)}
              disabled={anyBuilding}
              className="mt-3 text-[12px] text-muted-2 underline-offset-2 hover:text-ink-3 hover:underline disabled:opacity-40"
            >
              Rebuild the topics from this source…
            </button>
          ) : (
            <div className="mt-3 rounded-[10px] border border-line bg-warn-soft px-4 py-3">
              <p className="text-[13px] leading-[1.55] text-ink-2">
                Rebuilding replaces these topics with a fresh version. Your data is safe,
                but <span className="font-medium">edits made on the topics — reworded questions,
                changed metrics, written summaries — are reset.</span> To only bring in new
                data, use Refresh instead.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={onBuild}
                  className="rounded-[8px] bg-warn px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
                >
                  Rebuild topics
                </button>
                <button
                  type="button"
                  onClick={() => onConfirmRebuild(false)}
                  className="rounded-[8px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-ink-3"
                >
                  Keep everything as it is
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!hasProducts && !run && src.tableCount === 0 && (
        <div className="rounded-[10px] border border-line bg-raised px-5 py-4">
          <p className="text-[13.5px] text-ink-2">No data from {src.name} yet.</p>
          <a href="/sources" className="mt-1 inline-flex items-center gap-1 text-[13px] text-ocean hover:underline">
            Sync this source first <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </a>
        </div>
      )}

      {!hasProducts && !run && src.tableCount > 0 && (
        <PlanPanel src={src} intent={intent} onIntent={onIntent} onBuild={onBuild} disabled={anyBuilding} />
      )}
    </section>
  );
}

// ─── The plan: what a build would create, shown before it runs ─────────────

function PlanPanel({ src, intent, onIntent, onBuild, disabled }: {
  src: SourceOverview;
  intent: string;
  onIntent: (v: string) => void;
  onBuild: () => void;
  disabled: boolean;
}) {
  const planTopics = src.plan?.topics.filter((t) => t.kind === 'analytics') ?? [];
  const sharedNames = Array.from(new Set((src.plan?.topics ?? []).flatMap((t) => t.sharedData)));

  return (
    <div className="rounded-[12px] border border-line bg-raised px-6 py-5">
      {src.plan ? (
        <>
          <p className="text-[14px] leading-[1.6] text-ink-2">
            From <span className="font-medium text-ink">{src.name}</span> we can create
            {' '}{planTopics.length} topic{planTopics.length === 1 ? '' : 's'}:
          </p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {planTopics.map((t) => {
              const Glyph = iconForAnalytics(t.name);
              return (
                <div key={t.name} className="rounded-[10px] border border-line bg-bg px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Glyph className="h-4 w-4 shrink-0 text-ocean" strokeWidth={1.6} aria-hidden />
                    <span className="text-[13.5px] font-medium text-ink">{cleanTopicName(t.name)}</span>
                  </div>
                  {t.sampleQuestions.length > 0 && (
                    <p className="mt-1.5 text-[12px] leading-[1.5] text-muted">
                      You&apos;ll see: {t.sampleQuestions.join(' · ')}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {sharedNames.length > 0 && (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-[1.55] text-muted">
              <Library className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={1.6} aria-hidden />
              <span>Plus the shared data every topic slices by: {sharedNames.join(', ')}.</span>
            </p>
          )}
        </>
      ) : (
        <p className="text-[14px] leading-[1.6] text-ink-2">
          There is no ready-made design for {src.name}, so Clarion&apos;s AI will work out
          the topics from what it finds in your data. This takes a few minutes, and you
          can review everything it creates afterwards.
        </p>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <label htmlFor={`intent-${src.id}`} className="block text-[12.5px] font-medium text-ink-3">
          What do you most want to see? <span className="font-normal text-muted-2">(optional — becomes your first question)</span>
        </label>
        <input
          id={`intent-${src.id}`}
          type="text"
          value={intent}
          onChange={(e) => onIntent(e.target.value)}
          placeholder="e.g. Who pays me late?"
          className="mt-1.5 w-full max-w-[420px] rounded-[8px] border border-line bg-bg px-3 py-2 text-[13.5px] text-ink placeholder:text-muted-2 focus:border-ocean focus:outline-none"
        />
        <div className="mt-3.5">
          <button
            type="button"
            onClick={onBuild}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-[8px] bg-ocean px-4 py-2 text-[13.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            <Sparkles className="h-4 w-4" strokeWidth={1.8} aria-hidden />
            Create my topics
          </button>
          <p className="mt-1.5 text-[11.5px] text-muted-2">
            Runs on the server — safe to leave this page. Nothing changes in {src.name} itself.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Build progress + finish card ──────────────────────────────────────────

function RunStrip({ src, run, intent, onCancel, onDismiss }: {
  src: SourceOverview;
  run: BuildRun;
  intent: string;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (!run.done) {
    return (
      <div className="mb-3 flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ocean" strokeWidth={2} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">
          {run.phase || 'Creating your topics…'}
        </span>
        <button type="button" onClick={onCancel} className="shrink-0 text-[12px] text-muted-2 hover:text-ink-3 hover:underline">
          Cancel
        </button>
      </div>
    );
  }

  const question = intent.trim();
  return (
    <div className={cn(
      'mb-3 rounded-[10px] border border-line px-4 py-3.5',
      run.ok ? 'bg-ok-soft' : 'bg-warn-soft',
    )}>
      <div className="flex items-start gap-2.5">
        <CheckCircle2 className={cn('mt-[1px] h-4 w-4 shrink-0', run.ok ? 'text-ok' : 'text-warn')} strokeWidth={1.8} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink">
            {run.ok ? 'Your topics are ready — they’re in the sidebar now.' : 'The build finished with problems.'}
          </p>
          {!run.ok && run.phase && <p className="mt-0.5 text-[12.5px] text-ink-3">{run.phase}</p>}
          {run.errors.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {run.errors.slice(0, 5).map((e, i) => (
                <li key={i} className="text-[12px] text-err">✗ {e}</li>
              ))}
            </ul>
          )}
          {run.ok && (
            <div className="mt-2">
              <a
                href={question ? `/query?q=${encodeURIComponent(question)}&autoSubmit=1` : '/query'}
                className="inline-flex items-center gap-1.5 rounded-[8px] bg-ocean px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
              >
                {question ? <>Ask: “{question}”</> : <>Ask your first question</>}
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              </a>
            </div>
          )}
        </div>
        <button type="button" onClick={onDismiss} aria-label={`Dismiss build result for ${src.name}`} className="shrink-0 text-muted-2 hover:text-ink-3">
          <X className="h-4 w-4" strokeWidth={1.8} aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ─── A built topic ─────────────────────────────────────────────────────────

function TopicRow({ product, onToggleHidden }: {
  product: BuiltProduct;
  onToggleHidden: (p: BuiltProduct) => void;
}) {
  const Glyph = iconForAnalytics(product.name);
  const name = cleanTopicName(product.name);
  return (
    <div className={cn(
      'group flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-3 transition-opacity',
      product.hidden && 'opacity-55',
    )}>
      <Glyph className="h-4 w-4 shrink-0 text-ocean" strokeWidth={1.6} aria-hidden />
      <a href={`/topics/${product.id}`} className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink hover:text-ocean">
        {name}
      </a>
      <span className="hidden shrink-0 text-[11.5px] text-muted-2 sm:inline">
        {product.lastRefreshedAt
          ? `refreshed ${formatRelativeLong(product.lastRefreshedAt)}`
          : 'not built yet'}
      </span>
      <button
        type="button"
        onClick={() => onToggleHidden(product)}
        title={product.hidden ? `Show ${name} in the sidebar` : `Hide ${name} from the sidebar (stays built)`}
        aria-label={product.hidden ? `Show ${name}` : `Hide ${name}`}
        className="shrink-0 rounded-[6px] p-1.5 text-muted-2 transition-colors hover:bg-softer hover:text-ink-3"
      >
        {product.hidden
          ? <EyeOff className="h-4 w-4" strokeWidth={1.7} aria-hidden />
          : <Eye className="h-4 w-4" strokeWidth={1.7} aria-hidden />}
      </button>
    </div>
  );
}
