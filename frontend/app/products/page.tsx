'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Wrench } from 'lucide-react';
import api from '@/lib/api';
import { streamSSE, SSEHttpError } from '@/lib/sse';
import { getItem, setItem, removeItem, storageKeys } from '@/lib/storage';
import RequireRole from '@/components/RequireRole';
import dynamic from 'next/dynamic';
const QualityTab = dynamic(() => import('./QualityTab'), { ssr: false });
import type {
  Connection,
  DataProduct,
  StarSchema,
  ProductTable,
  ProductColumn,
  FullDataProduct,
  ProductKpi,
  ActiveTab,
} from './types';
import { StatusDot, RoleBadge, Spinner, ProductIcon } from './badges';
import { cleanTopicName } from './helpers';
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

  // Ask AI panel state — { open, productId? } where productId === null means general/cross-product
  const [askOpen, setAskOpen] = useState(false);
  const [askProductId, setAskProductId] = useState<number | null>(null);

  // Accordion state (used inside slide-over)

  // New empty-product modal (replaces the old browser prompt()).
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [creatingProduct, setCreatingProduct] = useState(false);

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

  // KPI state
  const [kpis, setKpis] = useState<Map<number, ProductKpi[]>>(new Map());

  // Source filter chip — null means "All sources" (grouped sections render).
  // String keys mirror `productSourceGroupKey` so URL/persistence is shared
  // with /catalog and any future surface that filters by source.

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
    setItem(storageKeys.busMatrixJobId, jobId);

    const abortController = new AbortController();
    buildAbortRef.current = abortController;

    try {
      let allOk = true;

      await streamSSE(`${BACKEND_URL}/api/products/bus-matrix/${jobId}/stream`, {
        method: 'GET',
        signal: abortController.signal,
        onEvent: (raw) => {
          const event = raw as Record<string, unknown>;
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
            removeItem(storageKeys.busMatrixJobId);

            // Refresh product list
            setDetails(new Map());
            setKpis(new Map());
            void loadProducts();
          } else if (type === 'failed') {
            const msg = event.error as string;
            const cancelled = msg && /cancel/i.test(msg);
            addBuildLog(cancelled ? 'Cancelled.' : `Error: ${msg}`);
            setBuildSuccess(false);
            setBuildDone(true);
            setBuilding(false);
            removeItem(storageKeys.busMatrixJobId);
            void loadProducts();
          } else if (type === 'error') {
            addBuildLog(`Error: ${event.message as string}`);
            setBuildDone(true);
            setBuilding(false);
            removeItem(storageKeys.busMatrixJobId);
          }
        },
      });
    } catch (err) {
      // AbortError means the user navigated away or cancelled — work continues server-side.
      if ((err as { name?: string })?.name === 'AbortError') {
        // fall through to finally
      } else if (err instanceof SSEHttpError) {
        addBuildLog(`Error: stream returned ${err.status}`);
        setBuildDone(true);
        setBuilding(false);
        removeItem(storageKeys.busMatrixJobId);
      } else {
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

  const handleCreateProduct = useCallback(async () => {
    const connId = connections.length === 1 ? connections[0].id : buildConnId;
    const name = newProductName.trim();
    if (!connId || !name) return;
    setCreatingProduct(true);
    try {
      const res = await api.post('/products', { name, connectionId: connId, sourceTables: [] });
      const id = res.data.data?.productId ?? res.data.data?.id;
      setNewProductOpen(false);
      setNewProductName('');
      if (id) router.push(`/products/${id}`);
      else loadProducts();
    } catch {
      /* surfaced by the global error handler; keep the modal open to retry */
    } finally {
      setCreatingProduct(false);
    }
  }, [connections, buildConnId, newProductName, router, loadProducts]);

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
        const stored = getItem(storageKeys.busMatrixJobId);
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
          removeItem(storageKeys.busMatrixJobId);
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

  // ----------- Helpers -----------

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
          <p className="text-[12px] text-muted mt-0.5 max-w-xl">
            A data product turns raw source tables into clean, business-ready tables your team can ask questions about and build dashboards on.
          </p>
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
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  const connId = connections.length === 1 ? connections[0].id : buildConnId;
                  if (connId) handleAutoBuild(connId);
                }}
                disabled={building || (connections.length > 1 && !buildConnId)}
                className="px-4 py-2 bg-ocean text-white text-[13px] font-medium rounded-l-md hover:bg-ocean-hover disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {building && <Spinner />}
                {building ? 'Building…' : 'Prepare my data'}
              </button>
              <button
                onClick={() => {
                  const connId = connections.length === 1 ? connections[0].id : buildConnId;
                  if (!connId) return;
                  setNewProductName('');
                  setNewProductOpen(true);
                }}
                disabled={connections.length > 1 && !buildConnId}
                className="px-2.5 py-2 bg-ocean text-white text-[13px] font-medium rounded-r-md hover:bg-ocean-hover disabled:opacity-50 transition-colors border-l border-ocean-hover/40"
                title="Start an empty product and design it yourself"
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
            </div>
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

      {/* ── New empty product modal ──────────────────────────────────── */}
      {newProductOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => !creatingProduct && setNewProductOpen(false)}
            aria-hidden="true"
          />
          <div className="relative bg-raised border border-line rounded-lg shadow-xl w-full max-w-md p-5">
            <h2 className="font-display text-[17px] text-ink">Name your data product</h2>
            <p className="text-[12px] text-muted mt-1 mb-4">
              You’ll design its tables yourself on the next screen. Prefer Clarion to draft it for you?
              Use <span className="font-medium text-ink-2">Prepare my data</span> instead.
            </p>
            <input
              autoFocus
              type="text"
              value={newProductName}
              onChange={(e) => setNewProductName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newProductName.trim() && !creatingProduct) handleCreateProduct();
                if (e.key === 'Escape' && !creatingProduct) setNewProductOpen(false);
              }}
              placeholder="e.g. Sales analytics"
              className="w-full bg-bg border border-line rounded-md px-3 py-2 text-[13.5px] text-ink focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setNewProductOpen(false)}
                disabled={creatingProduct}
                className="px-3 py-2 text-[13px] font-medium text-ink-2 border border-line rounded-md hover:bg-soft disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProduct}
                disabled={!newProductName.trim() || creatingProduct}
                className="px-4 py-2 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {creatingProduct && <Spinner className="w-3 h-3" />}
                {creatingProduct ? 'Creating…' : 'Create product'}
              </button>
            </div>
          </div>
        </div>
      )}
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
