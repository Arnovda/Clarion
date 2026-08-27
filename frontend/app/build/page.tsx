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
 * ONE deliberate exception: the run panel's collapsed "Show the working"
 * disclosure streams the AI designer's raw reasoning (the `thinking` deltas
 * the orchestrator has always emitted and this page used to discard). That
 * text speaks warehouse vocabulary by nature; it is opt-in, labelled as
 * technical, and this page is admin+analyst-gated — never widen the page to
 * viewers while the disclosure exists.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Blocks, CheckCircle2, ChevronDown, ChevronRight,
  Eye, EyeOff, Library, Loader2, Sparkles, X,
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
import AskPanel from './AskPanel';

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
  /** Sum of rows across built tables. 0 = built but every table is empty
      ("waiting for data"); null = nothing materialised yet. */
  rowsTotal: number | null;
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

/**
 * A topic card in the run panel — born from the orchestrator's `designed`
 * event (so it has a real product id), flipped to `building` by
 * `product_start` and settled by the per-product `product` event. The whole
 * event history rides the job log, so a reattach mid-run replays it and
 * rebuilds these cards from scratch.
 */
interface RunTopic {
  id: number;
  name: string;
  description: string;
  kind: 'analytics' | 'reference';
  tableCount: number;
  status: 'pending' | 'building' | 'ok' | 'partial' | 'error';
  note: string | null;
  errors: string[];
}

interface BuildRun {
  connectionId: number;
  jobId: string | null;
  phase: string;
  topics: RunTopic[];
  /** The AI designer's raw reasoning stream — shown only behind the
      "Show the working" disclosure. Capped so a reattach replay of a long
      design cannot grow state without bound. */
  working: string;
  /** Errors not attributable to a specific topic (source-level failures). */
  errors: string[];
  done: boolean;
  ok: boolean;
}

