'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';
import { getToken } from '@/lib/auth';
import dynamic from 'next/dynamic';

const StarSchemaFlow = dynamic(() => import('@/components/products/StarSchemaFlow'), { ssr: false });
const LineageFlow = dynamic(() => import('@/components/products/LineageFlow'), { ssr: false });

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Connection { id: number; name: string; }

interface DataProduct {
  id: number;
  connection_id: number;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  star_schema_count?: number;
}

interface StarSchema {
  id: number;
  data_product_id: number;
  name: string;
  description: string | null;
  grain: string | null;
  fact_table_type: string;
}

interface QualityCheck {
  id: number;
  product_table_id: number;
  check_type: 'bk_uniqueness' | 'fan_out';
  status: 'pass' | 'fail' | 'skip' | 'error';
  bk_columns: string | string[];
  total_rows: number;
  distinct_bk_rows: number;
  duplicate_count: number;
  sample_duplicates: string | Record<string, unknown>[];
  message: string;
  executed_at: string;
}

interface ProductTable {
  id: number;
  star_schema_id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  transformation_sql: string | null;
  transformation_status: string;
  dag_order: number;
  row_count: number | null;
  last_run_at: string | null;
  last_run_error: string | null;
  load_mode: string;
  quality_checks?: QualityCheck[];
}

interface ProductColumn {
  id: number;
  product_table_id: number;
  column_name: string;
  data_type: string | null;
  display_name: string | null;
  description: string | null;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
  transformation_expression: string | null;
  additivity: string | null;
  scd_type: number;
  lineage?: { source_table_name: string; source_column_name: string; transformation_description: string }[];
}

interface ProductRelationship {
  id: number;
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: string;
}

interface FullDataProduct extends DataProduct {
  star_schemas: (StarSchema & {
    tables: (ProductTable & { columns: ProductColumn[] })[];
    relationships: ProductRelationship[];
  })[];
}

interface ProductKpi {
  id: number;
  data_product_id: number;
  name: string;
  description: string | null;
  formula_plain_text: string | null;
  formula_sql: string | null;
  ai_draft: boolean;
  owner_name: string | null;
}

type ActiveTab = 'overview' | 'schema' | 'lineage' | 'kpis';

// ---------------------------------------------------------------------------
// Small UI components
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    draft: 'bg-slate-300',
    designing: 'bg-blue-400 animate-pulse',
    approved: 'bg-emerald-400',
    running: 'bg-amber-400 animate-pulse',
    success: 'bg-emerald-500',
    error: 'bg-red-500',
    pending: 'bg-slate-300',
  };
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${color[status] ?? 'bg-slate-300'}`}
      title={status}
    />
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-600',
    designing: 'bg-blue-100 text-blue-700',
    approved: 'bg-emerald-100 text-emerald-700',
    running: 'bg-amber-100 text-amber-700',
    success: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${colors[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const config: Record<string, { bg: string; label: string }> = {
    fact: { bg: 'bg-violet-100 text-violet-700', label: 'Measures' },
    dimension: { bg: 'bg-sky-100 text-sky-700', label: 'Lookup' },
    bridge: { bg: 'bg-amber-100 text-amber-700', label: 'Bridge' },
    junk: { bg: 'bg-slate-100 text-slate-600', label: 'Flags' },
  };
  const c = config[role] ?? { bg: 'bg-slate-100 text-slate-600', label: role };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${c.bg}`}>{c.label}</span>;
}

function ColumnRoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  const colors: Record<string, string> = {
    surrogate_key: 'bg-yellow-100 text-yellow-800',
    natural_key: 'bg-orange-100 text-orange-700',
    foreign_key: 'bg-purple-100 text-purple-700',
    measure: 'bg-green-100 text-green-700',
    attribute: 'bg-blue-100 text-blue-700',
    degenerate_dimension: 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colors[role] ?? 'bg-slate-100 text-slate-600'}`}>
      {role.replace(/_/g, ' ')}
    </span>
  );
}

function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin text-current ${className}`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function statusBorderColor(status: string): string {
  switch (status) {
    case 'approved': case 'success': return 'border-l-emerald-500';
    case 'error': return 'border-l-red-500';
    case 'designing': case 'running': return 'border-l-blue-500';
    default: return 'border-l-slate-300';
  }
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProductsPage() {
  const [tab, setTab] = useState<ActiveTab>('overview');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [loading, setLoading] = useState(true);

  // Full product details cache: productId -> FullDataProduct
  const [details, setDetails] = useState<Map<number, FullDataProduct>>(new Map());

  // Accordion state
  const [expandedProductId, setExpandedProductId] = useState<number | null>(null);
  const [expandedTableId, setExpandedTableId] = useState<number | null>(null);

  // Build terminal state
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [buildThinking, setBuildThinking] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [buildConnId, setBuildConnId] = useState<number | null>(null);
  const [buildDone, setBuildDone] = useState(false);
  const [buildSuccess, setBuildSuccess] = useState(false);
  const buildTermRef = useRef<HTMLDivElement>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);

  // Table action state
  const [runningTableId, setRunningTableId] = useState<number | null>(null);
  const [runningProductId, setRunningProductId] = useState<number | null>(null);
  const [editingSql, setEditingSql] = useState<{ tableId: number; sql: string } | null>(null);
  const [savingSql, setSavingSql] = useState(false);

  // KPI state
  const [kpis, setKpis] = useState<Map<number, ProductKpi[]>>(new Map());

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

  // When expanding a product, load its details
  const toggleProduct = useCallback((id: number) => {
    if (expandedProductId === id) {
      setExpandedProductId(null);
      setExpandedTableId(null);
    } else {
      setExpandedProductId(id);
      setExpandedTableId(null);
      if (!details.has(id)) loadFullProduct(id);
      if (!kpis.has(id)) loadKpis(id);
    }
  }, [expandedProductId, details, kpis, loadFullProduct, loadKpis]);

  // ----------- Bus Matrix Auto-Build (SSE) -----------

  const addBuildLog = useCallback((msg: string) => {
    setBuildLog((prev) => [...prev, msg]);
    setTimeout(() => {
      if (buildTermRef.current) buildTermRef.current.scrollTop = buildTermRef.current.scrollHeight;
    }, 20);
  }, []);

  const handleAutoBuild = useCallback(async (connectionId: number) => {
    setBuilding(true);
    setBuildDone(false);
    setBuildSuccess(false);
    setBuildLog([]);
    setBuildThinking('');
    setShowThinking(false);
    setBuildConnId(connectionId);

    const connName = connections.find((c) => c.id === connectionId)?.name ?? `Connection #${connectionId}`;
    addBuildLog(`Starting bus matrix design for "${connName}"...`);

    try {
      // Phase 1: SSE stream — AI designs the bus matrix
      addBuildLog('Phase 1: AI is designing all tables...');
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/products/bus-matrix-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ connectionId }),
      });

      if (!response.ok) {
        addBuildLog(`Error: Server returned ${response.status}`);
        setBuildDone(true);
        setBuilding(false);
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let busMatrix: any = null;

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
          } else if (type === 'error') {
            addBuildLog(`Error: ${event.message as string}`);
            setBuildDone(true);
            setBuilding(false);
            return;
          } else if (type === 'done') {
            busMatrix = event.busMatrix;
          }
        }
        if (done) break;
      }

      if (!busMatrix) {
        addBuildLog('Error: Stream ended without result');
        setBuildDone(true);
        setBuilding(false);
        return;
      }

      // Phase 2: Persist the bus matrix
      addBuildLog(`Phase 2: Saving ${busMatrix.conformed_dimensions?.length ?? 0} dimensions and ${busMatrix.fact_tables?.length ?? 0} fact tables...`);

      const buildRes = await api.post('/products/build-bus-matrix', { connectionId, busMatrix });
      const createdProducts = buildRes.data?.data?.products ?? [];
      addBuildLog(`Created ${createdProducts.length} data product(s)`);

      // Phase 3: Run transformations per product in build_order
      addBuildLog('Phase 3: Running transformations...');
      const sortedProducts = [...createdProducts].sort(
        (a: { build_order: number }, b: { build_order: number }) => a.build_order - b.build_order,
      );

      let allOk = true;
      for (const p of sortedProducts) {
        addBuildLog(`  Running "${p.name}"...`);
        try {
          const runRes = await api.post(`/products/${p.id}/run`);
          const results = runRes.data?.data;
          if (Array.isArray(results)) {
            const failed = results.filter((r: { status: string }) => r.status === 'error');
            if (failed.length > 0) {
              addBuildLog(`  "${p.name}": ${results.length - failed.length} ok, ${failed.length} failed`);
              allOk = false;
            } else {
              addBuildLog(`  "${p.name}": all ${results.length} tables ok`);
            }
          } else {
            addBuildLog(`  "${p.name}": done`);
          }
        } catch (runErr) {
          const msg = (runErr as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Run failed';
          addBuildLog(`  "${p.name}" error: ${msg}`);
          allOk = false;
        }
      }

      addBuildLog(allOk ? 'All done!' : 'Build completed with some errors.');
      setBuildSuccess(allOk);
      await loadProducts();

      // Expand first product
      if (createdProducts.length > 0) {
        setExpandedProductId(createdProducts[0].id);
        loadFullProduct(createdProducts[0].id);
        loadKpis(createdProducts[0].id);
      }
    } catch (err) {
      addBuildLog(`Error: ${err instanceof Error ? err.message : 'Build failed'}`);
    }
    setBuildDone(true);
    setBuilding(false);
  }, [connections, addBuildLog, loadProducts, loadFullProduct, loadKpis]);

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
      if (expandedProductId) await loadFullProduct(expandedProductId);
    } catch { /* ignore */ }
    setSavingSql(false);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this data product and all its tables?')) return;
    try {
      await api.delete(`/products/${id}`);
      if (expandedProductId === id) { setExpandedProductId(null); setExpandedTableId(null); }
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
    { key: 'schema', label: 'Schema Diagram' },
    { key: 'lineage', label: 'Lineage' },
    { key: 'kpis', label: 'KPIs' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ──────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Data Products</h1>
          <p className="text-sm text-slate-500">Organize and transform your source data</p>
        </div>
        <div className="flex items-center gap-2">
          {connections.length > 1 && (
            <select
              value={buildConnId ?? ''}
              onChange={(e) => setBuildConnId(Number(e.target.value))}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2.5 bg-white"
            >
              <option value="">Select connection...</option>
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
              className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 disabled:opacity-50 shadow-sm hover:shadow-md transition-all flex items-center gap-2"
            >
              {building && <Spinner />}
              {building ? 'Building...' : 'Prepare my data'}
            </button>
          )}
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-slate-200 px-6 flex-shrink-0">
        <div className="flex gap-1 -mb-px">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-5xl mx-auto">

          {/* ── Build Terminal ──────────────────────────────────────── */}
          {(building || buildDone) && (
            <div className="mb-6 bg-slate-900 rounded-2xl border border-slate-700 shadow-xl overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
                <div className="flex items-center gap-3">
                  {building ? (
                    <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse" />
                  ) : buildSuccess ? (
                    <span className="text-emerald-400 text-sm font-bold">OK</span>
                  ) : (
                    <span className="text-red-400 text-sm font-bold">!</span>
                  )}
                  <span className="text-sm font-semibold text-white">
                    {building ? 'Preparing your data...' : buildSuccess ? 'Your data warehouse is ready' : 'Build completed with errors'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {buildThinking && (
                    <button
                      onClick={() => setShowThinking((v) => !v)}
                      className="text-xs text-slate-400 hover:text-slate-300 transition-colors"
                    >
                      {showThinking ? 'Hide' : 'Show'} AI reasoning
                    </button>
                  )}
                  {buildDone && (
                    <button
                      onClick={() => { setBuildDone(false); setBuildLog([]); setBuildThinking(''); }}
                      className="text-xs text-slate-400 hover:text-slate-300"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>

              {showThinking && buildThinking && (
                <div ref={thinkingRef} className="px-5 py-3 max-h-48 overflow-y-auto border-b border-slate-800">
                  <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap leading-relaxed">{buildThinking}</pre>
                </div>
              )}

              <div ref={buildTermRef} className="px-5 py-3 max-h-64 overflow-y-auto">
                {buildLog.map((line, i) => (
                  <div key={i} className={`text-sm font-mono py-0.5 ${
                    line.startsWith('Error') ? 'text-red-400'
                    : line.startsWith('All done') ? 'text-emerald-400 font-semibold'
                    : line.startsWith('  ') ? 'text-slate-400'
                    : 'text-slate-300'
                  }`}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Overview Tab ───────────────────────────────────────── */}
          {tab === 'overview' && (
            <>
              {/* Loading */}
              {loading && (
                <div className="text-center py-16 text-slate-400">
                  <Spinner className="mx-auto mb-3" />
                  <p className="text-sm">Loading products...</p>
                </div>
              )}

              {/* Empty state */}
              {!loading && products.length === 0 && !building && !buildDone && (
                <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center shadow-sm">
                  <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 rounded-2xl flex items-center justify-center">
                    <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-slate-800 mb-1">No data products yet</h3>
                  <p className="text-sm text-slate-500 mb-6">
                    Data products organize your source tables into clean, query-ready datasets.
                  </p>
                  <p className="text-xs text-slate-400">Click &quot;Prepare my data&quot; above to get started.</p>
                </div>
              )}

              {/* Product accordion cards */}
              <div className="space-y-3">
                {products.map((product) => {
                  const isExpanded = expandedProductId === product.id;
                  const detail = details.get(product.id);
                  const tables = detail ? getAllTables(detail) : [];
                  const isRunning = runningProductId === product.id;

                  return (
                    <div
                      key={product.id}
                      className={`bg-white rounded-2xl border border-slate-200 border-l-[3px] shadow-sm hover:shadow-md transition-all overflow-hidden ${statusBorderColor(product.status)}`}
                    >
                      {/* Product header */}
                      <button
                        onClick={() => toggleProduct(product.id)}
                        className="w-full text-left px-5 py-4 flex items-center gap-4 hover:bg-slate-50/50 transition-colors"
                      >
                        <svg
                          className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2.5">
                            <h3 className="text-base font-semibold text-slate-900 truncate">{product.name}</h3>
                            <StatusBadge status={product.status} />
                          </div>
                          {product.description && (
                            <p className="text-sm text-slate-500 mt-0.5 truncate">{product.description}</p>
                          )}
                        </div>

                        <div className="flex items-center gap-4 text-xs text-slate-400 flex-shrink-0">
                          {detail && (
                            <>
                              <span>{tables.length} tables</span>
                              {totalRows(detail) > 0 && (
                                <span>{totalRows(detail).toLocaleString()} rows</span>
                              )}
                            </>
                          )}
                        </div>
                      </button>

                      {/* Expanded product content */}
                      {isExpanded && (
                        <div className="border-t border-slate-100">
                          {/* Product action bar */}
                          <div className="px-5 py-3 bg-slate-50/50 flex items-center justify-between">
                            <span className="text-xs text-slate-500">
                              {tables.filter((t) => t.table_role === 'dimension').length} lookup tables,{' '}
                              {tables.filter((t) => t.table_role === 'fact').length} measure tables
                            </span>
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRunProduct(product.id); }}
                                disabled={isRunning || tables.length === 0}
                                className="px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                              >
                                {isRunning && <Spinner className="w-3 h-3" />}
                                {isRunning ? 'Running...' : 'Run all'}
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(product.id); }}
                                className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </div>

                          {/* Table rows */}
                          {!detail ? (
                            <div className="px-5 py-8 text-center">
                              <Spinner className="mx-auto mb-2" />
                              <p className="text-sm text-slate-400">Loading tables...</p>
                            </div>
                          ) : tables.length === 0 ? (
                            <div className="px-5 py-8 text-center text-sm text-slate-400">
                              No tables designed yet.
                            </div>
                          ) : (
                            <div className="divide-y divide-slate-100">
                              {tables.map((table) => {
                                const isTableExpanded = expandedTableId === table.id;
                                const isTableRunning = runningTableId === table.id;

                                return (
                                  <div key={table.id}>
                                    {/* Table row */}
                                    <button
                                      onClick={() => setExpandedTableId(isTableExpanded ? null : table.id)}
                                      className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-slate-50/50 transition-colors"
                                    >
                                      <svg
                                        className={`w-3.5 h-3.5 text-slate-300 transition-transform flex-shrink-0 ${isTableExpanded ? 'rotate-90' : ''}`}
                                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                                      >
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                      </svg>

                                      <RoleBadge role={table.table_role} />

                                      <div className="flex-1 min-w-0">
                                        <span className="text-sm font-medium text-slate-800">{table.display_name ?? table.table_name}</span>
                                        {table.description && (
                                          <span className="text-xs text-slate-400 ml-2 hidden sm:inline">{table.description}</span>
                                        )}
                                      </div>

                                      <div className="flex items-center gap-3 flex-shrink-0">
                                        {table.row_count !== null && (
                                          <span className="text-xs text-slate-400">{table.row_count.toLocaleString()} rows</span>
                                        )}
                                        <StatusDot status={table.transformation_status} />
                                        {isTableRunning && <Spinner className="w-3.5 h-3.5" />}
                                      </div>
                                    </button>

                                    {/* Expanded table: columns + SQL */}
                                    {isTableExpanded && (
                                      <div className="px-5 pb-4 bg-slate-50/30">
                                        {/* Columns */}
                                        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-3">
                                          <div className="px-4 py-2.5 border-b border-slate-100">
                                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                              Columns ({table.columns.length})
                                            </span>
                                          </div>
                                          <div className="max-h-56 overflow-y-auto">
                                            {table.columns.map((col) => (
                                              <div key={col.id} className="px-4 py-1.5 flex items-center gap-2 text-xs hover:bg-slate-50 border-b border-slate-50 last:border-0">
                                                <ColumnRoleBadge role={col.column_role} />
                                                <span className="font-medium text-slate-700">{col.column_name}</span>
                                                <span className="text-slate-300">{col.data_type}</span>
                                                {col.description && (
                                                  <span className="text-slate-400 truncate ml-auto">{col.description}</span>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        </div>

                                        {/* SQL */}
                                        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-3">
                                          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                              Transformation SQL
                                            </span>
                                            <div className="flex gap-2">
                                              {editingSql?.tableId !== table.id && table.transformation_sql && (
                                                <button
                                                  onClick={() => setEditingSql({ tableId: table.id, sql: table.transformation_sql! })}
                                                  className="text-[11px] text-blue-600 hover:text-blue-700 font-medium"
                                                >
                                                  Edit
                                                </button>
                                              )}
                                              <button
                                                onClick={() => handleRunTable(table.id, product.id)}
                                                disabled={isTableRunning || !table.transformation_sql}
                                                className="text-[11px] text-emerald-600 hover:text-emerald-700 font-medium disabled:opacity-50 flex items-center gap-1"
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
                                                onChange={(e) => setEditingSql({ ...editingSql, sql: e.target.value })}
                                                rows={Math.max(8, editingSql.sql.split('\n').length + 2)}
                                                className="w-full font-mono text-xs border border-slate-300 rounded-lg p-3 bg-white resize-y focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                              />
                                              <div className="flex gap-2 mt-2">
                                                <button onClick={handleSaveSql} disabled={savingSql}
                                                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                                                  {savingSql ? 'Saving...' : 'Save'}
                                                </button>
                                                <button onClick={() => setEditingSql(null)}
                                                  className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
                                                  Cancel
                                                </button>
                                              </div>
                                            </div>
                                          ) : (
                                            <pre className="p-3 text-xs font-mono text-slate-600 bg-slate-50/50 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                                              {table.transformation_sql || 'No SQL generated yet'}
                                            </pre>
                                          )}
                                        </div>

                                        {/* Run info */}
                                        {(table.last_run_at || table.last_run_error) && (
                                          <div className="text-xs text-slate-500 px-1 mb-2">
                                            {table.last_run_at && (
                                              <span>Last run: {new Date(table.last_run_at).toLocaleString()}</span>
                                            )}
                                            {table.last_run_error && (
                                              <span className="text-red-500 ml-3">{table.last_run_error}</span>
                                            )}
                                          </div>
                                        )}

                                        {/* Quality checks */}
                                        {table.quality_checks && table.quality_checks.length > 0 && (
                                          <div className="space-y-1">
                                            {table.quality_checks.map((chk) => (
                                              <div key={chk.id} className="flex items-center gap-2 text-xs">
                                                <StatusDot status={chk.status === 'pass' ? 'success' : chk.status === 'fail' ? 'error' : 'draft'} />
                                                <span className={chk.status === 'pass' ? 'text-emerald-600' : chk.status === 'fail' ? 'text-red-600' : 'text-slate-500'}>
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
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── Schema Diagram Tab ─────────────────────────────────── */}
          {tab === 'schema' && (
            <SchemaTab products={products} details={details} onLoadProduct={loadFullProduct} />
          )}

          {/* ── Lineage Tab ────────────────────────────────────────── */}
          {tab === 'lineage' && (
            <LineageTab products={products} details={details} onLoadProduct={loadFullProduct} />
          )}

          {/* ── KPIs Tab ───────────────────────────────────────────── */}
          {tab === 'kpis' && (
            <KpisTab products={products} details={details} kpis={kpis} onLoadProduct={loadFullProduct} onLoadKpis={loadKpis} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schema Diagram Tab
// ---------------------------------------------------------------------------

function SchemaTab({
  products, details, onLoadProduct,
}: {
  products: DataProduct[];
  details: Map<number, FullDataProduct>;
  onLoadProduct: (id: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(products[0]?.id ?? null);

  useEffect(() => {
    if (selectedId && !details.has(selectedId)) onLoadProduct(selectedId);
  }, [selectedId, details, onLoadProduct]);

  const product = selectedId ? details.get(selectedId) : undefined;

  return (
    <div>
      {products.length > 1 && (
        <div className="mb-4">
          <select value={selectedId ?? ''} onChange={(e) => setSelectedId(Number(e.target.value))}
            className="text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white">
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {!product ? (
        <div className="text-center py-16 text-slate-400 text-sm">
          {products.length === 0 ? 'No data products yet.' : 'Loading...'}
        </div>
      ) : product.star_schemas.length === 0 ? (
        <div className="text-center py-16 text-slate-400 text-sm">No tables designed yet.</div>
      ) : (
        <div className="space-y-6">
          {product.star_schemas.map((schema) => (
            <StarSchemaFlow key={schema.id} schema={schema} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lineage Tab
// ---------------------------------------------------------------------------

function LineageTab({
  products, details, onLoadProduct,
}: {
  products: DataProduct[];
  details: Map<number, FullDataProduct>;
  onLoadProduct: (id: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(products[0]?.id ?? null);
  const [viewMode, setViewMode] = useState<'flow' | 'table'>('flow');

  useEffect(() => {
    if (selectedId && !details.has(selectedId)) onLoadProduct(selectedId);
  }, [selectedId, details, onLoadProduct]);

  const product = selectedId ? details.get(selectedId) : undefined;

  if (!product) {
    return <div className="text-center py-16 text-slate-400 text-sm">{products.length === 0 ? 'No data products yet.' : 'Loading...'}</div>;
  }

  const allColumns = product.star_schemas.flatMap((s) =>
    s.tables.flatMap((t) => t.columns.map((c) => ({ ...c, tableName: t.table_name, tableRole: t.table_role }))),
  );
  const columnsWithLineage = allColumns.filter((c) => c.lineage && c.lineage.length > 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {products.length > 1 && (
            <select value={selectedId ?? ''} onChange={(e) => setSelectedId(Number(e.target.value))}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white">
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          <button onClick={() => setViewMode('flow')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'flow' ? 'bg-white shadow text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}>
            Diagram
          </button>
          <button onClick={() => setViewMode('table')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'table' ? 'bg-white shadow text-blue-600' : 'text-slate-500 hover:text-slate-700'}`}>
            Table
          </button>
        </div>
      </div>

      {viewMode === 'flow' ? (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <LineageFlow data={{ tables: product.star_schemas.flatMap((s) => s.tables) }} />
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Product Table</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Column</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Source Table</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Source Column</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Transformation</th>
              </tr>
            </thead>
            <tbody>
              {columnsWithLineage.map((col) =>
                col.lineage!.map((l, li) => (
                  <tr key={`${col.id}-${li}`} className="border-t border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-2 font-medium text-slate-700">{col.tableName}</td>
                    <td className="px-4 py-2 text-slate-600">{col.column_name}</td>
                    <td className="px-4 py-2 text-slate-600">{l.source_table_name}</td>
                    <td className="px-4 py-2 text-slate-600">{l.source_column_name}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{l.transformation_description}</td>
                  </tr>
                )),
              )}
              {columnsWithLineage.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">No lineage data available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs Tab
// ---------------------------------------------------------------------------

function KpisTab({
  products, details, kpis, onLoadProduct, onLoadKpis,
}: {
  products: DataProduct[];
  details: Map<number, FullDataProduct>;
  kpis: Map<number, ProductKpi[]>;
  onLoadProduct: (id: number) => void;
  onLoadKpis: (id: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(products[0]?.id ?? null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingKpi, setEditingKpi] = useState<ProductKpi | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPlainText, setFormPlainText] = useState('');
  const [formSql, setFormSql] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (selectedId && !details.has(selectedId)) onLoadProduct(selectedId);
    if (selectedId && !kpis.has(selectedId)) onLoadKpis(selectedId);
  }, [selectedId, details, kpis, onLoadProduct, onLoadKpis]);

  const product = selectedId ? details.get(selectedId) : undefined;
  const productKpis = selectedId ? (kpis.get(selectedId) ?? []) : [];

  const resetForm = () => { setFormName(''); setFormDesc(''); setFormPlainText(''); setFormSql(''); setEditingKpi(null); setShowAdd(false); };

  const openEdit = (kpi: ProductKpi) => {
    setEditingKpi(kpi); setFormName(kpi.name); setFormDesc(kpi.description ?? '');
    setFormPlainText(kpi.formula_plain_text ?? ''); setFormSql(kpi.formula_sql ?? ''); setShowAdd(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !selectedId) return;
    setSaving(true);
    try {
      if (editingKpi) {
        await api.put(`/products/kpis/${editingKpi.id}`, {
          name: formName, description: formDesc || null,
          formula_plain_text: formPlainText || null, formula_sql: formSql || null, ai_draft: false,
        });
      } else {
        await api.post(`/products/${selectedId}/kpis`, {
          name: formName, description: formDesc || undefined,
          formulaPlainText: formPlainText || undefined, formulaSql: formSql || undefined,
        });
      }
      resetForm();
      onLoadKpis(selectedId);
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleDeleteKpi = async (kpiId: number) => {
    if (!confirm('Delete this KPI?')) return;
    try { await api.delete(`/products/kpis/${kpiId}`); if (selectedId) onLoadKpis(selectedId); } catch { /* ignore */ }
  };

  const handleApproveKpi = async (kpi: ProductKpi) => {
    try { await api.put(`/products/kpis/${kpi.id}`, { ai_draft: false }); if (selectedId) onLoadKpis(selectedId); } catch { /* ignore */ }
  };

  const tableNames = product?.star_schemas.flatMap((s) => s.tables.map((t) => t.table_name)) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {products.length > 1 && (
            <select value={selectedId ?? ''} onChange={(e) => setSelectedId(Number(e.target.value))}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white">
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        <button onClick={() => { resetForm(); setShowAdd(true); }}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 shadow-sm">
          + Add KPI
        </button>
      </div>

      {tableNames.length > 0 && (
        <div className="mb-4 bg-slate-50 rounded-xl px-4 py-2.5 text-xs text-slate-500">
          <span className="font-semibold">Available tables: </span>{tableNames.join(', ')}
        </div>
      )}

      {productKpis.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center shadow-sm">
          <p className="text-slate-500">No KPIs defined yet.</p>
          <p className="text-sm text-slate-400 mt-1">KPIs proposed by the AI during design will appear here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {productKpis.map((kpi) => (
            <div key={kpi.id} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-800">{kpi.name}</h3>
                  {kpi.ai_draft && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">AI Draft</span>}
                </div>
                <div className="flex gap-1">
                  {kpi.ai_draft && (
                    <button onClick={() => handleApproveKpi(kpi)} className="text-[10px] px-2 py-1 bg-green-100 text-green-700 rounded hover:bg-green-200">Approve</button>
                  )}
                  <button onClick={() => openEdit(kpi)} className="text-[10px] px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200">Edit</button>
                  <button onClick={() => handleDeleteKpi(kpi.id)} className="text-[10px] px-2 py-1 bg-red-50 text-red-600 rounded hover:bg-red-100">Delete</button>
                </div>
              </div>
              {kpi.description && <p className="text-sm text-slate-600 mb-2">{kpi.description}</p>}
              {kpi.formula_plain_text && (
                <div className="mb-2">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase">Business Definition</p>
                  <p className="text-sm text-slate-700">{kpi.formula_plain_text}</p>
                </div>
              )}
              {kpi.formula_sql && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase">SQL Formula</p>
                  <pre className="text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 mt-0.5 overflow-x-auto">{kpi.formula_sql}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit KPI dialog */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">{editingKpi ? 'Edit KPI' : 'New KPI'}</h3>
            <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <input value={formName} onChange={(e) => setFormName(e.target.value)}
              className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm mb-3" placeholder="e.g. Gross Margin" />
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)}
              className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm mb-3" rows={2} placeholder="What does this KPI measure?" />
            <label className="block text-sm font-medium text-slate-700 mb-1">Business Definition</label>
            <input value={formPlainText} onChange={(e) => setFormPlainText(e.target.value)}
              className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm mb-3" placeholder="e.g. Revenue minus cost of goods sold" />
            <label className="block text-sm font-medium text-slate-700 mb-1">SQL Formula</label>
            <textarea value={formSql} onChange={(e) => setFormSql(e.target.value)}
              className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm font-mono mb-3" rows={3} placeholder="e.g. SUM(f.revenue) - SUM(f.cogs)" />
            {tableNames.length > 0 && (
              <div className="bg-slate-50 rounded-xl px-3 py-2 mb-4 text-xs text-slate-500">
                <span className="font-semibold">Available tables: </span>{tableNames.join(', ')}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={resetForm} className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50">Cancel</button>
              <button onClick={handleSave} disabled={!formName.trim() || saving}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving...' : editingKpi ? 'Update KPI' : 'Create KPI'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
