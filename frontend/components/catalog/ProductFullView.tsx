'use client';

/**
 * <ProductFullView> — a SUBJECT's page in the catalog.
 *
 * ONE page per subject. The topic's Manage mode and the build workshop
 * overlapped with this page and sat behind doors nobody found (owner,
 * 2026-09-23: "merge the 2 in catalog"); both are retired, and what only
 * they had lives here now — Rebuild (with the source synced first, when
 * wanted), Delete, Add a table, editable metrics, the star diagram
 * (Relations), the lineage graph, the quality table and the refresh
 * history. Everything else they showed was already here.
 *
 * A subject is SOURCE-INDEPENDENT (owner, the same day): it is built from a
 * source but does not belong to one, so the header carries the subject's
 * glyph and no source mark; where the data comes from is the Lineage tab,
 * table by table.
 *
 * Roles: a viewer reads (overview, metrics, tables, joins as a list,
 * lineage as a sentence, quality); a curator also edits metrics, adds a
 * table and sees the diagrams; the whole-subject rebuild and delete are
 * admin, as their routes are. No SQL on this page — a table's SQL is on the
 * table's own page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, ArrowUpRight, BarChart3, Boxes, Check, Database, Eye, EyeOff, GitBranch, Loader2,
  Link2, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2, X,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/dates';
import { useRole, canCurate, isAdminRole } from '@/lib/role';
import { streamSSE } from '@/lib/sse';
import { useToast } from '@/components/ui/Toast';
import { PreviewTable } from '@/components/semantic/shared';
import { askAboutSubject } from '@/lib/askLink';
import type { FullDataProduct, ProductKpi } from '@/components/products/types';
import ExplorerHeader, { HeaderAction, MoreMenu } from './ExplorerHeader';
import SubjectRelations from './SubjectRelations';
import { iconForAnalytics } from './entityIcons';
import { useSubjectBuilds } from './subjectBuilds';
import type { CatalogNavTarget } from './navigation';

// The heavy tabs load when opened: the diagram (ReactFlow), the lineage
// graph, the metrics editor, the quality table, the history charts.
const LineageGraph = dynamic(() => import('./LineageGraph'), { ssr: false });
const KpiManager = dynamic(() => import('@/components/products/KpiManager'), { ssr: false });
const QualityTab = dynamic(() => import('@/components/products/QualityTab'), { ssr: false });
const RefreshHistoryChart = dynamic(() => import('@/components/products/RefreshHistoryChart'), { ssr: false });

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

type SubjectDetail = FullDataProduct & { last_refreshed_at?: string | null; hidden?: boolean | null };
type SubjectTable = FullDataProduct['star_schemas'][number]['tables'][number];

type Tab = 'overview' | 'metrics' | 'tables' | 'relations' | 'lineage' | 'quality' | 'history';

interface Props {
  productId: number;
  /** A breadcrumb or a table name: the page owns the selection. */
  onNavigate?: (target: CatalogNavTarget) => void;
  /** Something about the subject changed (a table added, a rebuild landed). */
  onChanged?: () => void;
  /** The subject was deleted; the page clears the selection. */
  onDeleted?: () => void;
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e.response?.data?.error ?? e.message ?? fallback;
}