const WORKING_CAP = 160_000;

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
    setRun({ connectionId, jobId, phase: 'Starting…', topics: [], working: '', errors: [], done: false, ok: false });
    try {
      await streamSSE(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
        method: 'GET',
        signal: controller.signal,
        onEvent: (raw) => {
          const e = raw as Record<string, unknown>;
          const type = e.type as string;
          if (type === 'phase') {
            // The headline speaks business language: prefer the orchestrator's
            // `friendly` text, fall back to the technical one (refresh-mode
            // jobs and older log replays carry no friendly variant).
            setRun((r) => (r ? { ...r, phase: String(e.friendly ?? e.text ?? '') } : r));
          } else if (type === 'thinking') {
            // Thinking ONLY — `diag` events are API-streaming plumbing
            // (content_block markers, byte counters) for the /products
            // workshop terminal, and rendering them here made "the working"
            // read like a debugger (owner screenshot, 2026-08-20).
            setRun((r) => (r ? { ...r, working: (r.working + String(e.text ?? '')).slice(-WORKING_CAP) } : r));
          } else if (type === 'design_progress') {
            // The design is being written: keep the headline alive with the
            // honest count instead of one frozen sentence for minutes.
            const n = Number(e.tablesDrafted ?? 0);
            if (n > 0) {
              setRun((r) => (r ? { ...r, phase: `Writing the design — ${n} table${n === 1 ? '' : 's'} drafted so far…` } : r));
            }
          } else if (type === 'designed') {
            const topics = (Array.isArray(e.topics) ? e.topics : []).map((t) => ({
              ...(t as Omit<RunTopic, 'status' | 'note' | 'errors'>),
              status: 'pending' as const,
              note: null,
              errors: [],
            }));
            setRun((r) => (r ? { ...r, topics } : r));
          } else if (type === 'product_start') {
            setRun((r) => {
              if (!r) return r;
              const topics = r.topics.map((t): RunTopic => (t.id === e.productId ? { ...t, status: 'building' } : t));
              const started = topics.filter((t) => t.status !== 'pending').length;
              const current = topics.find((t) => t.id === e.productId);
              const phase = current
                ? `Building “${current.kind === 'reference' ? 'Shared data' : cleanTopicName(current.name)}” (${started} of ${topics.length})…`
                : r.phase;
              return { ...r, topics, phase };
            });
          } else if (type === 'product') {
            const status: RunTopic['status'] =
              e.status === 'ok' ? 'ok' : e.status === 'partial' ? 'partial' : 'error';
            setRun((r) => (r ? {
              ...r,
              topics: r.topics.map((t): RunTopic => (t.id === e.productId ? { ...t, status, note: String(e.text ?? '') } : t)),
            } : r));
          } else if (type === 'error_detail') {
            setRun((r) => {
              if (!r) return r;
              const pid = typeof e.productId === 'number' ? e.productId : null;
              if (pid !== null && r.topics.some((t) => t.id === pid)) {
                return {
                  ...r,
                  topics: r.topics.map((t): RunTopic => (t.id === pid
                    ? { ...t, errors: [...t.errors, `${String(e.tableName)}: ${String(e.error)}`] }
                    : t)),
                };
              }
              return { ...r, errors: [...r.errors, `${String(e.tableName)}: ${String(e.error)}`] };
            });
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

        <AskPanel building={building} onAttach={(jobId, connId) => void attachToJob(jobId, connId)} />

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

      {run && <RunPanel src={src} run={run} intent={intent} onCancel={onCancel} onDismiss={onDismissRun} />}

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
                  {/* WHAT the topic contains leads; the ready-made metrics are
                      a supporting line. The metric names alone undersold the
                      build badly — EO ships 4 KPIs across all topics, while
                      Finance alone carries three full fact tables. */}
                  {t.description && (
                    <p className="mt-1.5 text-[12px] leading-[1.5] text-ink-3">{t.description}</p>
                  )}
                  {t.sampleQuestions.length > 0 && (
                    <p className="mt-1 text-[11.5px] leading-[1.5] text-muted">
                      Ready-made metrics: {t.sampleQuestions.join(' · ')}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2.5 text-[12px] leading-[1.5] text-muted">
            Everything in a topic can be asked about in Ask AI — the metrics are
            ready-made starting points, not the limit.
          </p>
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

/**
 * The run panel is three stacked layers, each earning its place:
 *   1. the headline strip — one friendly sentence + cancel (the old strip);
 *   2. topic cards that materialize the moment the design lands (`designed`)
 *      and flip pending → building → ready as the build works through them —
 *      progress shown as OUTCOMES arriving, not as log text;
 *   3. "Show the working" — a collapsed disclosure streaming the AI
 *      designer's raw reasoning, for the analyst who wants to watch along.
 * After the run finishes the cards yield to the finish card: the real topic
 * rows render right below from the reloaded overview, so keeping both would
 * show every topic twice.
 */
function RunPanel({ src, run, intent, onCancel, onDismiss }: {
  src: SourceOverview;
  run: BuildRun;
  intent: string;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const [showWorking, setShowWorking] = useState(false);
  const workingRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (showWorking && workingRef.current) workingRef.current.scrollTop = workingRef.current.scrollHeight;
  }, [run.working, showWorking]);

  if (!run.done) {
    return (
      <div className="mb-3 rounded-[10px] border border-line bg-raised">
        <div className="flex items-center gap-3 px-4 py-3">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ocean" strokeWidth={2} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">
            {run.phase || 'Creating your topics…'}
          </span>
          <button type="button" onClick={onCancel} className="shrink-0 text-[12px] text-muted-2 hover:text-ink-3 hover:underline">
            Cancel
          </button>
        </div>

        {run.topics.length > 0 && (
          <div className="grid gap-2.5 border-t border-line px-4 py-3.5 sm:grid-cols-2">
            {run.topics.map((t) => <RunTopicCard key={t.id} topic={t} />)}
          </div>
        )}

        {run.working.length > 0 && (
          <div className="border-t border-line px-4 py-2.5">
            <button
              type="button"
              onClick={() => setShowWorking((v) => !v)}
              aria-expanded={showWorking}
              className="flex items-center gap-1.5 text-[12px] text-muted-2 hover:text-ink-3"
            >
              {showWorking
                ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                : <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />}
              {showWorking ? 'Hide the working' : 'Show the working'}
              <span className="relative flex h-1.5 w-1.5" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ocean opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ocean" />
              </span>
            </button>
            {showWorking && (
              <>
                <p className="mt-1.5 text-[11.5px] text-muted-2">
                  Clarion&apos;s raw reasoning as it designs — technical vocabulary ahead.
                </p>
                <pre
                  ref={workingRef}
                  className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-[8px] border border-line bg-bg px-3 py-2.5 font-mono text-[11px] leading-[1.65] text-ink-3"
                >
                  {run.working}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  const question = intent.trim();
  const allErrors = [
    ...run.errors,
    ...run.topics.flatMap((t) => t.errors.map((e) => `${cleanTopicName(t.name)} — ${e}`)),
  ];
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
          {allErrors.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {allErrors.slice(0, 5).map((e, i) => (
                <li key={i} className="text-[12px] text-err">✗ {e}</li>
              ))}
            </ul>
          )}
          {run.ok && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <a
                href={question ? `/query?q=${encodeURIComponent(question)}&autoSubmit=1` : '/query'}
                className="inline-flex items-center gap-1.5 rounded-[8px] bg-ocean px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
              >
                {question ? <>Ask: “{question}”</> : <>Ask your first question</>}
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              </a>
              <a
                href="/subjects"
                className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ocean hover:underline"
              >
                See your subjects →
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

// ─── A topic being built (run panel card) ──────────────────────────────────

function RunTopicCard({ topic }: { topic: RunTopic }) {
  const isRef = topic.kind === 'reference';
  const Glyph = isRef ? Library : iconForAnalytics(topic.name);
  // Reference products render as "Shared data" — the page's name for the
  // lookups, matching the built row they become after the run.
  const name = isRef ? 'Shared data' : cleanTopicName(topic.name);
  return (
    <div className="rounded-[10px] border border-line bg-bg px-4 py-3">
      <div className="flex items-center gap-2">
        <Glyph className="h-4 w-4 shrink-0 text-ocean" strokeWidth={1.6} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{name}</span>
        <RunTopicStatus topic={topic} />
      </div>
      {topic.description && (
        <p className="mt-1.5 text-[12px] leading-[1.5] text-ink-3">{topic.description}</p>
      )}
      {topic.errors.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {topic.errors.slice(0, 3).map((e, i) => (
            <li key={i} className="text-[11.5px] text-err">✗ {e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunTopicStatus({ topic }: { topic: RunTopic }) {
  switch (topic.status) {
    case 'building':
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ocean">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
          building…
        </span>
      );
    case 'ok':
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ok">
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
          ready
        </span>
      );
    case 'partial':
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-warn">
          <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
          {topic.note || 'built with problems'}
        </span>
      );
    case 'error':
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-err" title={topic.note ?? undefined}>
          <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
          failed
        </span>
      );
    default:
      return <span className="shrink-0 text-[11.5px] text-muted-2">waiting</span>;
  }
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
        {/* A built topic whose tables all hold zero rows is "waiting for
            data", not "refreshed just now" — the structure exists and the
            next refresh that finds data fills it. */}
        {!product.lastRefreshedAt
          ? 'not built yet'
          : product.rowsTotal === 0
            ? 'built — waiting for data from your source'
            : `refreshed ${formatRelativeLong(product.lastRefreshedAt)}`}
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
