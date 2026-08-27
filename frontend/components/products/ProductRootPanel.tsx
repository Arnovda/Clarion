'use client';

/**
 * <ProductRootPanel> — the body of a data product detail surface.
 *
 * Extracted from `app/products/[id]/page.tsx` so it can be reused by the
 * unified `/catalog` page. Owns the tabbed inner view (Overview, Tables —
 * the definition/inspection surface, incl. the per-table notebook) plus the
 * rebuild button, delete, and embedded AskAIPanel. The surrounding chrome
 * (back button / route navigation) lives in the caller.
 *
 * SLIMMED 2026-08-18: the Schema diagram, Data flow, KPIs and Quality tabs
 * duplicated the topic's Manage mode — one cockpit per topic, so this panel
 * links there ("Manage this topic ↗") instead of re-implementing it.
 */

import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowLeft, Database, RefreshCw, Trash2, Loader2, ChevronRight, ChevronDown,
  Sparkles, Code as CodeIcon, Boxes, Gauge, FileText, Network, Plus, Rocket,
  CheckCircle2, AlertCircle, X, PanelRightClose, PanelRightOpen,
} from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/dates';
import { useRole, canCurate, isAdminRole } from '@/lib/role';
import { getItem, setItem, storageKeys } from '@/lib/storage';
import type {
  Connection,
  DataProduct,
  FullDataProduct,
  ProductTable,
  ProductColumn,
  ProductKpi,
} from '@/app/products/types';
import { StatusDot, StatusBadge, RoleBadge, ColumnRoleBadge, ProductIcon } from '@/app/products/badges';
import { cleanTopicName } from '@/app/products/helpers';
import SourceBadge from '@/components/SourceBadge';

const AskAIPanel = dynamic(() => import('@/app/products/AskAIPanel'), { ssr: false });
const RefineChat = dynamic(() => import('@/components/products/RefineChat'), { ssr: false });
const RefreshHistoryChart = dynamic(() => import('@/components/products/RefreshHistoryChart'), { ssr: false });
const TableNotebook = dynamic(() => import('@/components/products/TableNotebook'), { ssr: false });

type DetailTab = 'overview' | 'tables';

type TransformResult = {
  table_name: string;
  status: 'success' | 'error';
  row_count?: number;
  error?: string;
  product_id?: number;
  product_name?: string;
};

interface Props {
  productId: number;
  onDeleted?: () => void;
  onBack?: () => void;
  /** Show the embedded AskAI side panel (defaults to true). */
  embedAskAI?: boolean;
  /** Show the breadcrumb-style back button above the title. */
  showBackButton?: boolean;
  /** Auto-select this table tab on mount (from deep link ?table=dim_customer). */
  initialTableName?: string;
}

function getAllTables(p: FullDataProduct): (ProductTable & { columns: ProductColumn[] })[] {
  return p.star_schemas
    .flatMap((s) => s.tables)
    .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name));
}

function totalRows(p: FullDataProduct): number {
  return getAllTables(p).reduce((sum, t) => sum + (t.row_count ?? 0), 0);
}

/**
 * The most recent successful materialisation across all tables — the
 * product's "last refreshed" timestamp. Returned as an ISO string, or
 * null when nothing has run yet. Derived from per-table `last_run_at`
 * rather than a dedicated product column so it always reflects reality.
 */
