'use client';

/**
 * Subject builds — creating, rebuilding and re-keying the subjects of a
 * source, from inside the Catalog.
 *
 * Until 2026-09-26 this lived on its own page, /build. Owner, looking at it:
 * "Is there any use to still having the Build pane? I think everything is
 * done now through catalog, relations and definitions." Almost: four jobs
 * still lived only there, and they moved here rather than disappearing —
 *
 *   • create the subjects of a source that has none  → the catalog landing
 *   • upgrade the keys (only when some still renumber) → the catalog landing
 *   • rebuild the subjects of a source (retire-and-replace, warned)
 *                                                      → the source's ⋯ menu
 *   • hide / show a subject on the Subjects page       → the subject's ⋯ menu
 *
 * ("Ask about your subjects", the page's chat, is the catalog assistant now:
 * its proposal card has the same one button.)
 *
 * A build is a WORKSPACE-level event (one at a time per tenant, and it can
 * run for minutes on the server), so its state lives here, in one provider
 * mounted by the catalog page, and its panel shows at the top of the view
 * whatever is selected — start a rebuild from a source, go look at a table,
 * and the progress stays in sight. A build started anywhere else (another
 * tab, the coworker) is picked up the same way: on mount and on every kept
 * coworker change the provider asks the server whether one is running.
 *
 * Vocabulary: business words only — subject, shared data, question. The ONE
 * deliberate exception is the run panel's collapsed "Show the working",
 * which streams the designer's raw reasoning; it is curator-only (the
 * provider does nothing for a viewer) and labelled as technical.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Library, Loader2, X,
} from 'lucide-react';
import { ClarionMark } from '@/components/brand/ClarionMark';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { streamSSE } from '@/lib/sse';
import { useToast } from '@/components/ui/Toast';
import { iconForAnalytics } from '@/components/catalog/entityIcons';
import { cleanTopicName } from '@/components/products/helpers';
import { TOPICS_CHANGED_EVENT } from '@/lib/topicsChanged';
import { useRole, isAdminRole } from '@/lib/role';
import { useCoworkerChanged } from '@/lib/coworker/CoworkerProvider';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

// ─── Read model (GET /products/build-overview) ─────────────────────────────

export interface PlannedTopic {
  name: string;
  description: string;
  kind: 'analytics' | 'reference';
  sampleQuestions: string[];
  sharedData: string[];
}

export interface BuiltProduct {
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

export interface SourceOverview {
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
  /** How the built tables link (counts only): see backend services/keyHealth.ts. */
  keys: { toUpgrade: number; renumbering: number; rebuildInstead: number } | null;
}

