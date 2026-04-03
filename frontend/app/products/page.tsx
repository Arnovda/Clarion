'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Nav from '@/components/Nav';
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

interface SourceTable {
  id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  connection_id: number;
}

type MainTab = 'products' | 'schema-viewer' | 'lineage' | 'transformations' | 'kpis';

interface SkeletonTable {
  name: string;
  role: string;
  description?: string;
  columns?: { name: string; role: string; type: string }[];
}

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-600',
    designing: 'bg-blue-100 text-blue-700',
    approved: 'bg-green-100 text-green-700',
    running: 'bg-amber-100 text-amber-700',
    success: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    fact: 'bg-purple-100 text-purple-700',
    dimension: 'bg-blue-100 text-blue-700',
    bridge: 'bg-amber-100 text-amber-700',
    junk: 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[role] ?? 'bg-slate-100 text-slate-600'}`}>
      {role}
    </span>
  );
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
  const label = role.replace(/_/g, ' ');
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colors[role] ?? 'bg-slate-100 text-slate-600'}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProductSemanticsPage() {
  const [tab, setTab] = useState<MainTab>('products');
  const [connections, setConnections] = useState<Connection[]>([]);
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<FullDataProduct | null>(null);
  const [loading, setLoading] = useState(true);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createConnId, setCreateConnId] = useState<number | null>(null);
  const [availableSources, setAvailableSources] = useState<SourceTable[]>([]);
  const [selectedSources, setSelectedSources] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  // Design state
  const [designing, setDesigning] = useState(false);
  const [designPhase, setDesignPhase] = useState('');
  const [designThinking, setDesignThinking] = useState('');
  const [designSqlThinking, setDesignSqlThinking] = useState('');
  const [skeletonTables, setSkeletonTables] = useState<SkeletonTable[]>([]);
  const [showThinking, setShowThinking] = useState(true);
  const thinkingRef = useRef<HTMLDivElement>(null);

  // Expanded tree state
  const [expandedSchemas, setExpandedSchemas] = useState<Set<number>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<number>>(new Set());
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);

  // ----------- Load data -----------
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
      setSelectedProduct(res.data.data ?? null);
    } catch { /* ignore */ }
  }, []);

  // ----------- Create data product -----------
  const handleConnectionSelect = async (connId: number) => {
    setCreateConnId(connId);
    setSelectedSources(new Set());
    try {
      const res = await api.get(`/semantic/tables?connectionId=${connId}`);
      setAvailableSources(res.data.data ?? []);
    } catch {
      setAvailableSources([]);
    }
  };

  const toggleSource = (id: number) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllSources = () => {
    setSelectedSources(new Set(availableSources.map((s) => s.id)));
  };

  const handleCreate = async () => {
    if (!createName.trim() || !createConnId || selectedSources.size === 0) return;
    setCreating(true);
    try {
      const sourceTables = availableSources
        .filter((s) => selectedSources.has(s.id))
        .map((s) => ({ sourceTableId: s.id, tableName: s.table_name }));

      await api.post('/products', {
        name: createName,
        description: createDesc,
        connectionId: createConnId,
        sourceTables,
      });

      setShowCreate(false);
      setCreateName('');
      setCreateDesc('');
      setCreateConnId(null);
      setSelectedSources(new Set());
      await loadProducts();
    } catch { /* ignore */ }
    setCreating(false);
  };

  // ----------- AI Design (SSE streaming with live thinking) -----------
  const handleDesign = async (productId: number) => {
    setDesigning(true);
    setDesignPhase('Connecting...');
    setDesignThinking('');
    setDesignSqlThinking('');
    setSkeletonTables([]);
    setShowThinking(true);

    try {
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/products/${productId}/design-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
            setDesignPhase(event.text as string);
          } else if (type === 'thinking') {
            setDesignThinking((prev) => prev + (event.text as string));
            // Auto-scroll thinking panel
            setTimeout(() => {
              if (thinkingRef.current) {
                thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight;
              }
            }, 10);
          } else if (type === 'sql_thinking') {
            setDesignSqlThinking((prev) => prev + (event.text as string));
            setTimeout(() => {
              if (thinkingRef.current) {
                thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight;
              }
            }, 10);
          } else if (type === 'table_saved') {
            const tbl = event.table as SkeletonTable;
            setSkeletonTables((prev) => [...prev, tbl]);
          } else if (type === 'design_complete') {
            setDesignPhase('Star schema design complete! Generating SQL...');
          } else if (type === 'sql_complete') {
            setDesignPhase('Done! Star schema designed + SQL generated.');
          } else if (type === 'sql_error') {
            setDesignPhase('Design complete. SQL generation failed — retry from Transformations tab.');
          } else if (type === 'error') {
            setDesignPhase(`Error: ${event.message as string}`);
          } else if (type === 'done') {
            await loadProducts();
            await loadFullProduct(productId);
          }
        }

        if (done) break;
      }
    } catch {
      setDesignPhase('Design failed. Please try again.');
    }
    setTimeout(() => setDesigning(false), 3000);
  };

  // ----------- Delete -----------
  const handleDelete = async (id: number) => {
    if (!confirm('Delete this data product and all its star schemas?')) return;
    try {
      await api.delete(`/products/${id}`);
      if (selectedProduct?.id === id) setSelectedProduct(null);
      await loadProducts();
    } catch { /* ignore */ }
  };

  // ----------- Generate SQL (manual fallback) -----------
  const [generatingSql, setGeneratingSql] = useState(false);
  const handleGenerateSql = async (productId: number) => {
    setGeneratingSql(true);
    try {
      await api.post(`/products/${productId}/generate-sql`);
      await loadFullProduct(productId);
    } catch { /* ignore */ }
    setGeneratingSql(false);
  };

  // ----------- Transformation controls -----------
  const [runningAll, setRunningAll] = useState(false);
  const [runningTableId, setRunningTableId] = useState<number | null>(null);

  const handleRunTable = async (tableId: number) => {
    setRunningTableId(tableId);
    try {
      await api.post(`/products/tables/${tableId}/run`);
      if (selectedProduct) await loadFullProduct(selectedProduct.id);
    } catch { /* ignore */ }
    setRunningTableId(null);
  };

  const handleRunAll = async (productId: number) => {
    setRunningAll(true);
    try {
      await api.post(`/products/${productId}/run`);
      await loadFullProduct(productId);
    } catch { /* ignore */ }
    setRunningAll(false);
  };

  const handleApproveTable = async (tableId: number) => {
    try {
      await api.put(`/products/tables/${tableId}/approve`);
      if (selectedProduct) await loadFullProduct(selectedProduct.id);
    } catch { /* ignore */ }
  };

  // ----------- Tree helpers -----------
  const toggleSchema = (id: number) => {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTable = (id: number) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Get the selected table object
  const selectedTable = selectedProduct?.star_schemas
    .flatMap((s) => s.tables)
    .find((t) => t.id === selectedTableId) ?? null;

  // ----------- Tab definitions -----------
  const tabs: { key: MainTab; label: string }[] = [
    { key: 'products', label: 'Data Products' },
    { key: 'schema-viewer', label: 'Star Schema' },
    { key: 'lineage', label: 'Source-to-Target' },
    { key: 'transformations', label: 'Transformations' },
    { key: 'kpis', label: 'KPIs' },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav />

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200 px-6">
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

      <div className="flex h-[calc(100vh-105px)]">
        {/* ── Left sidebar: product tree ──────────────────────────────────── */}
        <div className="w-72 border-r border-slate-200 bg-white overflow-y-auto flex-shrink-0">
          <div className="p-3 border-b border-slate-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Data Products</span>
            <button
              onClick={() => setShowCreate(true)}
              className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
            >
              + New
            </button>
          </div>

          {loading && <p className="p-4 text-sm text-slate-400">Loading...</p>}

          {products.map((p) => (
            <div key={p.id}>
              {/* Product row */}
              <button
                onClick={() => {
                  if (selectedProduct?.id !== p.id) loadFullProduct(p.id);
                  else setSelectedProduct(null);
                }}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-50 border-b border-slate-50 ${
                  selectedProduct?.id === p.id ? 'bg-blue-50' : ''
                }`}
              >
                <span className="text-sm font-medium text-slate-800 truncate flex-1">{p.name}</span>
                <StatusBadge status={p.status} />
              </button>

              {/* Expanded: star schemas + tables */}
              {selectedProduct?.id === p.id && selectedProduct.star_schemas.map((schema) => (
                <div key={schema.id} className="ml-3">
                  <button
                    onClick={() => toggleSchema(schema.id)}
                    className="w-full text-left px-2 py-1.5 flex items-center gap-1 hover:bg-slate-50 text-xs"
                  >
                    <span className="text-slate-400">{expandedSchemas.has(schema.id) ? '\u25BC' : '\u25B6'}</span>
                    <span className="font-medium text-slate-700 truncate">{schema.name}</span>
                  </button>

                  {expandedSchemas.has(schema.id) && schema.tables.map((tbl) => (
                    <div key={tbl.id} className="ml-4">
                      <button
                        onClick={() => {
                          setSelectedTableId(tbl.id);
                          toggleTable(tbl.id);
                        }}
                        className={`w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-slate-50 text-xs ${
                          selectedTableId === tbl.id ? 'bg-blue-50 text-blue-700' : 'text-slate-600'
                        }`}
                      >
                        <RoleBadge role={tbl.table_role} />
                        <span className="truncate">{tbl.table_name}</span>
                      </button>

                      {expandedTables.has(tbl.id) && tbl.columns.map((col) => (
                        <div
                          key={col.id}
                          className="ml-6 px-2 py-0.5 text-[11px] text-slate-500 flex items-center gap-1"
                        >
                          <ColumnRoleBadge role={col.column_role} />
                          <span className="truncate">{col.column_name}</span>
                          <span className="text-slate-300 ml-auto">{col.data_type}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── Main content area ──────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* === Data Products tab === */}
          {tab === 'products' && (
            <div>
              {!selectedProduct ? (
                <div className="text-center py-16 text-slate-400">
                  <p className="text-lg font-medium">Select a data product or create a new one</p>
                  <p className="text-sm mt-1">Data products organize your source data into Kimball star schemas</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-xl font-bold text-slate-900">{selectedProduct.name}</h2>
                      <p className="text-sm text-slate-500 mt-1">{selectedProduct.description || 'No description'}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <StatusBadge status={selectedProduct.status} />
                        <span className="text-xs text-slate-400">
                          {selectedProduct.star_schemas.length} star schema(s) ·{' '}
                          {selectedProduct.star_schemas.reduce((n, s) => n + s.tables.length, 0)} tables
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {(selectedProduct.status === 'draft' || (selectedProduct.status === 'designing' && !designing)) && (
                        <button
                          onClick={() => handleDesign(selectedProduct.id)}
                          disabled={designing}
                          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                        >
                          {designing && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                          {designing ? 'Designing...' : 'AI Design Star Schema'}
                        </button>
                      )}
                      {selectedProduct.status === 'approved' && selectedProduct.star_schemas.some((s) =>
                        s.tables.some((t) => !t.transformation_sql),
                      ) && (
                        <button
                          onClick={() => handleGenerateSql(selectedProduct.id)}
                          disabled={generatingSql}
                          className="px-4 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 disabled:opacity-50"
                        >
                          {generatingSql ? 'Generating SQL...' : 'Generate SQL'}
                        </button>
                      )}
                      {selectedProduct.status === 'approved' && selectedProduct.star_schemas.some((s) =>
                        s.tables.some((t) => t.transformation_sql),
                      ) && (
                        <button
                          onClick={() => handleRunAll(selectedProduct.id)}
                          disabled={runningAll}
                          className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {runningAll ? 'Running...' : 'Run All Transformations'}
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(selectedProduct.id)}
                        className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* ── Live design panel (visible while designing) ──────── */}
                  {designing && (
                    <div className="space-y-4">
                      {/* Phase indicator */}
                      <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm font-medium text-blue-700">{designPhase}</span>
                      </div>

                      {/* Thinking panel */}
                      {(designThinking || designSqlThinking) && (
                        <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden">
                          <button
                            onClick={() => setShowThinking((v) => !v)}
                            className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-slate-400 hover:bg-slate-800"
                          >
                            <span>AI Reasoning {designSqlThinking ? '(SQL Generation)' : '(Schema Design)'}</span>
                            <span>{showThinking ? '\u25BC' : '\u25B6'}</span>
                          </button>
                          {showThinking && (
                            <div
                              ref={thinkingRef}
                              className="px-4 pb-3 max-h-64 overflow-y-auto"
                            >
                              <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap leading-relaxed">
                                {designSqlThinking || designThinking}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Skeleton preview — tables appear as they're saved */}
                      {skeletonTables.length > 0 && (
                        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                          <div className="px-5 py-3 border-b border-slate-100">
                            <h3 className="font-semibold text-slate-800">Designed Tables</h3>
                            <p className="text-xs text-slate-400">{skeletonTables.length} table(s) created</p>
                          </div>
                          <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {skeletonTables.map((tbl, i) => (
                              <div
                                key={i}
                                className={`border-2 rounded-lg p-3 animate-fadeIn ${
                                  tbl.role === 'fact'
                                    ? 'border-purple-200 bg-purple-50'
                                    : 'border-blue-200 bg-blue-50'
                                }`}
                              >
                                <div className="flex items-center gap-2 mb-2">
                                  <RoleBadge role={tbl.role} />
                                  <span className="text-sm font-semibold">{tbl.name}</span>
                                </div>
                                {tbl.description && (
                                  <p className="text-xs text-slate-600 mb-2 line-clamp-2">{tbl.description}</p>
                                )}
                                {tbl.columns && tbl.columns.slice(0, 6).map((col, ci) => (
                                  <div key={ci} className="text-[11px] py-0.5 flex items-center gap-1 text-slate-600">
                                    <ColumnRoleBadge role={col.role} />
                                    <span>{col.name}</span>
                                    <span className="text-slate-300 ml-auto">{col.type}</span>
                                  </div>
                                ))}
                                {tbl.columns && tbl.columns.length > 6 && (
                                  <p className="text-[10px] text-slate-400 mt-1">+{tbl.columns.length - 6} more columns</p>
                                )}
                              </div>
                            ))}
                            {/* Skeleton placeholder cards for tables not yet arrived */}
                            {skeletonTables.length < 3 && Array.from({ length: 3 - skeletonTables.length }).map((_, i) => (
                              <div key={`skel-${i}`} className="border-2 border-dashed border-slate-200 rounded-lg p-3 animate-pulse">
                                <div className="h-4 bg-slate-200 rounded w-24 mb-3" />
                                <div className="space-y-1.5">
                                  <div className="h-3 bg-slate-100 rounded w-32" />
                                  <div className="h-3 bg-slate-100 rounded w-28" />
                                  <div className="h-3 bg-slate-100 rounded w-36" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Star schemas */}
                  {!designing && selectedProduct.star_schemas.length === 0 ? (
                    <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
                      <p className="text-slate-500">No star schemas yet. Click &quot;AI Design Star Schema&quot; to generate one.</p>
                    </div>
                  ) : !designing ? (
                    selectedProduct.star_schemas.map((schema) => (
                      <div key={schema.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100">
                          <h3 className="font-semibold text-slate-800">{schema.name}</h3>
                          {schema.grain && (
                            <p className="text-xs text-slate-500 mt-1">Grain: {schema.grain}</p>
                          )}
                          <p className="text-xs text-slate-400 mt-0.5">
                            Type: {schema.fact_table_type} · {schema.tables.length} tables
                          </p>
                        </div>

                        {/* Tables grid */}
                        <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {schema.tables
                            .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name))
                            .map((tbl) => (
                              <div
                                key={tbl.id}
                                onClick={() => { setSelectedTableId(tbl.id); setTab('transformations'); }}
                                className="border border-slate-200 rounded-lg p-3 hover:border-blue-300 hover:bg-blue-50/30 cursor-pointer transition-colors"
                              >
                                <div className="flex items-center gap-2 mb-2">
                                  <RoleBadge role={tbl.table_role} />
                                  <span className="text-sm font-medium text-slate-800">{tbl.table_name}</span>
                                </div>
                                <p className="text-xs text-slate-500 line-clamp-2">{tbl.description || 'No description'}</p>
                                <div className="flex items-center gap-2 mt-2">
                                  <StatusBadge status={tbl.transformation_status} />
                                  {tbl.row_count !== null && (
                                    <span className="text-[10px] text-slate-400">{tbl.row_count.toLocaleString()} rows</span>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    ))
                  ) : null}
                </div>
              )}
            </div>
          )}

          {/* === Star Schema Viewer tab === */}
          {tab === 'schema-viewer' && (
            <SchemaViewer product={selectedProduct} />
          )}

          {/* === Source-to-Target Lineage tab === */}
          {tab === 'lineage' && (
            <LineageView product={selectedProduct} />
          )}

          {/* === Transformations tab === */}
          {tab === 'transformations' && (
            <TransformationsView
              product={selectedProduct}
              selectedTableId={selectedTableId}
              onSelectTable={setSelectedTableId}
              onApprove={handleApproveTable}
              onRun={handleRunTable}
              onRunAll={selectedProduct ? () => handleRunAll(selectedProduct.id) : undefined}
              onRefresh={selectedProduct ? () => loadFullProduct(selectedProduct.id) : undefined}
              runningAll={runningAll}
              runningTableId={runningTableId}
              onGenerateSql={selectedProduct ? () => handleGenerateSql(selectedProduct.id) : undefined}
              generatingSql={generatingSql}
            />
          )}

          {/* === KPIs tab === */}
          {tab === 'kpis' && (
            <KpisView product={selectedProduct} onRefresh={selectedProduct ? () => loadFullProduct(selectedProduct.id) : undefined} />
          )}
        </div>
      </div>

      {/* ── Create dialog ──────────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[80vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-slate-900 mb-4">New Data Product</h3>

            <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3"
              placeholder="e.g. Finance, Sales, HR"
            />

            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3"
              rows={2}
              placeholder="What business domain does this data product cover?"
            />

            <label className="block text-sm font-medium text-slate-700 mb-1">Source Connection</label>
            <select
              value={createConnId ?? ''}
              onChange={(e) => handleConnectionSelect(Number(e.target.value))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3"
            >
              <option value="">Select a connection...</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            {createConnId && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-slate-700">Source Tables</label>
                  <button onClick={selectAllSources} className="text-xs text-blue-600 hover:underline">
                    Select all
                  </button>
                </div>
                <div className="border border-slate-200 rounded-lg max-h-48 overflow-y-auto">
                  {availableSources.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedSources.has(s.id)}
                        onChange={() => toggleSource(s.id)}
                        className="rounded border-slate-300"
                      />
                      <span className="text-sm text-slate-700">{s.table_name}</span>
                      {s.display_name && s.display_name !== s.table_name && (
                        <span className="text-xs text-slate-400">({s.display_name})</span>
                      )}
                    </label>
                  ))}
                  {availableSources.length === 0 && (
                    <p className="p-3 text-sm text-slate-400">No tables found for this connection</p>
                  )}
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!createName.trim() || !createConnId || selectedSources.size === 0 || creating}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create Data Product'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Star Schema Viewer — uses ReactFlow (same style as source semantic relations)
// ---------------------------------------------------------------------------

function SchemaViewer({ product }: { product: FullDataProduct | null }) {
  if (!product) return <p className="text-center py-16 text-slate-400">Select a data product to view its star schema</p>;
  if (product.star_schemas.length === 0) return <p className="text-center py-16 text-slate-400">No star schemas designed yet</p>;

  return (
    <div className="space-y-8">
      {product.star_schemas.map((schema) => (
        <StarSchemaFlow key={schema.id} schema={schema} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lineage View — ReactFlow-based (same style as source semantic relations)
// ---------------------------------------------------------------------------

function LineageView({ product }: { product: FullDataProduct | null }) {
  const [viewMode, setViewMode] = useState<'flow' | 'table'>('flow');
  const [selectedCol, setSelectedCol] = useState<{ table: string; column: string; side: 'source' | 'product' } | null>(null);

  if (!product) return <p className="text-center py-16 text-slate-400">Select a data product to view lineage</p>;

  const allColumns = product.star_schemas.flatMap((s) =>
    s.tables.flatMap((t) =>
      t.columns.map((c) => ({ ...c, tableName: t.table_name, tableRole: t.table_role })),
    ),
  );

  const columnsWithLineage = allColumns.filter((c) => c.lineage && c.lineage.length > 0);

  // Build source → product column mapping
  const sourceToProduct = new Map<string, { productTable: string; productCol: string; transform: string }[]>();
  const productToSource = new Map<string, { sourceTable: string; sourceCol: string; transform: string }[]>();

  columnsWithLineage.forEach((c) => {
    c.lineage!.forEach((l) => {
      const sKey = `${l.source_table_name}.${l.source_column_name}`;
      const pKey = `${c.tableName}.${c.column_name}`;
      if (!sourceToProduct.has(sKey)) sourceToProduct.set(sKey, []);
      sourceToProduct.get(sKey)!.push({ productTable: c.tableName, productCol: c.column_name, transform: l.transformation_description ?? '' });
      if (!productToSource.has(pKey)) productToSource.set(pKey, []);
      productToSource.get(pKey)!.push({ sourceTable: l.source_table_name, sourceCol: l.source_column_name, transform: l.transformation_description ?? '' });
    });
  });

  // Collect unique source tables and their columns
  const sourceTableMap = new Map<string, Set<string>>();
  columnsWithLineage.forEach((c) =>
    c.lineage!.forEach((l) => {
      if (!sourceTableMap.has(l.source_table_name)) sourceTableMap.set(l.source_table_name, new Set());
      sourceTableMap.get(l.source_table_name)!.add(l.source_column_name);
    }),
  );
  const sourceTables = Array.from(sourceTableMap.entries()).sort(([a], [b]) => a.localeCompare(b));

  // Get highlighted columns based on selection
  const highlightedSourceCols = new Set<string>();
  const highlightedProductCols = new Set<string>();

  if (selectedCol) {
    if (selectedCol.side === 'source') {
      const key = `${selectedCol.table}.${selectedCol.column}`;
      highlightedSourceCols.add(key);
      (sourceToProduct.get(key) ?? []).forEach((p) => highlightedProductCols.add(`${p.productTable}.${p.productCol}`));
    } else {
      const key = `${selectedCol.table}.${selectedCol.column}`;
      highlightedProductCols.add(key);
      (productToSource.get(key) ?? []).forEach((s) => highlightedSourceCols.add(`${s.sourceTable}.${s.sourceCol}`));
    }
  }

  // Table-level: which source tables feed which product tables
  const sourceToProductTables = new Map<string, Set<string>>();
  columnsWithLineage.forEach((c) =>
    c.lineage!.forEach((l) => {
      if (!sourceToProductTables.has(l.source_table_name)) sourceToProductTables.set(l.source_table_name, new Set());
      sourceToProductTables.get(l.source_table_name)!.add(c.tableName);
    }),
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-800">Source-to-Target Lineage</h2>
        <div className="flex bg-slate-100 rounded-lg p-0.5">
          <button
            onClick={() => { setViewMode('flow'); setSelectedCol(null); }}
            className={`px-3 py-1 text-xs rounded-md ${viewMode === 'flow' ? 'bg-white shadow text-blue-600' : 'text-slate-500'}`}
          >
            Flow Diagram
          </button>
          <button
            onClick={() => { setViewMode('table'); setSelectedCol(null); }}
            className={`px-3 py-1 text-xs rounded-md ${viewMode === 'table' ? 'bg-white shadow text-blue-600' : 'text-slate-500'}`}
          >
            Table Mapping
          </button>
        </div>
      </div>

      {selectedCol && (
        <div className="mb-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 flex items-center justify-between animate-fadeIn">
          <div className="text-xs text-blue-700">
            <span className="font-semibold">{selectedCol.table}.{selectedCol.column}</span>
            {selectedCol.side === 'source' ? (
              <span className="ml-2 text-blue-500">&#8594; feeds {highlightedProductCols.size} product column(s)</span>
            ) : (
              <span className="ml-2 text-blue-500">&#8592; sourced from {highlightedSourceCols.size} source column(s)</span>
            )}
          </div>
          <button onClick={() => setSelectedCol(null)} className="text-xs text-blue-500 hover:text-blue-700">Clear</button>
        </div>
      )}

      {viewMode === 'flow' ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <LineageFlow data={{ tables: product.star_schemas.flatMap((s) => s.tables) }} />
        </div>
      ) : (
        /* ── Table mapping view ─── */
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Product Table</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Product Column</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Role</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Source Table</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Source Column</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Transformation</th>
              </tr>
            </thead>
            <tbody>
              {columnsWithLineage.map((col) =>
                col.lineage!.map((l, li) => {
                  const pKey = `${col.tableName}.${col.column_name}`;
                  const sKey = `${l.source_table_name}.${l.source_column_name}`;
                  const isActive = highlightedProductCols.has(pKey) || highlightedSourceCols.has(sKey);
                  return (
                    <tr
                      key={`${col.id}-${li}`}
                      onClick={() => setSelectedCol({ table: col.tableName, column: col.column_name, side: 'product' })}
                      className={`border-t border-slate-100 cursor-pointer transition-colors ${
                        isActive ? 'bg-blue-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="px-4 py-2 font-medium text-slate-700">{col.tableName}</td>
                      <td className="px-4 py-2 text-slate-600">{col.column_name}</td>
                      <td className="px-4 py-2"><ColumnRoleBadge role={col.column_role} /></td>
                      <td className="px-4 py-2 text-slate-600">{l.source_table_name}</td>
                      <td className="px-4 py-2 text-slate-600">{l.source_column_name}</td>
                      <td className="px-4 py-2 text-xs text-slate-500">{l.transformation_description}</td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transformations View component
// ---------------------------------------------------------------------------

function TransformationsView({
  product,
  selectedTableId,
  onSelectTable,
  onApprove,
  onRun,
  onRunAll,
  onRefresh,
  runningAll,
  runningTableId,
  onGenerateSql,
  generatingSql,
}: {
  product: FullDataProduct | null;
  selectedTableId: number | null;
  onSelectTable: (id: number) => void;
  onApprove: (id: number) => Promise<void>;
  onRun: (id: number) => Promise<void>;
  onRunAll?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
  runningAll?: boolean;
  runningTableId?: number | null;
  onGenerateSql?: () => Promise<void>;
  generatingSql?: boolean;
}) {
  const [editingSql, setEditingSql] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!product) {
    return <p className="text-center py-16 text-slate-400">Select a data product to manage transformations</p>;
  }

  const allTables = product.star_schemas
    .flatMap((s) => s.tables)
    .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name));

  const selected = allTables.find((t) => t.id === selectedTableId) ?? allTables[0] ?? null;

  const handleSaveSql = async () => {
    if (!selected || editingSql === null) return;
    setSaving(true);
    try {
      await api.put(`/products/tables/${selected.id}/sql`, { sql: editingSql });
      setEditingSql(null);
      onRefresh?.();
    } catch { /* ignore */ }
    setSaving(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-800">Transformations</h2>
        <div className="flex gap-2">
          {onGenerateSql && allTables.some((t) => !t.transformation_sql) && (
            <button
              onClick={onGenerateSql}
              disabled={generatingSql}
              className="px-4 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 disabled:opacity-50"
            >
              {generatingSql ? 'Generating SQL...' : 'Generate SQL'}
            </button>
          )}
          {onRunAll && allTables.some((t) => t.transformation_sql) && (
            <button
              onClick={onRunAll}
              disabled={runningAll}
              className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50"
            >
              {runningAll ? 'Running All...' : 'Run All'}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4">
        {/* Table list */}
        <div className="w-56 flex-shrink-0">
          {allTables.map((tbl) => {
            const hasFailedCheck = tbl.quality_checks?.some((c) => c.status === 'fail');
            const hasChecks = tbl.quality_checks && tbl.quality_checks.length > 0;
            const allPass = hasChecks && tbl.quality_checks!.every((c) => c.status === 'pass' || c.status === 'skip');
            return (
              <button
                key={tbl.id}
                onClick={() => { onSelectTable(tbl.id); setEditingSql(null); }}
                className={`w-full text-left px-3 py-2 rounded-lg mb-1 text-sm flex items-center gap-2 ${
                  selected?.id === tbl.id ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-600'
                }`}
              >
                <RoleBadge role={tbl.table_role} />
                <span className="truncate flex-1">{tbl.table_name}</span>
                {hasFailedCheck && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" title="Quality check failed" />}
                {allPass && <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" title="Quality checks passed" />}
                <StatusBadge status={tbl.transformation_status} />
              </button>
            );
          })}
        </div>

        {/* SQL editor */}
        {selected && (
          <div className="flex-1">
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800">{selected.table_name}</h3>
                  <p className="text-xs text-slate-500">{selected.description}</p>
                </div>
                <div className="flex gap-2">
                  {selected.transformation_status === 'draft' && (
                    <button
                      onClick={() => onApprove(selected.id)}
                      className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700"
                    >
                      Approve
                    </button>
                  )}
                  {(selected.transformation_status === 'approved' || selected.transformation_status === 'success' || selected.transformation_status === 'error') && (
                    <button
                      onClick={() => onRun(selected.id)}
                      disabled={runningTableId === selected.id || runningAll}
                      className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {runningTableId === selected.id ? 'Running...' : 'Run'}
                    </button>
                  )}
                </div>
              </div>

              <div className="p-4">
                {editingSql !== null ? (
                  <div>
                    <textarea
                      value={editingSql}
                      onChange={(e) => setEditingSql(e.target.value)}
                      rows={Math.max(10, (editingSql ?? '').split('\n').length + 2)}
                      className="w-full font-mono text-sm border border-slate-300 rounded-lg p-3 bg-slate-50 resize-y"
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={handleSaveSql}
                        disabled={saving}
                        className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingSql(null)}
                        className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <pre className="text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                      {selected.transformation_sql || 'No SQL generated yet'}
                    </pre>
                    {selected.transformation_sql && (
                      <button
                        onClick={() => setEditingSql(selected.transformation_sql!)}
                        className="mt-2 text-xs text-blue-600 hover:underline"
                      >
                        Edit SQL
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Run info */}
              {(selected.last_run_at || selected.last_run_error) && (
                <div className="px-4 py-3 border-t border-slate-100 bg-slate-50">
                  {selected.last_run_at && (
                    <p className="text-xs text-slate-500">
                      Last run: {new Date(selected.last_run_at).toLocaleString()}
                      {selected.row_count !== null && ` · ${selected.row_count.toLocaleString()} rows`}
                    </p>
                  )}
                  {selected.last_run_error && (
                    <p className="text-xs text-red-600 mt-1">{selected.last_run_error}</p>
                  )}
                </div>
              )}

              {/* Quality checks */}
              {selected.quality_checks && selected.quality_checks.length > 0 && (
                <div className="px-4 py-3 border-t border-slate-100">
                  <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Quality Checks</h4>
                  <div className="space-y-2">
                    {selected.quality_checks.map((chk) => {
                      const bkCols: string[] = typeof chk.bk_columns === 'string' ? JSON.parse(chk.bk_columns) : chk.bk_columns;
                      const samples: Record<string, unknown>[] = typeof chk.sample_duplicates === 'string' ? JSON.parse(chk.sample_duplicates) : chk.sample_duplicates;
                      const statusColor = chk.status === 'pass' ? 'bg-green-100 text-green-700'
                        : chk.status === 'fail' ? 'bg-red-100 text-red-700'
                        : chk.status === 'skip' ? 'bg-slate-100 text-slate-500'
                        : 'bg-amber-100 text-amber-700';
                      const label = chk.check_type === 'bk_uniqueness' ? 'BK Uniqueness' : 'Fan-out Detection';
                      return (
                        <div key={chk.id} className="bg-white border border-slate-200 rounded-lg p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-slate-700">{label}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}`}>
                              {chk.status.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mt-1">{chk.message}</p>
                          {bkCols.length > 0 && (
                            <p className="text-xs text-slate-400 mt-1">
                              BK columns: {bkCols.join(', ')}
                            </p>
                          )}
                          {chk.status === 'fail' && samples.length > 0 && (
                            <details className="mt-2">
                              <summary className="text-xs text-red-600 cursor-pointer hover:underline">
                                {samples.length} sample duplicate(s)
                              </summary>
                              <pre className="text-xs font-mono bg-red-50 rounded p-2 mt-1 overflow-x-auto max-h-40 overflow-y-auto">
                                {JSON.stringify(samples, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs View component
// ---------------------------------------------------------------------------

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

function KpisView({ product, onRefresh }: { product: FullDataProduct | null; onRefresh?: () => void }) {
  const [kpis, setKpis] = useState<ProductKpi[]>([]);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingKpi, setEditingKpi] = useState<ProductKpi | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPlainText, setFormPlainText] = useState('');
  const [formSql, setFormSql] = useState('');
  const [saving, setSaving] = useState(false);

  const loadKpis = useCallback(async () => {
    if (!product) return;
    setLoadingKpis(true);
    try {
      const res = await api.get(`/products/${product.id}/kpis`);
      setKpis(res.data.data ?? []);
    } catch { /* ignore */ }
    setLoadingKpis(false);
  }, [product]);

  useEffect(() => { loadKpis(); }, [loadKpis]);

  if (!product) {
    return <p className="text-center py-16 text-slate-400">Select a data product to manage KPIs</p>;
  }

  if (product.star_schemas.length === 0) {
    return (
      <div className="text-center py-16 text-slate-400">
        <p className="text-lg font-medium">No star schema designed yet</p>
        <p className="text-sm mt-1">Design a star schema first to define KPIs against your product tables.</p>
      </div>
    );
  }

  const resetForm = () => {
    setFormName('');
    setFormDesc('');
    setFormPlainText('');
    setFormSql('');
    setEditingKpi(null);
    setShowAdd(false);
  };

  const openEdit = (kpi: ProductKpi) => {
    setEditingKpi(kpi);
    setFormName(kpi.name);
    setFormDesc(kpi.description ?? '');
    setFormPlainText(kpi.formula_plain_text ?? '');
    setFormSql(kpi.formula_sql ?? '');
    setShowAdd(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      if (editingKpi) {
        await api.put(`/products/kpis/${editingKpi.id}`, {
          name: formName,
          description: formDesc || null,
          formula_plain_text: formPlainText || null,
          formula_sql: formSql || null,
          ai_draft: false,
        });
      } else {
        await api.post(`/products/${product.id}/kpis`, {
          name: formName,
          description: formDesc || undefined,
          formulaPlainText: formPlainText || undefined,
          formulaSql: formSql || undefined,
        });
      }
      resetForm();
      await loadKpis();
      onRefresh?.();
    } catch { /* ignore */ }
    setSaving(false);
  };

  const handleDelete = async (kpiId: number) => {
    if (!confirm('Delete this KPI?')) return;
    try {
      await api.delete(`/products/kpis/${kpiId}`);
      await loadKpis();
      onRefresh?.();
    } catch { /* ignore */ }
  };

  const handleApprove = async (kpi: ProductKpi) => {
    try {
      await api.put(`/products/kpis/${kpi.id}`, { ai_draft: false });
      await loadKpis();
    } catch { /* ignore */ }
  };

  // Product table names for reference in KPI formulas
  const tableNames = product.star_schemas.flatMap((s) => s.tables.map((t) => t.table_name));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-800">KPIs</h2>
        <button
          onClick={() => { resetForm(); setShowAdd(true); }}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          + Add KPI
        </button>
      </div>

      {/* Available tables reference */}
      <div className="mb-4 bg-slate-50 rounded-lg px-4 py-2 text-xs text-slate-500">
        <span className="font-semibold">Available tables: </span>
        {tableNames.join(', ')}
      </div>

      {loadingKpis && <p className="text-sm text-slate-400">Loading KPIs...</p>}

      {/* KPI cards */}
      {kpis.length === 0 && !loadingKpis && (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <p className="text-slate-500">No KPIs defined yet.</p>
          <p className="text-sm text-slate-400 mt-1">KPIs proposed by the AI during design will appear here automatically.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.id} className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-slate-800">{kpi.name}</h3>
                {kpi.ai_draft && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">AI Draft</span>
                )}
              </div>
              <div className="flex gap-1">
                {kpi.ai_draft && (
                  <button
                    onClick={() => handleApprove(kpi)}
                    className="text-[10px] px-2 py-1 bg-green-100 text-green-700 rounded hover:bg-green-200"
                  >
                    Approve
                  </button>
                )}
                <button
                  onClick={() => openEdit(kpi)}
                  className="text-[10px] px-2 py-1 bg-slate-100 text-slate-600 rounded hover:bg-slate-200"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(kpi.id)}
                  className="text-[10px] px-2 py-1 bg-red-50 text-red-600 rounded hover:bg-red-100"
                >
                  Delete
                </button>
              </div>
            </div>

            {kpi.description && (
              <p className="text-sm text-slate-600 mb-2">{kpi.description}</p>
            )}

            {kpi.formula_plain_text && (
              <div className="mb-2">
                <p className="text-[10px] font-semibold text-slate-400 uppercase">Business Definition</p>
                <p className="text-sm text-slate-700">{kpi.formula_plain_text}</p>
              </div>
            )}

            {kpi.formula_sql && (
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase">SQL Formula</p>
                <pre className="text-xs font-mono bg-slate-50 border border-slate-200 rounded px-2 py-1 mt-0.5 overflow-x-auto">
                  {kpi.formula_sql}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add/Edit KPI dialog */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">
              {editingKpi ? 'Edit KPI' : 'New KPI'}
            </h3>

            <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3"
              placeholder="e.g. Gross Margin, Revenue per Customer"
            />

            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3"
              rows={2}
              placeholder="What does this KPI measure?"
            />

            <label className="block text-sm font-medium text-slate-700 mb-1">Business Definition</label>
            <input
              value={formPlainText}
              onChange={(e) => setFormPlainText(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-3"
              placeholder="e.g. Revenue minus cost of goods sold"
            />

            <label className="block text-sm font-medium text-slate-700 mb-1">SQL Formula</label>
            <textarea
              value={formSql}
              onChange={(e) => setFormSql(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono mb-3"
              rows={3}
              placeholder="e.g. SUM(f.revenue) - SUM(f.cogs)"
            />

            <div className="bg-slate-50 rounded-lg px-3 py-2 mb-4 text-xs text-slate-500">
              <span className="font-semibold">Available tables: </span>
              {tableNames.join(', ')}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={resetForm}
                className="px-4 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!formName.trim() || saving}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : editingKpi ? 'Update KPI' : 'Create KPI'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
