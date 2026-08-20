'use client';

/**
 * <ManageLayer> — screen 2 of the topic-first experience.
 *
 * The same topic, turned over. Everything technical the old /products
 * surface showed lives here and NOWHERE ELSE the business user can reach:
 * tables, columns, relationships, the star schema, lineage, quality detail,
 * SQL, refresh/deploy/delete and the AI refine chat.
 *
 * The mode bar is the mode signal and must be present on every tab — if a
 * user can't tell at a glance that they are in a place where changes are
 * staged rather than live, the "nothing changes until you deploy" promise is
 * only a sentence, not an affordance.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Loader2, MoreHorizontal, RefreshCw, SlidersHorizontal,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelativeLong } from '@/lib/dates';
import { streamSSE } from '@/lib/sse';
import { useToast } from '@/components/ui/Toast';
import { iconForAnalytics } from '@/components/catalog/entityIcons';
import ManageTables from '@/components/topics/ManageTables';
import type { FullDataProduct, ProductColumn, ProductKpi, ProductTable } from '@/app/products/types';
import type { DeployState, ManageTab, TableSubTab, Topic } from '@/app/topics/types';

const StarSchemaFlow = dynamic(() => import('@/components/products/StarSchemaFlow'), { ssr: false });
// "Where it comes from" is the catalog's anchored lineage graph, not a
// bespoke flow: one lineage surface, drawn once (2026-08-18), reused here.
const LineageGraph = dynamic(() => import('@/components/catalog/LineageGraph'), { ssr: false });
const KpiManager = dynamic(() => import('@/components/products/KpiManager'), { ssr: false });
const QualityTab = dynamic(() => import('@/app/products/QualityTab'), { ssr: false });
const RefineChat = dynamic(() => import('@/components/products/RefineChat'), { ssr: false });
const RefreshHistoryChart = dynamic(() => import('@/components/products/RefreshHistoryChart'), { ssr: false });

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

type TableWithColumns = ProductTable & { columns: ProductColumn[] };

const TABS: Array<{ key: ManageTab; label: string }> = [
  { key: 'tables',     label: 'Tables' },
  { key: 'fits',       label: 'How it fits together' },
  { key: 'comes-from', label: 'Where it comes from' },
  { key: 'metrics',    label: 'Metrics' },
  { key: 'quality',    label: 'Quality' },
  { key: 'activity',   label: 'Activity' },
];

interface Props {
  topic: Topic;
  detail: FullDataProduct | null;
  kpis: ProductKpi[];
  isAdmin: boolean;
  tab: ManageTab;
  onTab: (t: ManageTab) => void;
  selectedTableId: number | null;
  onSelectTable: (id: number) => void;
  subTab: TableSubTab;
  onSubTab: (t: TableSubTab) => void;
  sqlOpen: boolean;
  onSqlOpen: (open: boolean) => void;
  onExit: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}

export default function ManageLayer({
  topic, detail, kpis, isAdmin,
  tab, onTab, selectedTableId, onSelectTable, subTab, onSubTab,
  sqlOpen, onSqlOpen, onExit, onChanged, onDeleted,
}: Props) {
  const toast = useToast();
  const Glyph = iconForAnalytics(topic.name);
  const [deployState, setDeployState] = useState<DeployState>('idle');
  const [progressText, setProgressText] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refineTable, setRefineTable] = useState<TableWithColumns | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  // "Where it comes from" is anchored on ONE table (§2.4 — no lineage
  // hairball); null = the default anchor (the first measures table).
  const [lineageTableId, setLineageTableId] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const tables: TableWithColumns[] = detail
    ? detail.star_schemas.flatMap((s) => s.tables)
    : [];

  const lineageAnchorId = lineageTableId
    ?? tables.find((t) => t.table_role === 'fact')?.id
    ?? tables[0]?.id
    ?? null;

  /**
   * Refresh = re-run the transformations through the existing bus-matrix
   * refresh job, streaming progress into a slim strip under the mode bar.
   * Deliberately NOT the dark terminal from /products: that reads as "a
   * build is happening to the system"; this reads as "your topic is
   * updating", which is what a curator on this screen actually wants.
   */
  const runRefresh = useCallback(async () => {
    if (deployState === 'running') return;
    setDeployState('running');
    setProgressText('Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await api.post(`/products/${topic.id}/refresh-start`, {});
      const jobId = res.data?.data?.jobId as string | undefined;
      if (!jobId) throw new Error('No job id returned');
      await streamSSE(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
        method: 'GET',
        signal: controller.signal,
        onEvent: (raw) => {
          const e = raw as Record<string, unknown>;
          const type = e.type as string;
          if (type === 'phase' || type === 'log') {
            setProgressText(String(e.text ?? ''));
          } else if (type === 'error_detail') {
            setProgressText(`${String(e.tableName)}: ${String(e.error)}`);
          } else if (type === 'completed') {
            const result = e.result as { allOk?: boolean } | null;
            setDeployState(result?.allOk === false ? 'error' : 'done');
            setProgressText(null);
            onChanged();
          } else if (type === 'failed' || type === 'error') {
            setDeployState('error');
            setProgressText(null);
            toast.error('Refresh failed', { description: String(e.error ?? e.message ?? 'Unknown error') });
            onChanged();
          }
        },
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setDeployState('error');
      setProgressText(null);
      toast.error('Refresh failed', { description: apiError(err) });
    }
  }, [deployState, topic.id, onChanged, toast]);

  /** Deploy = write staged cell SQL onto every table, then rebuild. */
  const runDeploy = useCallback(async () => {
    if (deployState === 'running') return;
    setDeployState('running');
    setProgressText('Deploying changes…');
    try {
      const res = await api.post(`/products/${topic.id}/deploy-all`);
      const results = (res.data?.data?.results ?? []) as Array<{ status: string; table_name: string; error?: string }>;
      const failed = results.filter((r) => r.status === 'error');
      if (failed.length > 0) {
        setDeployState('error');
        toast.error(`${failed.length} of ${results.length} tables failed`, {
          description: failed.map((f) => `${f.table_name}: ${f.error ?? 'unknown error'}`).join(' · ').slice(0, 320),
          duration: 12000,
        });
      } else {
        setDeployState('done');
        toast.success('Deployed', { description: `${results.length} table${results.length === 1 ? '' : 's'} rebuilt — your team sees this now.` });
      }
      onChanged();
    } catch (err) {
      setDeployState('error');
      toast.error('Deploy failed', { description: apiError(err) });
    } finally {
      setProgressText(null);
    }
  }, [deployState, topic.id, onChanged, toast]);

  async function handleDelete() {
    setMenuOpen(false);
    if (!confirm(`Delete "${topic.name}"? Everything built for this topic is removed. This cannot be undone.`)) return;
    try {
      await api.delete(`/products/${topic.id}`);
      onDeleted();
    } catch (err) {
      toast.error('Delete failed', { description: apiError(err) });
    }
  }

  const busy = deployState === 'running';

  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      {/* ── a) Mode bar — the mode signal, on every tab ───────────────── */}
      <div className="flex h-[38px] shrink-0 items-center gap-3 bg-ocean px-6 text-white">
        <SlidersHorizontal className="h-[13px] w-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.14em]">Manage mode</span>
        <span className="hidden truncate text-[12.5px] text-[var(--ocean-soft)] sm:inline">
          Nothing here changes what your team sees until you deploy.
        </span>
        <div className="flex-1" />
        <span className="hidden text-[12px] text-[var(--ocean-soft)] md:inline">
          Press{' '}
          <kbd className="rounded-xs border border-white/35 px-[5px] py-px font-mono text-[10.5px]">Esc</kbd>
        </span>
        <button
          type="button"
          onClick={onExit}
          className="shrink-0 rounded-[5px] bg-white px-3 py-[5px] text-[12.5px] font-medium text-ocean"
        >
          Done
        </button>
      </div>

      {/* Slim progress strip — replaces the dark build terminal. */}
      {busy && (
        <div className="shrink-0 border-b border-line bg-ocean-softer px-6 py-1.5">
          <div className="flex items-center gap-2 text-[12px] text-ocean">
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />
            <span className="truncate">{progressText ?? 'Working…'}</span>
          </div>
          <div className="mt-1 h-[2px] overflow-hidden rounded-sm bg-ocean/15">
            <div className="h-full w-1/3 animate-pulse rounded-sm bg-ocean" />
          </div>
        </div>
      )}

      {/* ── b) Product header ─────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-3 border-b border-line bg-raised px-6 pt-4">
        <div className="flex items-center justify-between gap-6">
          <div className="flex min-w-0 items-center gap-[11px]">
            <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] bg-ocean-softer text-ocean">
              <Glyph className="h-4 w-4" strokeWidth={1.6} aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="truncate font-display text-[22px] leading-[1.2] tracking-[-0.02em] text-ink">
                {topic.name}
              </div>
              <div className="truncate text-[12px] text-muted">
                {[
                  `${topic.counts.tables} table${topic.counts.tables === 1 ? '' : 's'}`,
                  `${topic.counts.sharedLookups} shared lookup${topic.counts.sharedLookups === 1 ? '' : 's'}`,
                  `${topic.counts.metrics} metric${topic.counts.metrics === 1 ? '' : 's'}`,
                  topic.freshness.lastBuiltAt ? `built ${formatRelativeLong(topic.freshness.lastBuiltAt)}` : 'never built',
                ].join(' · ')}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {topic.pendingChanges > 0 && (
              <span className="whitespace-nowrap rounded-full bg-warn-soft px-2.5 py-[5px] text-[12px] text-warn">
                {busy
                  ? 'Deploying…'
                  : `${topic.pendingChanges} change${topic.pendingChanges === 1 ? '' : 's'} not deployed`}
              </span>
            )}
            <button
              type="button"
              onClick={runRefresh}
              disabled={busy || !isAdmin}
              title={isAdmin ? undefined : 'Refreshing is an admin action'}
              className="flex items-center gap-1.5 rounded-sm border border-line bg-raised px-3 py-2 text-[13px] text-ink-2 transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean disabled:opacity-50"
            >
              <RefreshCw className={cn('h-[13px] w-[13px]', busy && 'animate-spin')} strokeWidth={1.75} aria-hidden />
              Refresh
            </button>
            <button
              type="button"
              onClick={runDeploy}
              disabled={busy || !isAdmin}
              title={isAdmin ? undefined : 'Deploying is an admin action'}
              className="rounded-sm bg-ocean px-3.5 py-2 text-[13px] font-medium text-white transition-colors duration-1 ease-observatory hover:bg-ocean-hover disabled:opacity-50"
            >
              Deploy changes
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
                className="flex rounded-sm border border-line bg-raised px-2.5 py-2 text-muted-2 hover:text-ink-2"
              >
                <MoreHorizontal className="h-[15px] w-[15px]" strokeWidth={1.75} aria-hidden />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                  <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-line bg-raised shadow-[var(--shadow-2)]"
                  >
                    {/* Product creation still lives in the build workshop —
                        the topic nav has no "new topic" affordance, so the
                        route must stay reachable from somewhere. */}
                    <a
                      href="/products"
                      className="block px-3.5 py-2 text-[12.5px] text-ink-2 hover:bg-softer"
                      role="menuitem"
                    >
                      Open the build workshop
                    </a>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleDelete}
                      disabled={!isAdmin}
                      className="block w-full px-3.5 py-2 text-left text-[12.5px] text-err hover:bg-softer disabled:opacity-50"
                    >
                      Delete this topic
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Tab strip */}
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTab(t.key)}
              className={cn(
                'relative whitespace-nowrap px-3.5 py-2.5 text-[13px] transition-colors duration-1 ease-observatory',
                tab === t.key ? 'font-medium text-ink' : 'text-muted hover:text-ink-2',
              )}
            >
              {t.label}
              {tab === t.key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-sm bg-ocean" aria-hidden />}
            </button>
          ))}
        </div>
      </div>

      {/* ── c) Tab body ───────────────────────────────────────────────── */}
      {!detail ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-ocean" strokeWidth={2} aria-hidden />
        </div>
      ) : (
        <>
          {tab === 'tables' && (
            <ManageTables
              detail={detail}
              questions={topic.questions}
              isAdmin={isAdmin}
              selectedTableId={selectedTableId}
              onSelectTable={onSelectTable}
              subTab={subTab}
              onSubTab={onSubTab}
              sqlOpen={sqlOpen}
              onSqlOpen={onSqlOpen}
              onRefineTable={(t) => { setRefineTable(t); setRefineOpen(true); }}
              onChanged={onChanged}
            />
          )}

          {tab === 'fits' && (
            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {detail.star_schemas.length === 0
                ? <Empty>Nothing has been designed for this topic yet.</Empty>
                : detail.star_schemas.map((s) => <StarSchemaFlow key={s.id} schema={s} />)}
            </div>
          )}

          {tab === 'comes-from' && (
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {tables.length === 0 || lineageAnchorId === null
                ? <Empty>Nothing to trace yet.</Empty>
                : (
                  <>
                    {/* One table at a time, picked here — the catalog's
                        LineageGraph is always anchored, so the picker IS the
                        navigation. Default anchor: the measures table, the
                        one whose origin people actually ask about. */}
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {tables.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setLineageTableId(t.id)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-[12px] transition-colors',
                            t.id === lineageAnchorId
                              ? 'border-ocean bg-ocean-softer text-ocean'
                              : 'border-line bg-raised text-ink-3 hover:border-ink-3',
                          )}
                        >
                          {t.display_name || t.table_name}
                        </button>
                      ))}
                    </div>
                    <div className="overflow-hidden rounded-lg border border-line bg-raised">
                      <LineageGraph layer="product" tableId={lineageAnchorId} />
                    </div>
                  </>
                )}
            </div>
          )}

          {tab === 'metrics' && (
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <KpiManager productId={topic.id} kpis={kpis} onChanged={onChanged} />
            </div>
          )}

          {tab === 'quality' && (
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <QualityTab productNameFilter={topic.name} />
            </div>
          )}

          {tab === 'activity' && (
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {tables.length === 0
                ? <Empty>No refreshes have run yet.</Empty>
                : tables.map((t) => (
                  <div key={t.id} className="rounded-lg border border-line bg-raised px-5 py-4">
                    <div className="mb-2 text-[13px] font-medium text-ink">{t.display_name ?? t.table_name}</div>
                    <RefreshHistoryChart productTableId={t.id} variant="full" />
                  </div>
                ))}
            </div>
          )}
        </>
      )}

      {/* Refine — today's Refine chat, renamed to a verb and scoped to the
          table the curator was looking at. */}
      {detail && (
        <RefineChat
          productId={topic.id}
          productName={topic.name}
          open={refineOpen}
          onClose={() => setRefineOpen(false)}
          focusedTableId={refineTable?.id ?? null}
          focusedTableName={refineTable?.table_name ?? null}
          onApplied={onChanged}
        />
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] italic text-muted">{children}</p>;
}

function apiError(err: unknown): string {
  const ax = err as { response?: { data?: { error?: string } }; message?: string };
  return ax?.response?.data?.error ?? ax?.message ?? 'Unknown error';
}