export interface Overview {
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
export interface RunTopic {
  id: number;
  name: string;
  description: string;
  kind: 'analytics' | 'reference';
  tableCount: number;
  status: 'pending' | 'building' | 'ok' | 'partial' | 'error';
  note: string | null;
  errors: string[];
}

export interface BuildRun {
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

// ─── The provider ──────────────────────────────────────────────────────────

export interface SubjectBuilds {
  overview: Overview | null;
  loadError: boolean;
  run: BuildRun | null;
  /** A build (or key upgrade) is running on the server. */
  building: boolean;
  /** The optional "what do you most want to see?" per source. Never steers
      what gets built; it becomes the first question on the finish card. */
  intent: Record<number, string>;
  setIntent: (connectionId: number, value: string) => void;
  startBuild: (connectionId: number) => Promise<void>;
  startKeyUpgrade: (connectionId: number) => Promise<void>;
  /** Follow a build started elsewhere (the catalog assistant's proposal). */
  attach: (jobId: string, connectionId: number) => void;
  cancel: () => Promise<void>;
  dismissRun: () => void;
  /** Hide a subject from the Subjects page (it stays built) or show it back. */
  setHidden: (productId: number, hidden: boolean) => Promise<boolean>;
  reload: () => Promise<void>;
}

const SubjectBuildsContext = createContext<SubjectBuilds | null>(null);

/** Null for a viewer, or outside the catalog: callers render nothing then. */
export function useSubjectBuilds(): SubjectBuilds | null {
  return useContext(SubjectBuildsContext);
}

export function SubjectBuildsProvider({ enabled, onSubjectsChanged, children }: {
  /** Curators only — the build routes are admin+analyst. */
  enabled: boolean;
  /** Called when the set of subjects changed (a build finished, one hidden). */
  onSubjectsChanged?: () => void;
  children: React.ReactNode;
}) {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [run, setRun] = useState<BuildRun | null>(null);
  const [intent, setIntentMap] = useState<Record<number, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef<BuildRun | null>(null);
  runRef.current = run;
  const changedRef = useRef(onSubjectsChanged);
  changedRef.current = onSubjectsChanged;

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await api.get('/products/build-overview');
      setOverview(res.data?.data ?? { sources: [], unassignedProducts: [] });
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [enabled]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const subjectsChanged = useCallback(() => {
    try { window.dispatchEvent(new Event(TOPICS_CHANGED_EVENT)); } catch { /* noop */ }
    changedRef.current?.();
  }, []);

  const attachToJob = useCallback(async (jobId: string, connectionId: number) => {
    abortRef.current?.abort();
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
            // `friendly` text, fall back to the technical one.
            setRun((r) => (r ? { ...r, phase: String(e.friendly ?? e.text ?? '') } : r));
          } else if (type === 'thinking') {
            // Thinking ONLY — `diag` events are API-streaming plumbing, and
            // rendering them made "the working" read like a debugger.
            setRun((r) => (r ? { ...r, working: (r.working + String(e.text ?? '')).slice(-WORKING_CAP) } : r));
          } else if (type === 'design_progress') {
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
            subjectsChanged();
            void load();
          } else if (type === 'failed' || type === 'error') {
            setRun((r) => (r ? { ...r, done: true, ok: false, phase: String(e.error ?? e.message ?? 'Build failed') } : r));
            subjectsChanged();
            void load();
          }
        },
      });
      // Stream can end without a terminal event (proxy cut) — treat a run
      // that never reported completion as "check the tree", not as success.
      setRun((r) => (r && !r.done ? { ...r, done: true, ok: false, phase: 'Connection to the build lost — check the tree whether your subjects appeared.' } : r));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setRun((r) => (r && !r.done ? { ...r, done: true, ok: false, phase: 'Connection to the build lost — check the tree whether your subjects appeared.' } : r));
      void load();
    }
  }, [load, subjectsChanged]);

  // Reattach: a build started earlier (another tab, the coworker) keeps
  // running on the server; the catalog must show it, not offer a second one.
  const reattach = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!enabled) return;
    try {
      const res = await api.get('/products/bus-matrix/active');
      const active = res.data?.data as { jobId?: string; connectionId?: number } | null;
      if (!isCancelled() && active?.jobId && active.connectionId && (!runRef.current || runRef.current.done)) {
        void attachToJob(active.jobId, active.connectionId);
      }
    } catch { /* no active job — fine */ }
  }, [enabled, attachToJob]);
  useEffect(() => {
    let cancelled = false;
    void reattach(() => cancelled);
    return () => { cancelled = true; };
  }, [reattach]);

  // A subject the coworker proposed and the person kept starts a build on
  // the server — follow it here, live, like one started with a button.
  const onCoworkerChanged = useCallback(() => { void load(); void reattach(); }, [load, reattach]);
  useCoworkerChanged(onCoworkerChanged);

  // Queue position: a build can queue behind another workspace's. While the
  // stream has not spoken yet, ask where the job stands and say it in words.
  useEffect(() => {
    if (!run || run.done) return;
    const waitingPhase = run.phase === 'Starting…' || run.phase.startsWith('Waiting for a build slot');
    if (!waitingPhase) return;
    const t = window.setInterval(async () => {
      try {
        const res = await api.get('/products/bus-matrix/active');
        const a = res.data?.data as { jobId?: string; state?: string; buildsAhead?: number | null } | null;
        const cur = runRef.current;
        if (!cur || cur.done || !a || a.jobId !== cur.jobId) return;
        if (a.state === 'waiting' || a.state === 'delayed') {
          const n = a.buildsAhead ?? 0;
          const msg = n > 0
            ? `Waiting for a build slot — ${n} build${n === 1 ? '' : 's'} ahead of you`
            : 'Waiting for a build slot…';
          setRun((r) => (
            r && !r.done && (r.phase === 'Starting…' || r.phase.startsWith('Waiting for a build slot'))
              ? { ...r, phase: msg }
              : r
          ));
        }
      } catch { /* position is a nicety — never surface an error for it */ }
    }, 8000);
    return () => window.clearInterval(t);
  }, [run]);

  const startJob = useCallback(async (path: string, connectionId: number, failure: string) => {
    try {
      const res = await api.post(path, { connectionId });
      const jobId = res.data?.data?.jobId as string | undefined;
      if (!jobId) throw new Error('No job id returned');
      await attachToJob(jobId, connectionId);
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; jobId?: string } }; message?: string };
      const existingJobId = ax?.response?.data?.jobId;
      if (existingJobId) { void attachToJob(existingJobId, connectionId); return; }
      toast.error(failure, { description: ax?.response?.data?.error ?? ax?.message ?? 'Unknown error' });
    }
  }, [attachToJob, toast]);

  const startBuild = useCallback(
    (connectionId: number) => startJob('/products/bus-matrix/start', connectionId, 'Could not start the build'),
    [startJob],
  );
  // Upgrade keys: rewrite how every table of the source links to its lookups
  // (stable integer keys) and rebuild them together, in one job on the same
  // queue — so this panel, cancel and reattach work unchanged.
  const startKeyUpgrade = useCallback(
    (connectionId: number) => startJob('/products/keys/upgrade-start', connectionId, 'Could not upgrade the keys'),
    [startJob],
  );

  const cancel = useCallback(async () => {
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

  const setHidden = useCallback(async (productId: number, hidden: boolean) => {
    try {
      await api.put(`/products/${productId}`, { hidden });
      subjectsChanged();
      void load();
      return true;
    } catch {
      toast.error(`Could not ${hidden ? 'hide' : 'show'} the subject`);
      return false;
    }
  }, [load, subjectsChanged, toast]);

  const value = useMemo<SubjectBuilds | null>(() => (enabled ? {
    overview,
    loadError,
    run,
    building: run !== null && !run.done,
    intent,
    setIntent: (connectionId, v) => setIntentMap((m) => ({ ...m, [connectionId]: v })),
    startBuild,
    startKeyUpgrade,
    attach: (jobId, connectionId) => { void attachToJob(jobId, connectionId); },
    cancel,
    dismissRun: () => setRun(null),
    setHidden,
    reload: load,
  } : null), [enabled, overview, loadError, run, intent, startBuild, startKeyUpgrade, attachToJob, cancel, setHidden, load]);

  return <SubjectBuildsContext.Provider value={value}>{children}</SubjectBuildsContext.Provider>;
}

/**
 * The build as it happens, then its outcome — at the top of the catalog's
 * view whatever is selected. Renders nothing when no build is in sight.
 */
export function SubjectBuildStrip() {
  const b = useSubjectBuilds();
  if (!b?.run) return null;
  const src = b.overview?.sources.find((s) => s.id === b.run!.connectionId);
  return (
    <div className="shrink-0 border-b border-line bg-soft px-6 pt-4 pb-1 max-h-[45vh] overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        <RunPanel
          sourceName={src?.name ?? 'your source'}
          run={b.run}
          intent={b.intent[b.run.connectionId] ?? ''}
          onCancel={() => void b.cancel()}
          onDismiss={b.dismissRun}
        />
      </div>
    </div>
  );
}

/**
 * Rebuild — separate and warned on purpose: retire-and-replace re-creates
 * the subjects, so edits made ON them (reworded questions, metric changes,
 * written summaries) are reset. Refreshing DATA is the subject's own Rebuild
 * or Refresh; this is only for redoing the structure.
 */
export function RebuildSubjectsConfirm({ sourceName, onConfirm, onCancel, disabled }: {
  sourceName: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-[10px] border border-line bg-warn-soft px-4 py-3">
      <p className="text-[13px] leading-[1.55] text-ink-2">
        Rebuilding replaces the subjects made from {sourceName} with a fresh version. Your data
        is safe, but <span className="font-medium">edits made on those subjects — reworded
        questions, changed metrics, written summaries — are reset.</span> To only bring in new
        data, rebuild a single subject or use Refresh instead.
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={disabled}
          className="rounded-[8px] bg-warn px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Rebuild the subjects
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[8px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-ink-3"
        >
          Keep everything as it is
        </button>
      </div>
      {disabled && <p className="mt-1.5 text-[11.5px] text-muted-2">A build is running — wait for it to finish.</p>}
    </div>
  );
}

// ─── Keys: how the built tables link to their lookups ─────────────────────

/**
 * Tables built before 2026-09-24 link to their lookups one of two older ways:
 * numbered per build (a lone rebuild of a lookup moves rows to the wrong
 * customer), or on the raw text id (safe, about twice as slow to join). One
 * upgrade moves every table of the source onto stable integer keys and
 * rebuilds them together. Admin only — it rebuilds every topic of the source.
 */
export function KeysPanel({ sourceName, keys, disabled, onUpgrade }: {
  sourceName: string;
  keys: NonNullable<SourceOverview['keys']>;
  disabled: boolean;
  onUpgrade: () => void;
}) {
  const role = useRole();
  const admin = isAdminRole(role);
  const [confirming, setConfirming] = useState(false);
  const urgent = keys.renumbering > 0;

  if (keys.toUpgrade === 0) {
    return (
      <p className="mt-3 rounded-[10px] border border-line bg-raised px-4 py-3 text-[12.5px] leading-[1.55] text-ink-3">
        The subjects made from {sourceName} were built by an earlier version and have no stable keys
        yet. Rebuild them (the source&apos;s ⋯ menu) to move them onto stable keys — faster filters,
        and any table can then be rebuilt on its own.
      </p>
    );
  }

  return (
    <div className={cn('mt-3 rounded-[10px] border px-4 py-3', urgent ? 'border-warn bg-warn-soft' : 'border-line bg-raised')}>
      <p className="text-[13px] leading-[1.55] text-ink-2">
        {urgent ? (
          <>
            <span className="font-medium">{sourceName}: {keys.renumbering} {keys.renumbering === 1 ? 'lookup renumbers' : 'lookups renumber'} its keys on every build.</span>{' '}
            Rebuilding one of them on its own would attach rows to the wrong customer or product, so that is
            blocked until the keys are upgraded.
          </>
        ) : (
          <>
            {sourceName}: {keys.toUpgrade} {keys.toUpgrade === 1 ? 'table still links' : 'tables still link'} to its lookups on long text ids.
            Upgrading moves them onto stable integer keys — joins run about twice as fast on large tables.
          </>
        )}
      </p>
      {admin && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          className="mt-2 rounded-[8px] border border-line bg-raised px-3.5 py-1.5 text-[12.5px] font-medium text-ink hover:border-ocean hover:text-ocean disabled:opacity-40"
        >
          Upgrade keys…
        </button>
      )}
      {admin && confirming && (
        <div className="mt-2.5">
          <p className="text-[12.5px] leading-[1.55] text-ink-3">
            This rewrites how {keys.toUpgrade} {keys.toUpgrade === 1 ? 'table links' : 'tables link'} to each other,
            checks every change before saving anything, and rebuilds every subject of this source once. What the
            subjects contain does not change and dashboards keep working.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setConfirming(false); onUpgrade(); }}
              disabled={disabled}
              className="rounded-[8px] bg-ocean px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-ocean-hover disabled:opacity-40"
            >
              Upgrade keys
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-[8px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-ink-3"
            >
              Not now
            </button>
          </div>
        </div>
      )}
      {!admin && (
        <p className="mt-1.5 text-[12px] text-muted-2">An admin can upgrade the keys here.</p>
      )}
    </div>
  );
}