function lastRefreshedAt(p: FullDataProduct): string | null {
  let latest: number | null = null;
  for (const t of getAllTables(p)) {
    if (!t.last_run_at) continue;
    const ts = new Date(t.last_run_at).getTime();
    if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export default function ProductRootPanel({
  productId,
  onDeleted,
  onBack,
  embedAskAI = true,
  showBackButton = true,
  initialTableName,
}: Props) {
  const role = useRole();
  const curator = canCurate(role);
  const admin = isAdminRole(role);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [detail, setDetail] = useState<FullDataProduct | null>(null);
  const [kpis, setKpis] = useState<ProductKpi[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [rebuildPlan, setRebuildPlan] = useState<Array<{ table_name: string; display_name: string; product_name?: string }> | null>(null);
  const [rebuildMenuOpen, setRebuildMenuOpen] = useState(false);
  const [rebuildResults, setRebuildResults] = useState<TransformResult[] | null>(null);
  const [expandedTableId, setExpandedTableId] = useState<number | null>(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [refineOpen, setRefineOpen] = useState(false);
  const [addingTable, setAddingTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [newTableRole, setNewTableRole] = useState('custom');
  const [deployingAll, setDeployingAll] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const v = getItem(storageKeys.productDetailAiPanel);
    if (v != null) setAiPanelOpen(v === '1');
  }, []);

  const toggleAiPanel = useCallback(() => {
    setAiPanelOpen((prev) => {
      const next = !prev;
      setItem(storageKeys.productDetailAiPanel, next ? '1' : '0');
      return next;
    });
  }, []);

  const loadDetail = useCallback(async () => {
    try {
      const res = await api.get(`/products/${productId}`);
      const data = res.data.data as FullDataProduct | undefined;
      if (!data) {
        setNotFound(true);
        return;
      }
      setDetail(data);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  const loadKpis = useCallback(async () => {
    try {
      const res = await api.get(`/products/${productId}/kpis`);
      setKpis(res.data.data ?? []);
    } catch { /* ignore */ }
  }, [productId]);

  const loadAux = useCallback(async () => {
    try {
      const [conRes, prodRes] = await Promise.all([
        api.get('/connections'),
        api.get('/products'),
      ]);
      setConnections(conRes.data.data ?? []);
      setProducts(prodRes.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!Number.isFinite(productId)) { setNotFound(true); setLoading(false); return; }
    setLoading(true);
    setNotFound(false);
    loadDetail();
    loadKpis();
    loadAux();
  }, [productId, loadDetail, loadKpis, loadAux]);

  // Auto-select table tab from deep link (?table=dim_customer)
  useEffect(() => {
    if (!initialTableName || !detail) return;
    const tables = getAllTables(detail);
    const match = tables.find((t) => t.table_name === initialTableName);
    if (match) setSelectedTableId(match.id);
  }, [initialTableName, detail]);

  async function handleRebuild(opts: { includeUpstream?: boolean } = {}) {
    if (!detail || running) return;
    const localTables = getAllTables(detail).filter((t) => !!t.transformation_sql);
    const plan = localTables.map((t) => ({
      table_name: t.table_name,
      display_name: t.display_name ?? t.table_name,
      product_name: detail.name,
    }));
    if (plan.length === 0 && !opts.includeUpstream) {
      toast.warn('Nothing to rebuild', { description: 'No tables with transformation SQL.' });
      return;
    }
    setRebuildPlan(plan);
    setRebuildResults(null);
    setRunning(true);
    try {
      const url = opts.includeUpstream
        ? `/products/${detail.id}/run-full?include=upstream`
        : `/products/${detail.id}/run-full`;
      const res = await api.post(url);
      const results = (res.data?.data ?? []) as TransformResult[];
      setRebuildResults(results);
      const errors = results.filter((r) => r.status === 'error');
      const totalRowsRebuilt = results.reduce((s, r) => s + (r.row_count ?? 0), 0);
      const productCount = new Set(results.map((r) => r.product_id ?? detail.id)).size;
      if (errors.length === 0) {
        const productSuffix = productCount > 1 ? ` across ${productCount} products` : '';
        toast.success(`Rebuilt ${results.length} table${results.length === 1 ? '' : 's'}${productSuffix}`, {
          description: `${totalRowsRebuilt.toLocaleString('en-GB')} rows written to the warehouse.`,
        });
      } else {
        toast.error(`${errors.length} of ${results.length} tables failed`, {
          description: errors.map((e) => `${e.table_name}: ${e.error ?? 'unknown error'}`).join(' \u00b7 ').slice(0, 320),
          duration: 12000,
        });
      }
      await loadDetail();
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
      const msg = ax?.response?.data?.error ?? ax?.response?.data?.message ?? ax?.message ?? 'Rebuild failed';
      toast.error('Rebuild failed', { description: msg, duration: 12000 });
      setRebuildResults([]);
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!detail) return;
    if (!confirm(`Delete data product "${cleanTopicName(detail.name)}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/products/${detail.id}`);
      onDeleted?.();
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string } }; message?: string };
      toast.error('Delete failed', { description: ax?.response?.data?.error ?? ax?.message ?? 'Unknown error' });
    }
  }

  async function handleAddTable() {
    if (!detail || !newTableName.trim()) return;
    try {
      const res = await api.post(`/products/${detail.id}/tables`, {
        tableName: newTableName.trim(),
        tableRole: newTableRole,
      });
      setAddingTable(false);
      setNewTableName('');
      setNewTableRole('custom');
      await loadDetail();
      setSelectedTableId(res.data.data?.id ?? null);
      toast.success(`Table "${newTableName.trim()}" added`);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to add table';
      toast.error(msg);
    }
  }

  async function handleDeployAll() {
    if (!detail || deployingAll) return;
    setDeployingAll(true);
    try {
      const res = await api.post(`/products/${detail.id}/deploy-all`);
      const data = res.data.data;
      const ok = (data?.results ?? []).filter((r: { status: string }) => r.status === 'success').length;
      const fail = (data?.results ?? []).filter((r: { status: string }) => r.status === 'error').length;
      if (fail > 0) {
        toast.warn(`Deployed: ${ok} ok, ${fail} failed`);
      } else {
        toast.success(`All ${ok} tables deployed successfully`);
      }
      loadDetail();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Deploy failed';
      toast.error(msg);
    } finally {
      setDeployingAll(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted" />
      </div>
    );
  }
  if (notFound || !detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
        <Database className="w-8 h-8 text-muted-2" strokeWidth={1.5} />
        <p className="text-[14px] text-ink">Data product not found.</p>
        {onBack && (
          <button
            onClick={onBack}
            className="text-[12px] text-ocean hover:text-ocean-hover font-medium"
          >
            &larr; Back
          </button>
        )}
      </div>
    );
  }

  const tables = getAllTables(detail);
  const name = cleanTopicName(detail.name);
  const hasReferences = tables.some((t) => t.is_reference);
  const refreshedIso = lastRefreshedAt(detail);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Header */}
      <div className="border-b border-line bg-raised px-6 py-4 shrink-0">
        {showBackButton && onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-[11px] font-mono tracking-[0.14em] uppercase text-muted hover:text-ink-2 transition-colors mb-2"
          >
            <ArrowLeft className="w-3 h-3" strokeWidth={2} />
            Data products
          </button>
        )}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-ocean-softer flex items-center justify-center shrink-0 text-ocean">
            <ProductIcon product={detail} className="w-7 h-7" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-[22px] tracking-[-0.01em] text-ink truncate">{name}</h1>
              <StatusBadge status={detail.status} />
              {detail.source && (
                <SourceBadge source={detail.source} size="compact" />
              )}
            </div>
            {detail.description && (
              <p className="text-[13.5px] text-ink-2 mt-1 leading-relaxed">{detail.description}</p>
            )}
            <p className="text-[11px] text-muted mt-1">
              <span className={refreshedIso ? 'text-ink-2' : 'text-warn'}>
                {refreshedIso ? `Updated ${formatRelative(refreshedIso)}` : 'Not yet refreshed'}
              </span>
              {` \u00b7 ${tables.length} table${tables.length === 1 ? '' : 's'}`}
              {totalRows(detail) > 0 ? ` \u00b7 ${totalRows(detail).toLocaleString('en-GB')} rows` : ''}
              {kpis.length > 0 ? ` \u00b7 ${kpis.length} KPI${kpis.length === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Action buttons (Rebuild / Refine / Delete) are curator
                surfaces \u2014 viewers don't get them. Backend enforces the
                role check too; gating here keeps the UI honest. */}
            {curator && (
              <button
                onClick={handleDeployAll}
                disabled={deployingAll || running || tables.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ocean border border-ocean/30 rounded-md hover:bg-ocean/5 disabled:opacity-50 transition-colors"
                title="Write all cell SQL to tables and materialize"
              >
                {deployingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" strokeWidth={2} />}
                {deployingAll ? 'Deploying…' : 'Deploy all'}
              </button>
            )}
            {curator && (
            <div className="relative inline-flex">
              <button
                onClick={() => handleRebuild()}
                disabled={running || tables.length === 0}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white hover:bg-ocean-hover disabled:opacity-50 transition-colors',
                  hasReferences ? 'rounded-l-md border-r border-ocean-hover/40' : 'rounded-md',
                )}
              >
                {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" strokeWidth={2} />}
                {running ? 'Running\u2026' : 'Refresh'}
              </button>
              {hasReferences && (
                <>
                  <button
                    onClick={() => setRebuildMenuOpen((v) => !v)}
                    disabled={running}
                    className="inline-flex items-center justify-center px-1.5 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-r-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
                    title="More refresh options"
                    aria-haspopup="menu"
                    aria-expanded={rebuildMenuOpen}
                  >
                    <ChevronDown className="w-3 h-3" strokeWidth={2.5} />
                  </button>
                  {rebuildMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setRebuildMenuOpen(false)}
                        aria-hidden="true"
                      />
                      <div className="absolute right-0 top-full mt-1 w-72 z-20 bg-raised border border-line rounded-md shadow-lg overflow-hidden">
                        <button
                          onClick={() => { setRebuildMenuOpen(false); handleRebuild(); }}
                          className="w-full text-left px-3 py-2 text-[12px] hover:bg-soft transition-colors"
                        >
                          <div className="font-medium text-ink">Refresh this product</div>
                          <div className="text-[11px] text-muted mt-0.5">Re-runs only the tables this product owns. Fastest.</div>
                        </button>
                        <button
                          onClick={() => { setRebuildMenuOpen(false); handleRebuild({ includeUpstream: true }); }}
                          className="w-full text-left px-3 py-2 text-[12px] hover:bg-soft transition-colors border-t border-line"
                        >
                          <div className="font-medium text-ink">Refresh + upstream dependencies</div>
                          <div className="text-[11px] text-muted mt-0.5">Refreshes shared lookup tables in their owner products first, then this one. Use when source data changed.</div>
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            )}
            {curator && (
              <button
                onClick={() => setRefineOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ocean border border-ocean/30 rounded-md hover:bg-ocean/5 transition-colors"
                title="Refine — chat to add columns, KPIs, or change SQL"
              >
                <Sparkles className="w-3 h-3" strokeWidth={2} />
                Refine
              </button>
            )}
            {/* Delete is admin-only; analysts can refine but not destroy. */}
            {admin && (
              <button
                onClick={handleDelete}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-err bg-err-soft border border-err/20 rounded-md hover:bg-err/10 transition-colors"
              >
                <Trash2 className="w-3 h-3" strokeWidth={2} />
                Delete
              </button>
            )}
            {embedAskAI && (
              <button
                onClick={toggleAiPanel}
                className="hidden lg:inline-flex items-center justify-center w-8 h-8 text-muted-2 hover:text-ink hover:bg-soft rounded-md transition-colors"
                title={aiPanelOpen ? 'Hide AI panel' : 'Show AI panel'}
                aria-label={aiPanelOpen ? 'Hide AI panel' : 'Show AI panel'}
                aria-pressed={aiPanelOpen}
              >
                {aiPanelOpen
                  ? <PanelRightClose className="w-4 h-4" strokeWidth={2} />
                  : <PanelRightOpen className="w-4 h-4" strokeWidth={2} />}
              </button>
            )}
          </div>
        </div>
      </div>

      {(running || rebuildPlan) && (
        <RebuildBanner
          plan={rebuildPlan ?? []}
          results={rebuildResults}
          running={running}
          onDismiss={() => { setRebuildPlan(null); setRebuildResults(null); }}
        />
      )}

      {/* Two-column body: details + chat */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: tabbed content */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Table tabs — horizontal scrollable pills for each table in the product */}
          {tables.length > 0 && curator && (
            <div className="border-b border-line bg-raised px-6 shrink-0">
              <div className="flex items-center gap-1 overflow-x-auto py-2 -mb-px">
                {tables.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setSelectedTableId(t.id); setTab('overview'); }}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium rounded-md whitespace-nowrap transition-colors shrink-0',
                      selectedTableId === t.id
                        ? 'bg-ocean text-white'
                        : 'text-muted hover:text-ink hover:bg-softer border border-transparent hover:border-line',
                    )}
                  >
                    <RoleBadge role={t.table_role} />
                    {t.display_name ?? t.table_name}
                    {t.is_reference && <span className="text-[9px] opacity-70">🔗</span>}
                    {t.row_count !== null && t.row_count > 0 && (
                      <span className={cn('text-[10px] tabular-nums', selectedTableId === t.id ? 'text-white/70' : 'text-muted-2')}>
                        {t.row_count.toLocaleString('en-GB')}
                      </span>
                    )}
                    <StatusDot
                      status={t.transformation_status}
                      title={t.transformation_status === 'error' && t.last_run_error
                        ? `Failed: ${t.last_run_error}`
                        : t.transformation_status}
                    />
                  </button>
                ))}
                {/* Add table button */}
                <button
                  onClick={() => setAddingTable(true)}
                  className="inline-flex items-center justify-center w-7 h-7 text-muted hover:text-ocean hover:bg-ocean-softer/40 rounded-md transition-colors shrink-0 border border-dashed border-line hover:border-ocean/30"
                  title="Add table"
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
                {/* Product-level view */}
                <div className="w-px h-5 bg-line shrink-0 mx-1" />
                <button
                  onClick={() => setSelectedTableId(null)}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium rounded-md whitespace-nowrap transition-colors shrink-0',
                    selectedTableId === null
                      ? 'bg-ocean/10 text-ocean border border-ocean/20'
                      : 'text-muted hover:text-ink hover:bg-softer border border-transparent hover:border-line',
                  )}
                >
                  Product
                </button>
              </div>
              {/* Inline add-table form */}
              {addingTable && (
                <div className="flex items-center gap-2 pb-2 pt-1">
                  <input
                    type="text"
                    value={newTableName}
                    onChange={(e) => setNewTableName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddTable(); if (e.key === 'Escape') setAddingTable(false); }}
                    placeholder="table_name"
                    autoFocus
                    className="px-2.5 py-1.5 text-[12px] font-mono border border-line rounded-md bg-bg focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 w-48"
                  />
                  <select
                    value={newTableRole}
                    onChange={(e) => setNewTableRole(e.target.value)}
                    className="px-2 py-1.5 text-[12px] border border-line rounded-md bg-bg focus:outline-none focus:border-ocean"
                  >
                    <option value="custom">Custom</option>
                    <option value="dimension">Dimension</option>
                    <option value="fact">Fact</option>
                  </select>
                  <button
                    onClick={handleAddTable}
                    disabled={!newTableName.trim()}
                    className="px-2.5 py-1.5 text-[11px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setAddingTable(false); setNewTableName(''); }}
                    className="px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-ink transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Selected table: show notebook */}
          {selectedTableId !== null && curator ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              {(() => {
                const t = tables.find((t) => t.id === selectedTableId);
                if (!t) return <p className="text-[13px] text-muted italic">Table not found.</p>;
                return (
                  <div>
                    <div className="flex items-center gap-3 mb-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="font-display text-[17px] text-ink tracking-[-0.01em]">{t.display_name ?? t.table_name}</h2>
                          <RoleBadge role={t.table_role} />
                          {t.is_reference && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-mono tracking-[0.1em] uppercase text-ocean bg-ocean-softer px-1.5 py-0.5 rounded">
                              🔗 shared
                            </span>
                          )}
                        </div>
                        {t.description && <p className="text-[12.5px] text-muted mt-0.5">{t.description}</p>}
                      </div>
                      <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-2">
                        {t.row_count !== null && <span>{t.row_count.toLocaleString('en-GB')} rows</span>}
                        {t.last_run_at && (
                          <span>Last run: {new Date(t.last_run_at).toLocaleDateString('en-GB')}</span>
                        )}
                        <a
                          href={`/catalog?productId=${productId}`}
                          className="text-ocean hover:underline text-[10px]"
                        >
                          View in catalog
                        </a>
                      </div>
                    </div>
                    {t.transformation_status === 'error' && t.last_run_error && (
                      <div className="rounded-md border border-err/20 bg-err-soft px-4 py-3 mb-4 flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 text-err mt-0.5 shrink-0" strokeWidth={2} />
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-medium text-err">Last refresh failed</p>
                          <p className="text-[12px] text-ink-2 mt-0.5 font-mono break-words whitespace-pre-wrap">{t.last_run_error}</p>
                        </div>
                      </div>
                    )}
                    {t.is_reference && t.owner_product_id && (
                      <div className="rounded-md border border-ocean/20 bg-ocean-softer/30 px-4 py-2.5 mb-4 flex items-center gap-2.5 text-[12.5px] text-ink-2">
                        <Network className="w-3.5 h-3.5 text-ocean shrink-0" strokeWidth={1.75} />
                        <span className="min-w-0">
                          <strong>Shared dimension</strong> · canonical definition lives in{' '}
                          <a
                            href={`/products/${t.owner_product_id}?table=${t.table_name}`}
                            className="text-ocean hover:underline"
                          >
                            {t.owner_product_name ?? 'another product'}
                          </a>
                          {'. Edits apply to every product that uses it.'}
                        </span>
                      </div>
                    )}
                    <TableNotebook
                      productTableId={t.id}
                      tableName={t.table_name}
                      readOnly={false}
                      isShared={Boolean(t.is_reference && t.owner_product_id)}
                      ownerProductName={t.owner_product_name ?? null}
                      onDeployed={loadDetail}
                    />
                  </div>
                );
              })()}
            </div>
          ) : (
            /* Product-level tabs */
            <>
              {/* SLIMMED TO DEFINITION/INSPECTION (2026-08-18): the Schema
                  diagram, Data flow, KPIs and Quality tabs duplicated the
                  topic's Manage mode — two cockpits for the same topic drift
                  apart. This panel keeps the catalog's own work (overview,
                  tables/columns/definitions, data preview, notebook cells)
                  and links to Manage mode for everything operational. */}
              <div className="border-b border-line bg-raised px-6 shrink-0 overflow-x-auto">
                <nav className="flex items-center gap-0">
                  <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')} icon={<FileText className="w-3.5 h-3.5" />}>Overview</TabBtn>
                  <TabBtn active={tab === 'tables'} onClick={() => setTab('tables')} icon={<Boxes className="w-3.5 h-3.5" />}>Tables</TabBtn>
                  {curator && (
                    <a
                      href={`/topics/${productId}?manage=1`}
                      className="flex items-center gap-1.5 px-3.5 py-2.5 text-[12px] font-mono uppercase tracking-[0.06em] text-muted hover:text-ocean transition-colors whitespace-nowrap"
                    >
                      <Gauge className="w-3.5 h-3.5" />
                      Manage this topic ↗
                    </a>
                  )}
                </nav>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                {tab === 'overview' && <OverviewSection detail={detail} kpis={kpis} tables={tables} />}
                {tab === 'tables' && (
                  <TablesSection
                    tables={tables}
                    expandedTableId={expandedTableId}
                    onToggle={(id) => setExpandedTableId(expandedTableId === id ? null : id)}
                    onOpenNotebook={(id) => setSelectedTableId(id)}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: AI chat sidebar (collapsible) */}
        {embedAskAI && aiPanelOpen && (
          <div className="hidden lg:flex w-[420px] shrink-0 flex-col border-l border-line">
            <AskAIPanel
              open={true}
              embedded={true}
              hideClose={true}
              onClose={() => { /* no-op in embedded mode */ }}
              product={detail}
              connections={connections}
              products={products}
              onRefineApplied={() => { loadDetail(); loadKpis(); }}
            />
          </div>
        )}
      </div>

      {/* Refine slide-over — single conversation per product, team-visible.
          Lives outside the main column so it doesn't fight the embedded
          AI panel for layout space. */}
      {detail && (
        <RefineChat
          productId={productId}
          productName={detail.name}
          open={refineOpen}
          onClose={() => setRefineOpen(false)}
          onApplied={() => { loadDetail(); loadKpis(); }}
        />
      )}
    </div>
  );
}

// ── Sub-sections ────────────────────────────────────────────────────────────

function TabBtn({
  active, onClick, icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-medium border-b-2 transition-colors whitespace-nowrap',
        active ? 'border-ocean text-ocean' : 'border-transparent text-muted hover:text-ink-2',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function OverviewSection({
  detail, kpis, tables,
}: {
  detail: FullDataProduct;
  kpis: ProductKpi[];
  tables: (ProductTable & { columns: ProductColumn[] })[];
}) {
  const measures = tables.flatMap((t) => t.columns.filter((c) => c.column_role === 'measure'));
  const dimensions = tables.flatMap((t) => t.columns.filter((c) => c.column_role === 'attribute' || c.column_role === 'natural_key'));
  const facts = tables.filter((t) => t.table_role === 'fact');
  const dims = tables.filter((t) => t.table_role === 'dimension');

  return (
    <div className="space-y-5 max-w-3xl">
      <Card title="What this product is for">
        {detail.description
          ? <p className="text-[13.5px] text-ink-2 leading-relaxed">{detail.description}</p>
          : <p className="text-[13px] text-muted italic">No description yet. Ask the AI on the right to write one.</p>
        }
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Tables" value={tables.length} />
        <Stat label="Facts" value={facts.length} />
        <Stat label="Dimensions" value={dims.length} />
        <Stat label="KPIs" value={kpis.length} />
      </div>

      {kpis.length > 0 && (
        <Card title={`What you can ask (${kpis.length} KPI${kpis.length === 1 ? '' : 's'})`}>
          <ul className="space-y-1.5">
            {kpis.slice(0, 8).map((k) => (
              <li key={k.id} className="text-[13px] text-ink-2 flex items-start gap-2">
                <span className="text-muted-2 mt-0.5">&middot;</span>
                <span>
                  <span className="font-medium text-ink">{k.name}</span>
                  {k.description && <span className="text-muted ml-1.5">{k.description}</span>}
                </span>
              </li>
            ))}
            {kpis.length > 8 && (
              <li className="text-[12px] text-muted">+ {kpis.length - 8} more in the KPIs tab</li>
            )}
          </ul>
        </Card>
      )}

      {(measures.length > 0 || dimensions.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {measures.length > 0 && (
            <Card title={`Measures (${measures.length})`}>
              <div className="flex flex-wrap gap-1.5">
                {measures.slice(0, 18).map((m) => (
                  <span key={m.id} className="inline-flex items-center px-2 py-0.5 rounded-sm bg-ok-soft text-ok text-[11.5px] font-mono">
                    {m.column_name}
                  </span>
                ))}
                {measures.length > 18 && <span className="text-[11px] text-muted">+{measures.length - 18} more</span>}
              </div>
            </Card>
          )}
          {dimensions.length > 0 && (
            <Card title={`Dimensions (${dimensions.length})`}>
              <div className="flex flex-wrap gap-1.5">
                {dimensions.slice(0, 18).map((d) => (
                  <span key={d.id} className="inline-flex items-center px-2 py-0.5 rounded-sm bg-softer text-ink-2 text-[11.5px] font-mono">
                    {d.column_name}
                  </span>
                ))}
                {dimensions.length > 18 && <span className="text-[11px] text-muted">+{dimensions.length - 18} more</span>}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* (The old "Tip" card claimed a chat on the right — embedAskAI is
          false at every call site, so that chat never mounted. Removed
          2026-08-27; the Refine button in the header is the real entry.) */}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-raised border border-line rounded-md overflow-hidden">
      <header className="px-4 py-2 border-b border-line bg-softer/40">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{title}</p>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-raised border border-line rounded-md px-3.5 py-2.5">
      <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">{label}</p>
      <p className="font-display text-[22px] tabular-nums text-ink leading-tight mt-0.5">{value.toLocaleString('en-GB')}</p>
    </div>
  );
}

function TablesSection({
  tables, expandedTableId, onToggle, onOpenNotebook,
}: {
  tables: (ProductTable & { columns: ProductColumn[] })[];
  expandedTableId: number | null;
  onToggle: (id: number) => void;
  onOpenNotebook?: (id: number) => void;
}) {
  if (tables.length === 0) {
    return <p className="text-[13px] text-muted italic">No tables designed yet.</p>;
  }
  return (
    <div className="bg-raised border border-line rounded-md divide-y divide-line">
      {tables.map((t) => {
        const open = expandedTableId === t.id;
        return (
          <div key={t.id}>
            <button
              onClick={() => onToggle(t.id)}
              className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-softer/40 transition-colors"
            >
              <ChevronRight className={cn('w-3.5 h-3.5 text-muted-2 transition-transform', open && 'rotate-90')} strokeWidth={2} />
              <RoleBadge role={t.table_role} />
              <div className="flex-1 min-w-0">
                <span className="text-[13.5px] font-medium text-ink">{t.display_name ?? t.table_name}</span>
                {t.description && <span className="text-[12px] text-muted ml-2">{t.description}</span>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {/* Compact change-evolution sparkline — only shown when there's
                    at least one successful refresh (avoids a "loading" state in
                    every row on mount). */}
                {t.transformation_status === 'success' && (
                  <div className="w-[120px] hidden md:block" aria-hidden>
                    <RefreshHistoryChart productTableId={t.id} variant="compact" limit={20} />
                  </div>
                )}
                {t.row_count !== null && (
                  <span className="text-[11px] text-muted-2 tabular-nums">{t.row_count.toLocaleString('en-GB')} rows</span>
                )}
                <StatusDot status={t.transformation_status} />
              </div>
            </button>
            {open && (
              <div className="px-4 pb-4 bg-softer/30 space-y-4">
                {onOpenNotebook && (
                  <button
                    onClick={() => onOpenNotebook(t.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium text-ocean border border-ocean/20 rounded-md hover:bg-ocean-softer/40 transition-colors"
                  >
                    <CodeIcon className="w-3 h-3" strokeWidth={2} />
                    Open notebook
                  </button>
                )}
                <div className="bg-raised border border-line rounded-md overflow-hidden">
                  <div className="px-3 py-2 border-b border-line bg-softer/40">
                    <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
                      Change history
                    </p>
                  </div>
                  <div className="px-4 py-3">
                    <RefreshHistoryChart productTableId={t.id} variant="full" limit={30} />
                  </div>
                </div>
                <div className="bg-raised border border-line rounded-md overflow-hidden">
                  <div className="px-3 py-2 border-b border-line bg-softer/40">
                    <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">
                      Columns ({t.columns.length})
                    </p>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {t.columns.map((c) => (
                      <div key={c.id} className="px-3 py-1.5 flex items-center gap-2 text-[12px] hover:bg-softer/60 border-b border-line last:border-0">
                        <ColumnRoleBadge role={c.column_role} />
                        <span className="font-mono text-ink">{c.column_name}</span>
                        <span className="text-muted-2">{c.data_type}</span>
                        {c.description && <span className="text-muted ml-auto truncate max-w-[40%]">{c.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RebuildBanner({
  plan, results, running, onDismiss,
}: {
  plan: Array<{ table_name: string; display_name: string; product_name?: string }>;
  results: TransformResult[] | null;
  running: boolean;
  onDismiss: () => void;
}) {
  type Row = { table_name: string; display_name: string; product_name: string; result?: TransformResult };
  const rowsByKey = new Map<string, Row>();

  for (const p of plan) {
    const product_name = p.product_name ?? '';
    const key = `${product_name}::${p.table_name}`;
    rowsByKey.set(key, { table_name: p.table_name, display_name: p.display_name, product_name });
  }

  for (const r of results ?? []) {
    const product_name = r.product_name ?? plan[0]?.product_name ?? '';
    const key = `${product_name}::${r.table_name}`;
    const existing = rowsByKey.get(key);
    if (existing) {
      existing.result = r;
    } else {
      rowsByKey.set(key, {
        table_name: r.table_name,
        display_name: r.table_name,
        product_name,
        result: r,
      });
    }
  }

  const rows = Array.from(rowsByKey.values());
  const errors = rows.filter((r) => r.result?.status === 'error');
  const successes = rows.filter((r) => r.result?.status === 'success');
  const totalRowsRebuilt = successes.reduce((s, r) => s + (r.result?.row_count ?? 0), 0);

  const productNames = Array.from(new Set(rows.map((r) => r.product_name)));
  const showProductHeaders = productNames.length > 1;

  const variantBorder = running
    ? 'border-l-ocean'
    : errors.length > 0
      ? 'border-l-err'
      : 'border-l-ok';

  return (
    <div className={cn('shrink-0 border-b border-line bg-softer/50 border-l-2', variantBorder)}>
      <div className="px-6 py-2.5 flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {running
            ? <Loader2 className="w-4 h-4 animate-spin text-ocean" />
            : errors.length > 0
              ? <AlertCircle className="w-4 h-4 text-err" strokeWidth={2} />
              : <CheckCircle2 className="w-4 h-4 text-ok" strokeWidth={2} />
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] text-ink font-medium leading-tight">
            {running
              ? `Rebuilding ${rows.length} table${rows.length === 1 ? '' : 's'}\u2026`
              : errors.length > 0
                ? `${errors.length} of ${rows.length} table${rows.length === 1 ? '' : 's'} failed`
                : `Rebuilt ${successes.length} table${successes.length === 1 ? '' : 's'}${showProductHeaders ? ` across ${productNames.length} products` : ''} \u00b7 ${totalRowsRebuilt.toLocaleString('en-GB')} rows`
            }
          </p>
          {rows.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {productNames.map((product) => {
                const productRows = rows.filter((r) => r.product_name === product);
                return (
                  <div key={product || '_default'}>
                    {showProductHeaders && product && (
                      <div className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted-2 mb-0.5">
                        {product}
                      </div>
                    )}
                    <ul className="flex flex-wrap gap-x-3 gap-y-1">
                      {productRows.map(({ table_name, display_name, result: r }) => {
                        const state = running && !r ? 'pending' : r?.status === 'success' ? 'ok' : r?.status === 'error' ? 'err' : 'pending';
                        return (
                          <li key={`${product}::${table_name}`} className="inline-flex items-center gap-1.5 text-[11.5px]">
                            {state === 'pending' && <Loader2 className="w-3 h-3 animate-spin text-muted-2" />}
                            {state === 'ok' && <CheckCircle2 className="w-3 h-3 text-ok" strokeWidth={2.25} />}
                            {state === 'err' && <AlertCircle className="w-3 h-3 text-err" strokeWidth={2.25} />}
                            <span className={cn(
                              'font-mono',
                              state === 'ok' && 'text-ink-2',
                              state === 'err' && 'text-err',
                              state === 'pending' && 'text-muted',
                            )}>{display_name}</span>
                            {r?.status === 'success' && r.row_count !== undefined && (
                              <span className="text-muted-2 tabular-nums">({r.row_count.toLocaleString('en-GB')})</span>
                            )}
                            {r?.status === 'error' && r.error && (
                              <span className="text-err/80 truncate max-w-[280px]" title={r.error}>{r.error}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!running && (
          <button
            onClick={onDismiss}
            className="shrink-0 p-1 rounded hover:bg-soft text-muted hover:text-ink-2 transition-colors"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

// `SchemaSection`, `LineageSection`, `KpisSection` and the Quality tab were
// removed on 2026-08-18: they duplicated the topic's Manage mode (How it
// fits together / Where it comes from / Metrics / Quality). The tab bar
// links there instead — one cockpit per topic.