export default function ProductFullView({ productId, onNavigate, onChanged, onDeleted }: Props) {
  const role = useRole();
  const curator = canCurate(role);
  const admin = isAdminRole(role);
  const toast = useToast();

  const [data, setData] = useState<SubjectDetail | null>(null);
  const [kpis, setKpis] = useState<ProductKpi[]>([]);
  const [aiStarters, setAiStarters] = useState<string[] | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const builds = useSubjectBuilds();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, kpiRes, starterRes] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/products/${productId}/kpis`).catch(() => ({ data: { data: [] } })),
        api.get(`/products/${productId}/starters`).catch(() => ({ data: { data: { starters: [] } } })),
      ]);
      setData((detailRes.data?.data ?? null) as SubjectDetail | null);
      setKpis((kpiRes.data?.data ?? []) as ProductKpi[]);
      const starters = (starterRes.data?.data?.starters ?? []) as Array<{ question: string }>;
      setAiStarters(starters.length > 0 ? starters.map((s) => s.question).slice(0, 3) : null);
    } catch {
      setData(null); setKpis([]); setAiStarters(null);
    } finally {
      setLoading(false);
    }
  }, [productId]);
  useEffect(() => { void load(); }, [load]);

  // A quiet reload after an edit — no skeleton over a page that is still there.
  const reload = useCallback(async () => {
    try {
      const [detailRes, kpiRes] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/products/${productId}/kpis`).catch(() => ({ data: { data: [] } })),
      ]);
      setData((detailRes.data?.data ?? null) as SubjectDetail | null);
      setKpis((kpiRes.data?.data ?? []) as ProductKpi[]);
    } catch { /* what is on screen stays */ }
  }, [productId]);

  const allTables = useMemo<SubjectTable[]>(
    () => (data?.star_schemas ?? []).flatMap((s) => s.tables ?? []),
    [data],
  );
  // What this subject BUILDS, and the shared lookups it only USES (copies of
  // tables another subject builds — services/sharedTables.ts). Counts, rows,
  // lineage and history are about what is built here; the borrowed lookups
  // are listed as links to their originals, never as tables of this subject.
  const ownTables = useMemo(() => allTables.filter((t) => !t.is_reference), [allTables]);
  const sharedTables = useMemo(() => allTables.filter((t) => t.is_reference), [allTables]);

  // ── Rebuild — the whole subject, streamed into a strip under the header ──
  // The bus-matrix refresh job, exactly as Manage mode ran it: one call to
  // start, then its stream. Deliberately not the Build page's terminal — this
  // reads as "your subject is updating", which is what a curator here wants.
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'done' | 'error' | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const runRebuild = useCallback(async (syncSource: boolean) => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    setProgress(syncSource ? 'Syncing the source first…' : 'Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await api.post(`/products/${productId}/refresh-start`, { syncSource });
      const jobId = res.data?.data?.jobId as string | undefined;
      if (!jobId) throw new Error('No job id returned');
      await streamSSE(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
        method: 'GET',
        signal: controller.signal,
        onEvent: (raw) => {
          const e = raw as Record<string, unknown>;
          const type = e.type as string;
          if (type === 'phase' || type === 'log') {
            setProgress(String(e.friendly ?? e.text ?? ''));
          } else if (type === 'error_detail') {
            setProgress(`${String(e.tableName)}: ${String(e.error)}`);
          } else if (type === 'completed') {
            const result = e.result as { allOk?: boolean } | null;
            setOutcome(result?.allOk === false ? 'error' : 'done');
            void reload();
            onChanged?.();
          } else if (type === 'failed' || type === 'error') {
            setOutcome('error');
            toast.error('Rebuild failed', { description: String(e.error ?? e.message ?? 'Unknown error') });
            void reload();
            onChanged?.();
          }
        },
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setOutcome('error');
      toast.error('Rebuild failed', { description: errorText(err, 'Unknown error') });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  }, [busy, productId, reload, onChanged, toast]);

  async function handleDelete() {
    if (!data) return;
    if (!confirm(`Delete "${data.name}"? Everything built for this subject is removed — its tables, metrics and history. This cannot be undone.`)) return;
    try {
      await api.delete(`/products/${productId}`);
      toast.success('Subject deleted');
      onDeleted?.();
    } catch (err) {
      toast.error('Delete failed', { description: errorText(err, 'Unknown error') });
    }
  }

  // ── Add a table: created empty, then opened on its SQL to be declared ────
  const [adding, setAdding] = useState(false);
  const handleAdded = useCallback((created: { id: number; table_name: string }) => {
    setAdding(false);
    toast.success('Table added', { description: `Now declare the SQL that builds ${created.table_name}.` });
    onChanged?.();
    void reload();
    onNavigate?.({ kind: 'table', tableId: created.id, tab: 'sql' });
  }, [toast, onChanged, reload, onNavigate]);

  // ── Lineage: curators pick a table for the graph; viewers read a sentence ─
  const [lineageTableId, setLineageTableId] = useState<number | null>(null);
  const [sourceTables, setSourceTables] = useState<string[] | null>(null);
  useEffect(() => {
    if (tab !== 'lineage' || curator || sourceTables !== null) return;
    let cancelled = false;
    api.get(`/products/${productId}/sources`)
      .then((r) => {
        if (cancelled) return;
        const rows = (r.data?.data ?? []) as Array<{ table_name: string }>;
        setSourceTables(Array.from(new Set(rows.map((row) => row.table_name))).sort());
      })
      .catch(() => { if (!cancelled) setSourceTables([]); });
    return () => { cancelled = true; };
  }, [tab, curator, sourceTables, productId]);

  if (loading || !data) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-7 py-6 max-w-4xl mx-auto w-full">
          <div className="h-8 bg-soft animate-pulse rounded w-48 mb-3" />
          <div className="h-4 bg-soft animate-pulse rounded w-96" />
        </div>
      </div>
    );
  }

  const refreshed = data.last_refreshed_at ? formatRelative(data.last_refreshed_at) : 'not yet';
  const SubjectIcon = iconForAnalytics(data.name);
  const askHref = askAboutSubject({ productId: data.id, productName: data.name, connectionId: data.source?.id ?? data.connection_id });
  const lineageAnchorId = lineageTableId
    ?? ownTables.find((t) => t.table_role === 'fact')?.id
    ?? ownTables[0]?.id
    ?? null;

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'metrics', label: 'Metrics', count: kpis.length },
    { id: 'tables', label: 'Tables', count: ownTables.length },
    { id: 'relations', label: 'Relations' },
    { id: 'lineage', label: 'Lineage' },
    { id: 'quality', label: 'Quality' },
    ...(curator ? [{ id: 'history' as const, label: 'History' }] : []),
  ];

  const menuItems = [
    ...(admin ? [{ label: 'Sync the source, then rebuild', onClick: () => { void runRebuild(true); }, icon: <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> }] : []),
    { label: 'Add a table', onClick: () => { setTab('tables'); setAdding(true); }, icon: <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> },
    // Hide/show: whether the subject is LISTED on the Subjects page. It stays
    // built and in this tree either way (the Build page's eye, moved here).
    ...(builds ? [data.hidden
      ? { label: 'Show on the Subjects page', onClick: () => { void builds.setHidden(data.id, false).then((ok) => { if (ok) void reload(); }); }, icon: <Eye className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> }
      : { label: 'Hide from the Subjects page', onClick: () => { void builds.setHidden(data.id, true).then((ok) => { if (ok) void reload(); }); }, icon: <EyeOff className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> }] : []),
    ...(admin ? [{ label: 'Delete this subject', onClick: () => { void handleDelete(); }, icon: <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> }] : []),
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ExplorerHeader
        crumbs={[{ label: 'Catalog', onClick: () => onNavigate?.({ kind: 'catalog' }) }, { label: data.name }]}
        icon={(
          <span className="w-8 h-8 rounded-lg border border-ocean/20 bg-ocean-softer flex items-center justify-center text-ocean">
            <SubjectIcon className="w-4 h-4" strokeWidth={1.75} aria-hidden />
          </span>
        )}
        title={data.name}
        badges={curator && data.hidden ? (
          <span className="text-[10px] font-mono tracking-[0.08em] uppercase px-1.5 py-0.5 rounded border border-line bg-softer text-muted" title="Not listed on the Subjects page">
            hidden
          </span>
        ) : undefined}
        subtitle={(
          <span className="block max-w-3xl">
            {data.description && <span className="text-ink-2">{data.description} </span>}
            <span className="text-muted-2 font-mono text-[11px] whitespace-nowrap">Refreshed {refreshed}</span>
          </span>
        )}
        actions={(
          <>
            {admin && (
              <HeaderAction onClick={() => { void runRebuild(false); }} icon={<RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} strokeWidth={1.75} aria-hidden />} title="Rebuild every table of this subject from its saved SQL">
                Rebuild
              </HeaderAction>
            )}
            <HeaderAction href={askHref} primary icon={<Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />} title="Ask a question about this subject">
              Ask AI
            </HeaderAction>
            {curator && <MoreMenu items={menuItems} />}
          </>
        )}
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
      />

      {/* The rebuild, as it happens; then its outcome, dismissable. */}
      {busy && (
        <div className="shrink-0 border-b border-line bg-ocean-softer px-7 py-1.5">
          <div className="flex items-center gap-2 text-[12px] text-ocean">
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />
            <span className="truncate">{progress ?? 'Working…'}</span>
          </div>
          <div className="mt-1 h-[2px] overflow-hidden rounded-sm bg-ocean/15">
            <div className="h-full w-1/3 animate-pulse rounded-sm bg-ocean" />
          </div>
        </div>
      )}
      {!busy && outcome && (
        <div className={cn('shrink-0 border-b border-line px-7 py-1.5 flex items-center gap-2 text-[12px]', outcome === 'done' ? 'bg-ok-soft text-ok' : 'bg-err-soft text-err')}>
          {outcome === 'done'
            ? <><Check className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden /> Rebuilt — your team sees the new data now.</>
            : <><X className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden /> The rebuild did not finish cleanly — each table&apos;s state says what happened.</>}
          <button type="button" onClick={() => setOutcome(null)} className="ml-auto text-[10.5px] font-mono uppercase tracking-[0.08em] opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* ── Tab body ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6 pb-24">
        <div className="max-w-5xl mx-auto">
          {tab === 'overview' && (
            <OverviewTab data={data} kpis={kpis} aiStarters={aiStarters} allTables={allTables} ownTables={ownTables} askHref={askHref} />
          )}
          {tab === 'metrics' && (
            curator
              ? <KpiManager productId={productId} kpis={kpis} onChanged={() => { void reload(); onChanged?.(); }} />
              : <MetricsTab kpis={kpis} />
          )}
          {tab === 'tables' && (
            <TablesTab
              tables={ownTables}
              sharedTables={sharedTables}
              productId={productId}
              curator={curator}
              adding={adding}
              onAdding={setAdding}
              onAdded={handleAdded}
              onNavigate={onNavigate}
            />
          )}
          {tab === 'relations' && (
            <SubjectRelations productId={productId} detail={data} curator={curator} onNavigate={onNavigate} />
          )}
          {tab === 'lineage' && (
            curator ? (
              ownTables.length === 0 || lineageAnchorId === null
                ? <EmptyTabState message="Nothing to trace yet." />
                : (
                  <>
                    {/* One table at a time — the graph is always anchored
                        (no lineage hairball), so the picker IS the
                        navigation. Default: the measures table. */}
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {ownTables.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setLineageTableId(t.id)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-[12px] transition-colors',
                            t.id === lineageAnchorId ? 'border-ocean bg-ocean-softer text-ocean' : 'border-line bg-raised text-ink-3 hover:border-ink-3',
                          )}
                        >
                          {t.display_name || humanizeTable(t)}
                        </button>
                      ))}
                    </div>
                    <div className="overflow-hidden rounded-lg border border-line bg-raised">
                      <LineageGraph layer="product" tableId={lineageAnchorId} />
                    </div>
                  </>
                )
            ) : (
              <ViewerLineage name={data.name} sourceTables={sourceTables} />
            )
          )}
          {tab === 'quality' && (
            curator ? <QualityTab productNameFilter={data.name} /> : <ViewerQuality tables={ownTables} />
          )}
          {tab === 'history' && (
            ownTables.length === 0
              ? <EmptyTabState message="No refreshes have run yet." />
              : (
                <div className="space-y-5">
                  {ownTables.map((t) => (
                    <div key={t.id} className="rounded-lg border border-line bg-raised px-5 py-4">
                      <div className="mb-2 text-[13px] font-medium text-ink">{t.display_name || humanizeTable(t)}</div>
                      <RefreshHistoryChart productTableId={t.id} variant="full" />
                    </div>
                  ))}
                </div>
              )
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Overview
// ───────────────────────────────────────────────────────────────────────────

function OverviewTab({
  data, kpis, aiStarters, allTables, ownTables, askHref,
}: {
  data: SubjectDetail;
  kpis: ProductKpi[];
  aiStarters: string[] | null;
  allTables: SubjectTable[];
  ownTables: SubjectTable[];
  askHref: string;
}) {
  const router = useRouter();
  const starters = aiStarters && aiStarters.length > 0 ? aiStarters : kpisToStarters(kpis, allTables, data.name);
  const topKpis = kpis.slice(0, 5);

  return (
    <div className="space-y-8">
      {starters.length > 0 && (
        <Section title="Try asking" icon={<Sparkles className="w-3.5 h-3.5" strokeWidth={1.75} />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {starters.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => router.push(askAboutSubject({
                  productId: data.id, productName: data.name,
                  connectionId: data.source?.id ?? data.connection_id, question: q,
                }))}
                className="group/q flex items-center gap-3 text-left px-4 py-3 bg-raised border border-line rounded-md hover:border-ocean/40 hover:bg-soft transition-colors"
              >
                <span className="text-[13.5px] text-ink-2 group-hover/q:text-ink leading-snug flex-1">{q}</span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-2 group-hover/q:text-ocean group-hover/q:translate-x-0.5 transition-all flex-shrink-0" strokeWidth={2} />
              </button>
            ))}
          </div>
        </Section>
      )}

      {topKpis.length > 0 && (
        <Section title="Top metrics" icon={<BarChart3 className="w-3.5 h-3.5" strokeWidth={1.75} />}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {topKpis.map((k) => <KpiCard key={k.id} kpi={k} />)}
          </div>
          {kpis.length > topKpis.length && (
            <p className="text-[11.5px] text-muted-2 mt-2">+ {kpis.length - topKpis.length} more in the Metrics tab →</p>
          )}
        </Section>
      )}

      <Section title="At a glance" icon={<Database className="w-3.5 h-3.5" strokeWidth={1.75} />}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Tables" value={ownTables.length} />
          <Stat label="Metrics" value={kpis.length} />
          <Stat label="Rows" value={ownTables.reduce((s, t) => s + (Number(t.row_count) || 0), 0)} format="compact" />
          <Stat label="Last refreshed" value={data.last_refreshed_at ? formatRelative(data.last_refreshed_at) : '—'} text />
        </div>
      </Section>

      <p className="text-[12px] text-muted">
        Anything else? <a href={askHref} className="text-ocean hover:text-ocean-hover">Ask about {data.name} →</a>
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Metrics — the read-only list (curators get KpiManager)
// ───────────────────────────────────────────────────────────────────────────

function MetricsTab({ kpis }: { kpis: ProductKpi[] }) {
  if (kpis.length === 0) return <EmptyTabState message="This subject has no metrics defined yet." />;
  return (
    <Section title={`All metrics (${kpis.length})`} icon={<BarChart3 className="w-3.5 h-3.5" strokeWidth={1.75} />}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {kpis.map((k) => <KpiCard key={k.id} kpi={k} />)}
      </div>
    </Section>
  );
}

function KpiCard({ kpi }: { kpi: ProductKpi }) {
  return (
    <div className="px-4 py-3 bg-raised border border-line rounded-md">
      <div className="text-[13px] font-medium text-ink mb-0.5">{humanize(kpi.name)}</div>
      {kpi.question_text && <p className="text-[12px] text-ink-2 leading-snug mb-0.5">{kpi.question_text}</p>}
      {kpi.description && <p className="text-[11.5px] text-muted leading-snug">{kpi.description}</p>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Tables — the list, a door into each table's page, and "Add a table"
// ───────────────────────────────────────────────────────────────────────────

function TablesTab({
  tables, sharedTables, productId, curator, adding, onAdding, onAdded, onNavigate,
}: {
  tables: SubjectTable[];
  /** Lookups this subject uses but another subject builds — listed as links. */
  sharedTables: SubjectTable[];
  productId: number;
  curator: boolean;
  adding: boolean;
  onAdding: (open: boolean) => void;
  onAdded: (created: { id: number; table_name: string }) => void;
  onNavigate?: (target: CatalogNavTarget) => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const owners = Array.from(new Set(sharedTables.map((t) => t.owner_product_name).filter((n): n is string => !!n)));
  return (
    <div className="space-y-6">
    <Section
      title={`Built here (${tables.length})`}
      icon={<Boxes className="w-3.5 h-3.5" strokeWidth={1.75} />}
      aside={curator && !adding ? (
        <button type="button" onClick={() => onAdding(true)} className="inline-flex items-center gap-1 text-[12px] font-medium text-ocean hover:text-ocean-hover transition-colors">
          <Plus className="w-3.5 h-3.5" strokeWidth={2} aria-hidden /> Add a table
        </button>
      ) : undefined}
    >
      {curator && adding && (
        <AddTableForm productId={productId} onAdded={onAdded} onCancel={() => onAdding(false)} />
      )}
      {tables.length === 0 ? (
        <EmptyTabState message="This subject has no tables yet." />
      ) : (
        <div className="bg-raised border border-line rounded-md divide-y divide-line">
          {tables.map((t) => (
            <TableRow
              key={t.id}
              table={t}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}
              onOpen={onNavigate ? () => onNavigate({ kind: 'table', tableId: t.id }) : undefined}
            />
          ))}
        </div>
      )}
    </Section>

    {sharedTables.length > 0 && (
      <Section
        title={`Uses ${owners.length === 1 ? `from ${owners[0]}` : 'shared lookups'} (${sharedTables.length})`}
        icon={<Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />}
      >
        <p className="text-[12px] text-muted mb-2.5 leading-relaxed">
          Lookups this subject slices by, built once in another subject and shared. Change them where they are built.
        </p>
        <div className="bg-raised border border-line rounded-md divide-y divide-line">
          {sharedTables.map((t) => {
            const name = t.display_name || humanizeTable(t);
            const ownerId = t.owner_table_id ?? null;
            return (
              <div key={t.id} className="px-4 py-2.5 flex items-center gap-3">
                {ownerId != null && onNavigate ? (
                  <button
                    type="button"
                    onClick={() => onNavigate({ kind: 'table', tableId: ownerId })}
                    className="inline-flex items-center gap-1 text-[13px] text-ink hover:text-ocean transition-colors text-left min-w-0"
                    title={`Open ${name} in ${t.owner_product_name ?? 'the subject that builds it'}`}
                  >
                    <span className="truncate">{name}</span>
                    <ArrowUpRight className="w-3.5 h-3.5 shrink-0 text-muted-2" strokeWidth={1.75} aria-hidden />
                  </button>
                ) : (
                  <span className="text-[13px] text-ink truncate">{name}</span>
                )}
                <span className="ml-auto text-[11.5px] text-muted-2 shrink-0">
                  {ownerId != null ? `in ${t.owner_product_name ?? 'another subject'}` : 'not built yet'}
                </span>
              </div>
            );
          })}
        </div>
      </Section>
    )}
    </div>
  );
}

function TableRow({ table, expanded, onToggle, onOpen }: {
  table: SubjectTable;
  expanded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const name = table.display_name || humanizeTable(table);
  return (
    <div>
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          {onOpen ? (
            <button type="button" onClick={onOpen} className="text-[13px] font-medium text-ink hover:text-ocean transition-colors text-left truncate max-w-full" title="Open this table">
              {name}
            </button>
          ) : (
            <div className="text-[13px] font-medium text-ink truncate">{name}</div>
          )}
          {table.description && <p className="text-[11.5px] text-muted leading-snug truncate mt-0.5">{table.description}</p>}
        </div>
        <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 flex-shrink-0">
          {table.table_role === 'fact' ? 'measures' : table.table_role === 'dimension' ? 'lookup' : table.table_role}
        </span>
        <span className="text-[11px] font-mono text-muted-2 tabular-nums flex-shrink-0">
          {table.columns?.length ?? 0} {table.columns?.length === 1 ? 'col' : 'cols'}
        </span>
        {typeof table.row_count === 'number' && table.row_count > 0 && (
          <span className="text-[11px] font-mono text-muted-2 tabular-nums flex-shrink-0">{compactNumber(table.row_count)} rows</span>
        )}
        <button type="button" onClick={onToggle} className="p-1 rounded hover:bg-soft text-muted-2 hover:text-ink transition-colors" aria-expanded={expanded} aria-label={expanded ? 'Hide the columns' : 'Show the columns'}>
          <ArrowRight className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-90')} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {expanded && (
        <div className="px-4 py-3 bg-softer border-t border-line space-y-4">
          {table.columns && table.columns.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted-2 mb-2">Columns</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {table.columns.map((c) => (
                  <div key={c.id} className="text-[12.5px]">
                    <span className="text-ink font-medium">{c.display_name || humanize(c.column_name)}</span>
                    {c.description && <span className="text-muted ml-1.5">— {c.description}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted-2 mb-2">Sample data</div>
            <PreviewTable url={`/semantic/product-preview?productTableId=${table.id}&limit=10`} />
          </div>
          {onOpen && (
            <button type="button" onClick={onOpen} className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ocean hover:underline">
              Open this table →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ROLE_OPTIONS: Array<{ value: 'fact' | 'dimension' | 'bridge'; label: string }> = [
  { value: 'fact', label: 'Measures table' },
  { value: 'dimension', label: 'Lookup table' },
  { value: 'bridge', label: 'Bridge table' },
];

/**
 * A table by hand: a name and what kind of table it is. It is created EMPTY
 * and opened on its SQL tab, where the declaration is written and saved —
 * the one act the workshop had that nothing else covered.
 */
function AddTableForm({ productId, onAdded, onCancel }: {
  productId: number;
  onAdded: (created: { id: number; table_name: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [tableRole, setTableRole] = useState<'fact' | 'dimension' | 'bridge'>('fact');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z][a-z0-9_]{0,62}$/.test(name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.post(`/products/${productId}/tables`, {
        tableName: name,
        tableRole,
        description: description.trim() || undefined,
      });
      const created = r.data?.data as { id: number; table_name: string };
      onAdded(created);
    } catch (err) {
      setError(errorText(err, 'Could not add the table'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 bg-raised border border-ocean/40 rounded-lg p-4 space-y-3" aria-label="Add a table">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
        <div>
          <label className="block text-[11px] text-muted mb-1" htmlFor="new-table-name">Technical name</label>
          <input
            id="new-table-name"
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            placeholder="fact_returns"
            autoFocus
            spellCheck={false}
            className="w-full font-mono bg-raised border border-line rounded-md px-3 py-1.5 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
          />
          <p className="mt-1 text-[11px] text-muted-2">Lowercase letters, digits and underscores — it is the name the SQL uses.</p>
        </div>
        <div>
          <label className="block text-[11px] text-muted mb-1" htmlFor="new-table-role">Kind</label>
          <select
            id="new-table-role"
            value={tableRole}
            onChange={(e) => setTableRole(e.target.value as 'fact' | 'dimension' | 'bridge')}
            className="bg-raised border border-line rounded-md px-3 py-1.5 text-[13px] text-ink-2 focus:outline-none focus:border-ocean"
          >
            {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-[11px] text-muted mb-1" htmlFor="new-table-description">What is one row? <span className="text-muted-2">(optional)</span></label>
        <input
          id="new-table-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One row per returned item"
          className="w-full bg-raised border border-line rounded-md px-3 py-1.5 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        />
      </div>
      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={!valid || saving} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden /> : <Plus className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />}
          Add and declare its SQL
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-[12.5px] text-muted hover:text-ink transition-colors">Cancel</button>
      </div>
    </form>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Lineage and quality for viewers — sentences and a list, no graph
// ───────────────────────────────────────────────────────────────────────────

function ViewerLineage({ name, sourceTables }: { name: string; sourceTables: string[] | null }) {
  return (
    <Section title="Where this data comes from" icon={<GitBranch className="w-3.5 h-3.5" strokeWidth={1.75} />}>
      <div className="bg-raised border border-line rounded-md p-5 leading-relaxed text-[13px] text-ink-2">
        {sourceTables === null ? (
          <span className="inline-flex items-center gap-2 text-muted"><Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden /> Looking it up…</span>
        ) : sourceTables.length === 0 ? (
          <p><strong className="text-ink">{name}</strong> is built from your source systems; the tables it reads have not been recorded yet.</p>
        ) : (
          <>
            <p className="mb-2">
              <strong className="text-ink">{name}</strong> is built from {sourceTables.length === 1 ? 'this source table' : `these ${sourceTables.length} source tables`}:
            </p>
            <p className="flex flex-wrap gap-1.5">
              {sourceTables.map((t) => (
                <span key={t} className="inline-flex rounded border border-line bg-softer px-1.5 py-0.5 text-[12px] text-ink-2">{humanize(t)}</span>
              ))}
            </p>
            <p className="mt-3 text-muted">Whenever the source changes, a refresh brings the tables here up to date.</p>
          </>
        )}
      </div>
    </Section>
  );
}

function ViewerQuality({ tables }: { tables: SubjectTable[] }) {
  if (tables.length === 0) return <EmptyTabState message="No data quality history yet — the subject has no tables." />;
  return (
    <Section title="Data quality" icon={<ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} />}>
      <div className="bg-raised border border-line rounded-md p-5">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Quality scores track how complete, unique and valid each table&rsquo;s data is. Open a table to see its score and the checks behind it.
        </p>
      </div>
      <div className="bg-raised border border-line rounded-md divide-y divide-line mt-3">
        {tables.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-[13px] text-ink flex-1 truncate">{t.display_name || humanizeTable(t)}</span>
            <span className="text-[11px] font-mono text-muted-2 tabular-nums">{typeof t.row_count === 'number' ? `${compactNumber(t.row_count)} rows` : '—'}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Atoms
// ───────────────────────────────────────────────────────────────────────────

function Section({ title, icon, aside, children }: {
  title: string;
  icon: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex items-center text-ocean">{icon}</span>
        <h2 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium flex-1">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, format, text }: {
  label: string;
  value: number | string;
  format?: 'compact';
  text?: boolean;
}) {
  const display = text || typeof value === 'string'
    ? String(value)
    : format === 'compact' ? compactNumber(value as number) : (value as number).toLocaleString();
  return (
    <div className="px-3 py-2.5 bg-raised border border-line rounded-md">
      <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 mb-0.5">{label}</div>
      <div className="text-[18px] font-display text-ink tabular-nums tracking-tight">{display}</div>
    </div>
  );
}

function EmptyTabState({ message }: { message: string }) {
  return (
    <div className="bg-raised border border-line rounded-md p-8 text-center">
      <p className="text-[13px] text-muted">{message}</p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (humanize, starters, compact numbers)
// ───────────────────────────────────────────────────────────────────────────

function humanize(name: string): string {
  if (!name) return '';
  let s = name.replace(/_+/g, ' ');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ').trim();
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function humanizeTable(t: { display_name?: string | null; table_name: string }): string {
  if (t.display_name) return t.display_name;
  return humanize(t.table_name.replace(/^(dim|fact|bridge|junk)_/, ''));
}

function pluralizeLower(s: string): string {
  const lower = s.toLowerCase();
  if (lower.endsWith('s') || lower.endsWith('x')) return lower;
  if (lower.endsWith('y') && !/[aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

function kpisToStarters(kpis: ProductKpi[], allTables: SubjectTable[], productName: string): string[] {
  if (kpis.length > 0) {
    const names = kpis.slice(0, 3).map((k) => humanize(k.name).toLowerCase());
    const out: string[] = [];
    if (names[0]) out.push(`What's our ${names[0]} this month?`);
    if (names[1]) out.push(`How has ${names[1]} changed over the last year?`);
    else if (names[0]) out.push(`How has ${names[0]} changed over the last year?`);
    if (names[2]) out.push(`Show me ${names[2]} broken down by month.`);
    return out.slice(0, 3);
  }
  const facts = allTables.filter((t) => t.table_role === 'fact');
  if (facts.length > 0) {
    const f0 = humanizeTable(facts[0]);
    return [
      `How many ${pluralizeLower(f0)} were recorded this year?`,
      `Show me ${pluralizeLower(f0)} by month.`,
      `What's the most recent ${f0.toLowerCase()}?`,
    ];
  }
  const dims = allTables.filter((t) => t.table_role === 'dimension' || t.table_role === 'bridge');
  if (dims.length > 0) {
    return [
      `How many ${pluralizeLower(humanizeTable(dims[0]))} do we have?`,
      dims[1] ? `Show me a list of all ${pluralizeLower(humanizeTable(dims[1]))}.` : `List all ${pluralizeLower(humanizeTable(dims[0]))}.`,
      dims[2] ? `Which ${pluralizeLower(humanizeTable(dims[2]))} are most active?` : `Tell me about our ${pluralizeLower(humanizeTable(dims[0]))}.`,
    ];
  }
  return [
    `What's in the ${productName} subject?`,
    `Show me the latest data from ${productName}.`,
    `What can I ask about ${productName}?`,
  ];
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