// ─── The plan: what a build would create, shown before it runs ─────────────

export function PlanPanel({ src, intent, onIntent, onBuild, disabled }: {
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
            {' '}{planTopics.length} subject{planTopics.length === 1 ? '' : 's'}:
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
            Everything in a subject can be asked about in Ask AI — the metrics are
            ready-made starting points, not the limit.
          </p>
          {sharedNames.length > 0 && (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-[1.55] text-muted">
              <Library className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={1.6} aria-hidden />
              <span>Plus the shared data every subject slices by: {sharedNames.join(', ')}.</span>
            </p>
          )}
        </>
      ) : (
        <p className="text-[14px] leading-[1.6] text-ink-2">
          There is no ready-made design for {src.name}, so Clarion&apos;s AI will work out
          the subjects from what it finds in your data. This takes a few minutes, and you
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
            <ClarionMark size={16} tone="mono" />
            Create the subjects
          </button>
          <p className="mt-1.5 text-[11.5px] text-muted-2">
            Runs on the server — you can keep working while it runs. Nothing changes in {src.name} itself.
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
 * After the run finishes the cards yield to the finish card: the real subjects
 * appear in the tree (it reloads on completion), so keeping both would
 * show every subject twice.
 */
function RunPanel({ sourceName, run, intent, onCancel, onDismiss }: {
  sourceName: string;
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
            {run.phase || 'Creating your subjects…'}
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
            {run.ok ? 'Your subjects are ready — they’re in the tree now.' : 'The build finished with problems.'}
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
        <button type="button" onClick={onDismiss} aria-label={`Dismiss build result for ${sourceName}`} className="shrink-0 text-muted-2 hover:text-ink-3">
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

