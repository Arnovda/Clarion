'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Database, X, ChevronRight, Plus, RefreshCw, ChevronDown, Wrench } from 'lucide-react';
import SourceBadge, { productSourceGroupKey, productSourceGroupLabel } from '@/components/SourceBadge';
import api from '@/lib/api';
import { getToken } from '@/lib/auth';
import RequireRole from '@/components/RequireRole';
import dynamic from 'next/dynamic';
const QualityTab = dynamic(() => import('./QualityTab'), { ssr: false });
import type {
  Connection,
  DataProduct,
  StarSchema,
  QualityCheck,
  ProductTable,
  ProductColumn,
  ProductRelationship,
  FullDataProduct,
  ProductKpi,
  ActiveTab,
} from './types';
import { StatusDot, StatusBadge, RoleBadge, ColumnRoleBadge, Spinner, ProductIcon } from './badges';
import { statusBorderColor, cleanTopicName } from './helpers';
import BuildDashboard from '@/components/build/BuildDashboard';

const AskAIPanel = dynamic(() => import('./AskAIPanel'), { ssr: false });

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function ProductsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Initialise from URL so deep-links like /products?tab=quality (used by
  // the Home Quality card) land on the right tab. Validates against the
  // small allow-list to keep an unknown value from breaking the render.
  const initialTab: ActiveTab = (() => {
    const raw = searchParams.get('tab');
    if (raw === 'quality' || raw === 'bus-matrix' || raw === 'overview') return raw;
    return 'overview';
  })();
  const [tab, setTab] = useState<ActiveTab>(initialTab);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [loading, setLoading] = useState(true);

  // Full product details cache: productId -> FullDataProduct
  const [details, setDetails] = useState<Map<number, FullDataProduct>>(new Map());

  // Card click -> slide-over detail panel
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);

  // Ask AI panel state — { open, productId? } where productId === null means general/cross-product
  const [askOpen, setAskOpen] = useState(false);
  const [askProductId, setAskProductId] = useState<number | null>(null);

  // Accordion state (used inside slide-over)
  const [expandedTableId, setExpandedTableId] = useState<number | null>(null);

  // Build terminal state
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [buildThinking, setBuildThinking] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [buildConnId, setBuildConnId] = useState<number | null>(null);
  const [buildDone, setBuildDone] = useState(false);
  const [buildSuccess, setBuildSuccess] = useState(false);
  const [buildJobId, setBuildJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const buildTermRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const buildAbortRef = useRef<AbortController | null>(null);

  // Table action state
  const [runningTableId, setRunningTableId] = useState<number | null>(null);
  const [runningProductId, setRunningProductId] = useState<number | null>(null);
  const [editingSql, setEditingSql] = useState<{ tableId: number; sql: string } | null>(null);
  const [savingSql, setSavingSql] = useState(false);

  // KPI state
  const [kpis, setKpis] = useState<Map<number, ProductKpi[]>>(new Map());

  // Source filter chip — null means "All sources" (grouped sections render).
  // String keys mirror `productSourceGroupKey` so URL/persistence is shared
  // with /catalog and any future surface that filters by source.
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  // ----------- Data loading -----------

  const loadProducts = useCallback(async () => {
    try {
      const res = await api.get('/products');
      setProducts(res.data.data ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const res = await api.get('/connections');
      setConnections(res.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadProducts();
    loadConnections();
  }, [loadProducts, loadConnections]);

  const loadFullProduct = useCallback(async (id: number) => {
    try {
      const res = await api.get(`/products/${id}`);
      const data = res.data.data as FullDataProduct;
      if (data) {
        setDetails((prev) => new Map(prev).set(id, data));
      }
    } catch { /* ignore */ }
  }, []);

  const loadKpis = useCallback(async (productId: number) => {
    try {
      const res = await api.get(`/products/${productId}/kpis`);
      setKpis((prev) => new Map(prev).set(productId, res.data.data ?? []));
    } catch { /* ignore */ }
  }, []);

  // Auto-load details + KPIs for all products
  useEffect(() => {
    if (products.length > 0) {
      products.forEach((p) => {
        if (!details.has(p.id)) loadFullProduct(p.id);
        if (!kpis.has(p.id)) loadKpis(p.id);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.length, loadFullProduct, loadKpis]);

  const openProduct = useCallback((id: number) => {
    router.push(`/products/${id}`);
  }, [router]);

  // ----------- Bus Matrix Auto-Build (SSE) -----------

  const addBuildLog = useCallback((msg: string) => {
    setBuildLog((prev) => [...prev, msg]);
    setTimeout(() => {
      if (buildTermRef.current) buildTermRef.current.scrollTop = buildTermRef.current.scrollHeight;
    }, 20);
  }, []);

  // Subscribe to a running bus-matrix job. Pulls events from the backend's
  // SSE-tail-of-job-log endpoint so closing the browser doesn't interrupt
  // the work — only the live view of it.
  const attachToJob = useCallback(async (jobId: string) => {
    setBuildJobId(jobId);
    localStorage.setItem('busMatrixJobId', jobId);

    const token = getToken();
    const abortController = new AbortController();
    buildAbortRef.current = abortController;

    try {
      const response = await fetch(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
        method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: abortController.signal,
      });

      if (!response.ok) {
        addBuildLog(`Error: stream returned ${response.status}`);
        setBuildDone(true);
        setBuilding(false);
        localStorage.removeItem('busMatrixJobId');
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let allOk = true;

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });

        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; }
          catch { continue; }

          const type = event.type as string;

          if (type === 'phase') {
            addBuildLog(event.text as string);
          } else if (type === 'thinking') {
            setBuildThinking((prev) => prev + (event.text as string));
            setTimeout(() => {
              if (thinkingRef.current) thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight;
            }, 10);
          } else if (type === 'diag') {
            addBuildLog(`[diag] ${event.text as string}`);
          } else if (type === 'log') {
            addBuildLog(event.text as string);
          } else if (type === 'product') {
            const status = event.status as string;
            const name = event.productName as string;
            const text = event.text as string;
            addBuildLog(`  "${name}": ${text}`);
            if (status !== 'ok') allOk = false;
          } else if (type === 'error_detail') {
            // Per-failed-table error — surfaces WHICH table failed and WHY,
            // so the user has something actionable instead of just a count.
            const tbl = event.tableName as string;
            const errMsg = event.error as string;
            addBuildLog(`    ✗ ${tbl}: ${errMsg}`);
            allOk = false;
          } else if (type === 'done') {
            // orchestrator's own "done" — superseded by 'completed' below, but log it
            if (event.text) addBuildLog(event.text as string);
          } else if (type === 'completed') {
            const result = event.result as { allOk?: boolean } | null;
            if (result && typeof result.allOk === 'boolean') allOk = result.allOk;
            setBuildSuccess(allOk);
            setBuildDone(true);
            setBuilding(false);
            localStorage.removeItem('busMatrixJobId');

            // Refresh product list
            setDetails(new Map());
            setKpis(new Map());
            await loadProducts();
          } else if (type === 'failed') {
            const msg = event.error as string;
            const cancelled = msg && /cancel/i.test(msg);
            addBuildLog(cancelled ? 'Cancelled.' : `Error: ${msg}`);
            setBuildSuccess(false);
            setBuildDone(true);
            setBuilding(false);
            localStorage.removeItem('busMatrixJobId');
            await loadProducts();
          } else if (type === 'error') {
            addBuildLog(`Error: ${event.message as string}`);
            setBuildDone(true);
            setBuilding(false);
            localStorage.removeItem('busMatrixJobId');
          }
        }
        if (done) break;
      }
    } catch (err) {
      // AbortError means the user navigated away or cancelled — work continues server-side.
      if ((err as { name?: string })?.name !== 'AbortError') {
        addBuildLog(`Stream error: ${(err as Error)?.message ?? 'unknown'}`);
        setBuildDone(true);
        setBuilding(false);
      }
    } finally {
      buildAbortRef.current = null;
    }
  }, [addBuildLog, loadProducts]);

  // ── Per-product refresh ──────────────────────────────────────────────
  // Enqueues a 'refresh' bus-matrix job (same queue, different mode) so
  // the existing SSE / cancel / active-job endpoints work unchanged.
  // syncSource=true triggers the source connection sync first; the worker
  // waits for sync completion before running the product's transformations.
  const [refreshMenuFor, setRefreshMenuFor] = useState<number | null>(null);
  const handleRefreshProduct = useCallback(async (productId: number, productName: string, syncSource: boolean) => {
    setRefreshMenuFor(null);
    setBuilding(true);
    setBuildDone(false);
    setBuildSuccess(false);
    setBuildLog([]);
    setBuildThinking('');
    setShowThinking(false);
    setBuildJobId(null);

    addBuildLog(syncSource
      ? `Refreshing "${productName}" (syncing source first)…`
      : `Refreshing "${productName}"…`);

    try {
      const res = await api.post(`/products/${productId}/refresh-start`, { syncSource });
      const jobId = res.data?.data?.jobId as string | undefined;
      if (!jobId) {
        addBuildLog('Error: server did not return a jobId');
        setBuildDone(true);
        setBuilding(false);
        return;
      }
      addBuildLog(`Job ${jobId} started — running on the server (safe to close this tab).`);
      await attachToJob(jobId);
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; jobId?: string } }; message?: string };
      const existingJobId = ax?.response?.data?.jobId;
      if (existingJobId) {
        addBuildLog(`Reattaching to running job ${existingJobId}…`);
        await attachToJob(existingJobId);
        return;
      }
      addBuildLog(`Error: ${ax?.response?.data?.error ?? ax?.message ?? 'Failed to start refresh'}`);
      setBuildDone(true);
      setBuilding(false);
    }
  }, [addBuildLog, attachToJob]);

  const handleAutoBuild = useCallback(async (connectionId: number) => {
    setBuilding(true);
    setBuildDone(false);
    setBuildSuccess(false);
    setBuildLog([]);
    setBuildThinking('');
    setShowThinking(false);
    setBuildConnId(connectionId);
    setBuildJobId(null);

    const connName = connections.find((c) => c.id === connectionId)?.name ?? `Connection #${connectionId}`;
    addBuildLog(`Starting bus matrix design for "${connName}"...`);

    try {
      const startRes = await api.post('/products/bus-matrix/start', { connectionId });
      const jobId = startRes.data?.data?.jobId as string | undefined;
      if (!jobId) {
        addBuildLog('Error: server did not return a jobId');
        setBuildDone(true);
        setBuilding(false);
        return;
      }
      addBuildLog(`Job ${jobId} started — running on the server (safe to close this tab).`);
      await attachToJob(jobId);
    } catch (err) {
      const axiosErr = err as { response?: { data?: { error?: string; jobId?: string } }; message?: string };
      const serverError = axiosErr?.response?.data?.error;
      const existingJobId = axiosErr?.response?.data?.jobId;
      if (existingJobId) {
        addBuildLog(`Reattaching to running job ${existingJobId}…`);
        await attachToJob(existingJobId);
        return;
      }
      addBuildLog(`Error: ${serverError ?? axiosErr?.message ?? 'Failed to start build'}`);
      setBuildDone(true);
      setBuilding(false);
    }
  }, [connections, addBuildLog, attachToJob]);

  const handleCancelBuild = useCallback(async () => {
    if (!buildJobId) return;
    setCancelling(true);
    addBuildLog('Cancelling…');
    try {
      const res = await api.post(`/products/bus-matrix/${buildJobId}/cancel`);
      const message = res.data?.data?.message as string | undefined;
      if (message) addBuildLog(message);
    } catch (err) {
      const axiosErr = err as { response?: { data?: { error?: string } }; message?: string };
      addBuildLog(`Cancel failed: ${axiosErr?.response?.data?.error ?? axiosErr?.message ?? 'unknown'}`);
    }
    setCancelling(false);
  }, [buildJobId, addBuildLog]);

  // On mount: reattach to any active job for this user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = typeof window !== 'undefined' ? localStorage.getItem('busMatrixJobId') : null;
        const res = await api.get('/products/bus-matrix/active');
        const active = res.data?.data as { jobId?: string; connectionId?: number; state?: string } | null;
        if (cancelled) return;
        if (active?.jobId) {
          setBuilding(true);
          setBuildDone(false);
          setBuildSuccess(false);
          setBuildLog([`Reattached to running job ${active.jobId} (state: ${active.state ?? 'unknown'})…`]);
          setBuildThinking('');
          setBuildConnId(active.connectionId ?? null);
          await attachToJob(active.jobId);
        } else if (stored) {
          // Job finished server-side while we were away — nothing live to attach to.
          localStorage.removeItem('busMatrixJobId');
        }
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
      if (buildAbortRef.current) {
        try { buildAbortRef.current.abort(); } catch { /* ignore */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------- Table actions -----------

  const handleRunTable = async (tableId: number, productId: number) => {
    setRunningTableId(tableId);
    try {
      await api.post(`/products/tables/${tableId}/run`);
      await loadFullProduct(productId);
    } catch { /* ignore */ }
    setRunningTableId(null);
  };

  const handleRunProduct = async (productId: number) => {
    setRunningProductId(productId);
    try {
      await api.post(`/products/${productId}/run`);
      await loadFullProduct(productId);
    } catch { /* ignore */ }
    setRunningProductId(null);
  };

  const handleSaveSql = async () => {
    if (!editingSql) return;
    setSavingSql(true);
    try {
      await api.put(`/products/tables/${editingSql.tableId}/sql`, { sql: editingSql.sql });
      setEditingSql(null);
      if (selectedProductId) await loadFullProduct(selectedProductId);
    } catch { /* ignore */ }
    setSavingSql(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this data product and all its tables?')) return;
    try {
      await api.delete(`/products/${id}`);
      if (selectedProductId === id) { setSelectedProductId(null); setExpandedTableId(null); }
      setDetails((prev) => { const next = new Map(prev); next.delete(id); return next; });
      await loadProducts();
    } catch { /* ignore */ }
  };

  // ----------- Helpers -----------

  const getAllTables = (product: FullDataProduct): (ProductTable & { columns: ProductColumn[] })[] =>
    product.star_schemas
      .flatMap((s) => s.tables)
      .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name));

  const totalRows = (product: FullDataProduct): number =>
    getAllTables(product).reduce((sum, t) => sum + (t.row_count ?? 0), 0);

  // Tab bar items
  const tabs: { key: ActiveTab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'bus-matrix', label: 'Data tables' },
    { key: 'quality', label: 'Quality' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="bg-raised border-b border-line px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Products</p>
          <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em]">Organized data</h1>
        </div>
        <div className="flex items-center gap-2">
          {products.length > 0 && (
            <button
              onClick={() => { setAskProductId(null); setAskOpen(true); }}
              className="group px-3 py-2 text-[13px] font-medium rounded-md border border-line text-ink-2 hover:border-ocean hover:text-ocean hover:bg-ocean-softer/40 transition-colors flex items-center gap-1.5"
              aria-label="Refine products with AI"
            >
              <Wrench className="w-3.5 h-3.5 text-ocean group-hover:ai-sparkle" strokeWidth={1.75} />
              Refine
            </button>
          )}
          {connections.length > 1 && (
            <select
              value={buildConnId ?? ''}
              onChange={(e) => setBuildConnId(Number(e.target.value))}
              className="text-[13px] bg-raised border border-line text-ink-2 rounded-md px-3 py-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
            >
              <option value="">Select connection…</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          {connections.length > 0 && (
            <button
              onClick={() => {
                const connId = connections.length === 1 ? connections[0].id : buildConnId;
                if (connId) handleAutoBuild(connId);
              }}
              disabled={building || (connections.length > 1 && !buildConnId)}
              className="px-4 py-2 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {building && <Spinner />}
              {building ? 'Building…' : 'Prepare my data'}
            </button>
          )}
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────────── */}
      <div className="bg-raised border-b border-line px-6 flex-shrink-0">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-3 text-[13px] transition-colors relative ${
                tab === t.key
                  ? 'text-ink font-medium'
                  : 'text-muted hover:text-ink-2'
              }`}
            >
              {t.label}
              {tab === t.key && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-bg">
        <div className="p-6 max-w-5xl mx-auto">

          {/* ── Build Terminal ──────────────────────────────────────── */}
          {(building || buildDone) && (
            <div className="mb-6 bg-ink rounded-lg border border-line overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
                <div className="flex items-center gap-3">
                  {building ? (
                    <div className="w-2 h-2 bg-ok rounded-full animate-pulse" />
                  ) : buildSuccess ? (
                    <span className="text-ok text-[10px] font-mono tracking-[0.08em] uppercase">OK</span>
                  ) : (
                    <span className="text-err text-[10px] font-mono tracking-[0.08em] uppercase">Error</span>
                  )}
                  <span className="text-[13px] font-medium text-white">
                    {building ? 'Preparing your data…' : buildSuccess ? 'Your data warehouse is ready' : 'Build completed with errors'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {buildThinking && (
                    <button
                      onClick={() => setShowThinking((v) => !v)}
                      className="text-[11px] font-mono tracking-[0.08em] uppercase text-white/60 hover:text-white/90 transition-colors"
                    >
                      {showThinking ? 'Hide' : 'Show'} reasoning
                    </button>
                  )}
                  {building && buildJobId && (
                    <button
                      onClick={handleCancelBuild}
                      disabled={cancelling}
                      className="text-[11px] font-mono tracking-[0.08em] uppercase text-err/80 hover:text-err transition-colors disabled:opacity-50"
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                  {buildDone && (
                    <button
                      onClick={() => { setBuildDone(false); setBuildLog([]); setBuildThinking(''); }}
                      className="text-[11px] font-mono tracking-[0.08em] uppercase text-white/60 hover:text-white/90 transition-colors"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>

              {showThinking && buildThinking && (
                <div ref={thinkingRef} className="px-5 py-3 max-h-48 overflow-y-auto border-b border-white/10">
                  <pre className="text-[11px] text-white/70 font-mono whitespace-pre-wrap leading-relaxed">{buildThinking}</pre>
                </div>
              )}

              <div ref={buildTermRef} className="px-5 py-3 max-h-64 overflow-y-auto">
                {buildLog.map((line, i) => (
                  <div key={i} className={`text-[12px] font-mono py-0.5 ${
                    // Per-failed-table errors emitted as `    ✗ table: msg`
                    line.startsWith('    ✗') ? 'text-err font-medium'
                    : line.startsWith('Error') ? 'text-err'
                    : line.startsWith('All done') ? 'text-ok'
                    : line.startsWith('  ') ? 'text-white/50'
                    : 'text-white/80'
                  }`}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Overview Tab ─────────── */}
          {tab === 'overview' && (
            <>
              {/* Phase 5: workshop-style dashboard. The legacy card grid
                  + filter chips + grouped sections were removed when
                  /products became the dedicated Build surface (Catalog
                  owns discovery now). BuildDashboard pulls everything
                  from /api/build/dashboard in one round-trip and renders
                  status tiles, AI suggestions, a list of products with
                  derived status, and recent activity. */}
              <BuildDashboard
                onDesignNew={() => {
                  const connId = connections.length === 1 ? connections[0].id : buildConnId;
                  if (connId) handleAutoBuild(connId);
                }}
                onRefreshProduct={handleRefreshProduct}
              />
            </>
          )}

          {/* ── Facts & Dimensions Tab ─────────────────────────────── */}
          {tab === 'bus-matrix' && (
            <BusMatrixTab products={products} details={details} onLoadProduct={loadFullProduct} />
          )}

          {/* ── Quality Tab ────────────────────────────────────────────
              Sorts product tables by score (worst first) so users can
              act on the lowest-quality items first. The "Worth your
              attention" feed on Home now lands here via /products?tab=quality. */}
          {tab === 'quality' && <QualityTab />}
        </div>
      </div>

      {/* ── Ask AI side panel ────────────────────────────────────────── */}
      <AskAIPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        product={askProductId !== null ? (products.find((p) => p.id === askProductId) ?? null) : null}
        connections={connections}
        products={products}
        onRefineApplied={() => { loadProducts(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slide-over detail panel (appears when a product card is clicked)
// ---------------------------------------------------------------------------

function TopicSlideOver({
  product, detail, productKpis, expandedTableId, onToggleTable,
  runningTableId, runningProductId, editingSql, savingSql,
  onRunTable, onRunProduct, onEditSql, onSaveSql, onCancelEditSql,
  onDelete, onClose, getAllTables, totalRows,
}: {
  product: DataProduct;
  detail: FullDataProduct | undefined;
  productKpis: ProductKpi[];
  expandedTableId: number | null;
  onToggleTable: (id: number) => void;
  runningTableId: number | null;
  runningProductId: number | null;
  editingSql: { tableId: number; sql: string } | null;
  savingSql: boolean;
  onRunTable: (tableId: number, productId: number) => void;
  onRunProduct: (productId: number) => void;
  onEditSql: (v: { tableId: number; sql: string }) => void;
  onSaveSql: () => void;
  onCancelEditSql: () => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  getAllTables: (p: FullDataProduct) => (ProductTable & { columns: ProductColumn[] })[];
  totalRows: (p: FullDataProduct) => number;
}) {
  const tables = detail ? getAllTables(detail) : [];
  const name = cleanTopicName(product.name);
  const isRunning = runningProductId === product.id;
  const [showSqlModal, setShowSqlModal] = useState(false);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-[480px] bg-surface-container-lowest/95 backdrop-blur-xl shadow-ambient-lg z-50 flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="px-6 py-5 border-b border-line flex items-start gap-4 flex-shrink-0">
          <div className="w-12 h-12 rounded-xl bg-ocean-softer flex items-center justify-center flex-shrink-0 text-ocean">
            <ProductIcon product={product} className="w-7 h-7" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-on-surface truncate">{name}</h2>
              <StatusBadge status={product.status} />
            </div>
            {product.description && (
              <p className="text-sm text-on-surface-variant mt-0.5 line-clamp-2">{product.description}</p>
            )}
            {detail && (
              <p className="text-xs text-on-surface-variant/50 mt-1">
                {tables.length} tables{totalRows(detail) > 0 ? ` · ${totalRows(detail).toLocaleString()} rows` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-on-surface-variant/50 hover:text-on-surface transition-colors flex-shrink-0 mt-1">
            <X className="w-5 h-5" strokeWidth={2} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* KPIs section */}
          {productKpis.length > 0 && (
            <div className="px-6 py-4 border-b border-line">
              <p className="text-[10px] font-semibold text-on-surface-variant/50 uppercase tracking-wider mb-2">What you can ask</p>
              <div className="space-y-1.5">
                {productKpis.map((kpi) => (
                  <div key={kpi.id} className="flex items-start gap-2 text-sm">
                    <span className="text-on-surface-variant/30 mt-0.5">-</span>
                    <div className="min-w-0">
                      <span className="font-medium text-on-surface">{kpi.name}</span>
                      {kpi.description && <span className="text-on-surface-variant ml-1.5 text-xs">{kpi.description}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tables list */}
          {!detail ? (
            <div className="px-6 py-10 text-center">
              <Spinner className="mx-auto mb-2" />
              <p className="text-sm text-muted-2">Loading tables...</p>
            </div>
          ) : tables.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-2">No tables designed yet.</div>
          ) : (
            <div className="divide-y divide-slate-200/20">
              {tables.map((table) => {
                const isTableExpanded = expandedTableId === table.id;
                const isTableRunning = runningTableId === table.id;

                return (
                  <div key={table.id}>
                    <button
                      onClick={() => onToggleTable(table.id)}
                      className="w-full text-left px-6 py-3 flex items-center gap-3 hover:bg-surface-container-low/50 transition-colors"
                    >
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-on-surface-variant/30 transition-transform flex-shrink-0 ${isTableExpanded ? 'rotate-90' : ''}`}
                        strokeWidth={2}
                      />
                      <RoleBadge role={table.table_role} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-on-surface">{table.display_name ?? table.table_name}</span>
                        {table.description && (
                          <span className="text-xs text-on-surface-variant ml-2 hidden sm:inline">{table.description}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        {table.row_count !== null && (
                          <span className="text-xs text-on-surface-variant/50">{table.row_count.toLocaleString()} rows</span>
                        )}
                        <StatusDot status={table.transformation_status} />
                        {isTableRunning && <Spinner className="w-3.5 h-3.5" />}
                      </div>
                    </button>

                    {isTableExpanded && (
                      <div className="px-6 pb-4 bg-surface-container-low/20 panel-enter">
                        {/* Columns */}
                        <div className="bg-raised border border-line rounded-md overflow-hidden mb-3">
                          <div className="px-4 py-2.5 border-b border-line">
                            <span className="text-[10px] font-semibold text-on-surface-variant/50 uppercase tracking-wider">
                              Columns ({table.columns.length})
                            </span>
                          </div>
                          <div className="max-h-56 overflow-y-auto">
                            {table.columns.map((col) => (
                              <div key={col.id} className="px-4 py-1.5 flex items-center gap-2 text-xs hover:bg-white/40 border-b border-slate-200/20 last:border-0 transition-colors">
                                <ColumnRoleBadge role={col.column_role} />
                                <span className="font-medium text-on-surface">{col.column_name}</span>
                                <span className="text-on-surface-variant/40">{col.data_type}</span>
                                {col.description && <span className="text-on-surface-variant truncate ml-auto">{col.description}</span>}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* SQL */}
                        <div className="bg-raised border border-line rounded-md overflow-hidden mb-3">
                          <div className="px-4 py-2.5 border-b border-line flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-on-surface-variant/50 uppercase tracking-wider">SQL</span>
                            <div className="flex gap-2">
                              {editingSql?.tableId !== table.id && table.transformation_sql && (
                                <button onClick={() => onEditSql({ tableId: table.id, sql: table.transformation_sql! })}
                                  className="text-[11px] text-ocean hover:text-ocean-hover font-semibold transition-colors">Edit</button>
                              )}
                              <button
                                onClick={() => onRunTable(table.id, product.id)}
                                disabled={isTableRunning || !table.transformation_sql}
                                className="text-[11px] text-ok hover:text-ok/80 font-semibold disabled:opacity-50 flex items-center gap-1 transition-colors"
                              >
                                {isTableRunning && <Spinner className="w-3 h-3" />}
                                {isTableRunning ? 'Running...' : 'Run'}
                              </button>
                            </div>
                          </div>
                          {editingSql?.tableId === table.id ? (
                            <div className="p-3">
                              <textarea
                                value={editingSql.sql}
                                onChange={(e) => onEditSql({ ...editingSql, sql: e.target.value })}
                                rows={Math.max(8, editingSql.sql.split('\n').length + 2)}
                                className="w-full font-mono text-xs bg-white/60 border border-white/80 rounded-xl p-3 resize-y focus:ring-2 focus:ring-cyan-400/30 focus:border-cyan-300 transition-all"
                              />
                              <div className="flex gap-2 mt-2">
                                <button onClick={onSaveSql} disabled={savingSql}
                                  className="px-3 py-1.5 text-xs bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 font-medium">
                                  {savingSql ? 'Saving...' : 'Save'}
                                </button>
                                <button onClick={onCancelEditSql}
                                  className="px-3 py-1.5 text-xs text-on-surface-variant bg-white/60 border border-white/80 rounded-lg hover:bg-white/80 transition-all">Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <pre className="p-3 text-xs font-mono text-on-surface-variant bg-surface-container-low/30 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                              {table.transformation_sql || 'No SQL generated yet'}
                            </pre>
                          )}
                        </div>

                        {/* Run info + quality checks */}
                        {(table.last_run_at || table.last_run_error) && (
                          <div className="text-xs text-muted px-1 mb-2">
                            {table.last_run_at && <span>Last run: {new Date(table.last_run_at).toLocaleString()}</span>}
                            {table.last_run_error && <span className="text-err ml-3">{table.last_run_error}</span>}
                          </div>
                        )}
                        {table.quality_checks && table.quality_checks.length > 0 && (
                          <div className="space-y-1">
                            {table.quality_checks.map((chk) => (
                              <div key={chk.id} className="flex items-center gap-2 text-xs">
                                <StatusDot status={chk.status === 'pass' ? 'success' : chk.status === 'fail' ? 'error' : 'draft'} />
                                <span className={chk.status === 'pass' ? 'text-ok' : chk.status === 'fail' ? 'text-err' : 'text-muted'}>
                                  {chk.check_type === 'bk_uniqueness' ? 'Key uniqueness' : 'Fan-out'}: {chk.message}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-shrink-0 bg-white/60 backdrop-blur-xl border-t border-white/60">
          <div className="flex gap-2">
            <a href={`/query?connectionId=${product.connection_id}&productId=${product.id}&productName=${encodeURIComponent(cleanTopicName(product.name))}`} className="px-4 py-2 text-[13px] font-medium text-ocean bg-ocean-softer border border-line rounded-md hover:bg-ocean-soft transition-colors">
              Ask questions &rarr;
            </a>
            {tables.length > 0 && (
              <button
                onClick={() => setShowSqlModal(true)}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-white/60 border border-white/80 rounded-xl hover:bg-white/80 transition-colors"
              >
                View all SQL
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onRunProduct(product.id)}
              disabled={isRunning || tables.length === 0}
              className="px-4 py-2 text-sm font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 flex items-center gap-1.5 transition-all"
            >
              {isRunning && <Spinner className="w-3 h-3" />}
              {isRunning ? 'Running...' : 'Rebuild'}
            </button>
            <button
              onClick={() => onDelete(product.id)}
              className="px-4 py-2 text-sm font-medium text-err bg-err/10 border border-red-500/20 rounded-xl hover:bg-err/20 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* SQL Modal */}
      {showSqlModal && detail && (
        <TopicSqlModal tables={tables} productName={name} onClose={() => setShowSqlModal(false)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Full SQL modal (shows all transformation SQL for a product)
// ---------------------------------------------------------------------------

function TopicSqlModal({
  tables, productName, onClose,
}: {
  tables: (ProductTable & { columns: ProductColumn[] })[];
  productName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<number | null>(null);

  const handleCopy = (sql: string, id: number) => {
    navigator.clipboard.writeText(sql);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-raised border border-line rounded-lg shadow-ambient-lg w-full max-w-4xl max-h-[80vh] flex flex-col">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-bold text-on-surface">All SQL — {productName}</h3>
          <button onClick={onClose} className="text-muted hover:text-ink-2 transition-colors">
            <X className="w-5 h-5" strokeWidth={2} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {tables.filter((t) => t.transformation_sql).map((table) => (
            <div key={table.id} className="preview-terminal rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 flex items-center justify-between border-b border-white/10">
                <div className="flex items-center gap-2">
                  <RoleBadge role={table.table_role} />
                  <span className="text-sm font-medium text-white/90">{table.display_name ?? table.table_name}</span>
                </div>
                <button
                  onClick={() => handleCopy(table.transformation_sql!, table.id)}
                  className="text-xs text-white/70 hover:text-white/90 font-medium transition-colors"
                >
                  {copied === table.id ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono text-white/80 overflow-x-auto whitespace-pre-wrap">
                {table.transformation_sql}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bus Matrix Tab — all facts & dimensions across products
// ---------------------------------------------------------------------------

function BusMatrixTab({
  products, details, onLoadProduct,
}: {
  products: DataProduct[];
  details: Map<number, FullDataProduct>;
  onLoadProduct: (id: number) => void;
}) {
  useEffect(() => {
    products.forEach((p) => { if (!details.has(p.id)) onLoadProduct(p.id); });
  }, [products, details, onLoadProduct]);

  type DimEntry = { product: DataProduct; table: ProductTable & { columns: ProductColumn[] }; schema: StarSchema };
  type FactEntry = { product: DataProduct; table: ProductTable & { columns: ProductColumn[] }; schema: StarSchema };

  // Collect all tables across all products
  const allDimensionEntries: DimEntry[] = [];
  const allFactEntries: FactEntry[] = [];

  products.forEach((p) => {
    const detail = details.get(p.id);
    if (!detail) return;
    detail.star_schemas.forEach((s) => {
      s.tables.forEach((t) => {
        const entry = { product: p, table: t, schema: s };
        if (t.table_role === 'dimension') allDimensionEntries.push(entry);
        else if (t.table_role === 'fact') allFactEntries.push(entry);
      });
    });
  });

  // Deduplicate dimensions by table_name — pick the one with the most columns (richest definition)
  const dimByName = new Map<string, { best: DimEntry; products: Set<string> }>();
  allDimensionEntries.forEach((d) => {
    const name = d.table.table_name;
    const existing = dimByName.get(name);
    if (!existing) {
      dimByName.set(name, { best: d, products: new Set([cleanTopicName(d.product.name)]) });
    } else {
      existing.products.add(cleanTopicName(d.product.name));
      if (d.table.columns.length > existing.best.table.columns.length) {
        existing.best = d;
      }
    }
  });
  const uniqueDimensions = [...dimByName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { best, products: prods }]) => ({ name, ...best, usedByProducts: [...prods].sort() }));

  // Lookup map: clean topic name → product (for icon rendering in chips/badges).
  const productByCleanName = new Map<string, DataProduct>();
  products.forEach((p) => { productByCleanName.set(cleanTopicName(p.name), p); });

  // Build the bus matrix: deduplicated dimension names as columns
  const dimensionNames = uniqueDimensions.map((d) => d.name);

  // For each fact, figure out which dimensions it references via:
  // 1. Explicit relationships (from_table_name -> to_table_name)
  // 2. FK columns (column_role === 'foreign_key' with fk_target_table)
  // 3. Column name heuristic (columns ending in _key matching dim table names)
  const factRows = allFactEntries.map((f) => {
    const detail = details.get(f.product.id);
    const usedDims = new Set<string>();

    // Method 1: explicit relationships
    const rels = detail?.star_schemas.flatMap((s) => s.relationships) ?? [];
    rels.filter((r) => r.from_table_name === f.table.table_name).forEach((r) => usedDims.add(r.to_table_name));

    // Method 2: FK columns with fk_target_table
    f.table.columns.forEach((col) => {
      if (col.fk_target_table) usedDims.add(col.fk_target_table);
    });

    // Method 3: columns with column_role 'foreign_key' — match to dimension table names in same product
    const productDimNames = new Set(
      detail?.star_schemas.flatMap((s) => s.tables.filter((t) => t.table_role === 'dimension').map((t) => t.table_name)) ?? [],
    );
    f.table.columns.forEach((col) => {
      if (col.column_role === 'foreign_key' && !col.fk_target_table) {
        // Try to match column name to a dimension: e.g. "customer_key" -> "dim_customer"
        const colBase = col.column_name.replace(/_key$|_id$|_fk$/, '');
        productDimNames.forEach((dimName) => {
          if (dimName.replace(/^dim_/, '') === colBase) usedDims.add(dimName);
        });
      }
    });

    return { ...f, usedDims };
  });

  const loaded = products.every((p) => details.has(p.id));

  return (
    <div className="space-y-8">
      {/* Bus matrix grid */}
      {dimensionNames.length > 0 && factRows.length > 0 && (
        <div className="bg-raised border border-line rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-line">
            <h3 className="text-sm font-bold text-on-surface">Coverage Map</h3>
            <p className="text-xs text-on-surface-variant mt-0.5">Which reference tables are shared across your transaction data</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-container border-b border-line">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-on-surface-variant sticky left-0 bg-surface-container min-w-[200px]">Transaction Table</th>
                  <th className="text-left px-3 py-3 text-xs font-semibold text-on-surface-variant min-w-[100px]">Product</th>
                  {dimensionNames.map((dim) => (
                    <th key={dim} className="text-center px-2 py-3 text-[11px] font-semibold text-on-surface-variant min-w-[80px]">
                      <span className="writing-mode-vertical inline-block max-w-[80px] truncate" title={dim}>
                        {dim.replace(/^dim_/, '').replace(/_/g, ' ')}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {factRows.map((row) => (
                  <tr key={`${row.product.id}-${row.table.id}`} className="border-b border-white/40 hover:bg-white/40 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-on-surface sticky left-0 bg-white/72">
                      <div className="flex items-center gap-2">
                        <span>{row.table.display_name ?? row.table.table_name.replace(/^fact_/, '').replace(/_/g, ' ')}</span>
                        <StatusDot status={row.table.transformation_status} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-on-surface-variant">
                      <div className="flex flex-col gap-0.5">
                        <span className="inline-flex items-center gap-1.5">
                          <ProductIcon product={row.product} className="w-3.5 h-3.5 text-ocean" />
                          <span>{cleanTopicName(row.product.name)}</span>
                        </span>
                        {row.product.source?.name && (
                          <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-muted-2 ml-5">
                            {row.product.source.name}
                          </span>
                        )}
                      </div>
                    </td>
                    {dimensionNames.map((dim) => (
                      <td key={dim} className="text-center px-2 py-2.5">
                        {row.usedDims.has(dim) ? (
                          <span className="inline-block w-5 h-5 rounded-full bg-ok-soft text-ok text-xs leading-5 font-bold">&#10003;</span>
                        ) : (
                          <span className="text-on-surface-variant/30">-</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dimensions list — deduplicated */}
      <div className="bg-raised border border-line rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-on-surface">Reference Tables ({uniqueDimensions.length})</h3>
            <p className="text-xs text-on-surface-variant mt-0.5">Shared reference data used across your models</p>
          </div>
          <span className="text-2xl">&#128270;</span>
        </div>
        {!loaded ? (
          <div className="px-5 py-8 text-center"><Spinner className="mx-auto" /></div>
        ) : uniqueDimensions.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-on-surface-variant">No reference tables found.</div>
        ) : (
          <div className="divide-y divide-white/40">
            {uniqueDimensions.map((d) => (
              <div key={d.name} className="px-5 py-3 flex items-center gap-3 hover:bg-white/40 transition-colors">
                <RoleBadge role="dimension" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-on-surface">{d.table.display_name ?? d.table.table_name}</span>
                    <StatusDot status={d.table.transformation_status} />
                    <span className="text-[10px] text-on-surface-variant">{d.table.columns.length} columns</span>
                  </div>
                  {d.table.description && (
                    <p className="text-xs text-on-surface-variant truncate mt-0.5">{d.table.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {d.usedByProducts.map((pName) => (
                    <span key={pName} className="inline-flex items-center gap-1.5 text-[11px] bg-surface-container text-on-surface-variant px-2 py-0.5 rounded-full">
                      <ProductIcon product={productByCleanName.get(pName) ?? null} name={pName} className="w-3.5 h-3.5 text-ocean" />
                      {pName}
                    </span>
                  ))}
                </div>
                {d.table.row_count !== null && (
                  <span className="text-xs text-on-surface-variant/50 flex-shrink-0">{d.table.row_count.toLocaleString()} rows</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Facts list */}
      <div className="bg-raised border border-line rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-on-surface">Transaction Tables ({allFactEntries.length})</h3>
            <p className="text-xs text-on-surface-variant mt-0.5">Tables recording your business transactions</p>
          </div>
          <span className="text-2xl">&#128202;</span>
        </div>
        {!loaded ? (
          <div className="px-5 py-8 text-center"><Spinner className="mx-auto" /></div>
        ) : allFactEntries.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-on-surface-variant">No transaction tables found.</div>
        ) : (
          <div className="divide-y divide-white/40">
            {allFactEntries.map((f) => {
              const row = factRows.find((r) => r.table.id === f.table.id);
              const dimCount = row ? row.usedDims.size : 0;
              return (
                <div key={`${f.product.id}-${f.table.id}`} className="px-5 py-3 flex items-center gap-3 hover:bg-white/40 transition-colors">
                  <RoleBadge role="fact" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-on-surface">{f.table.display_name ?? f.table.table_name}</span>
                      <StatusDot status={f.table.transformation_status} />
                      {dimCount > 0 && <span className="text-[10px] text-on-surface-variant">{dimCount} reference tables</span>}
                    </div>
                    {f.table.description && (
                      <p className="text-xs text-on-surface-variant truncate mt-0.5">{f.table.description}</p>
                    )}
                  </div>
                  <span className="text-xs text-on-surface-variant flex-shrink-0 inline-flex items-center gap-1.5">
                    <ProductIcon product={f.product} className="w-3.5 h-3.5 text-ocean" />
                    {cleanTopicName(f.product.name)}
                  </span>
                  {f.table.row_count !== null && (
                    <span className="text-xs text-on-surface-variant/50 flex-shrink-0">{f.table.row_count.toLocaleString()} rows</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


export default function ProductsPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <Suspense>
        <ProductsPageInner />
      </Suspense>
    </RequireRole>
  );
}
