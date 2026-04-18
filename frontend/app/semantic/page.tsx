'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import DatabaseTree from '@/components/semantic/DatabaseTree';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import ProductTableDetailPanel from '@/components/semantic/ProductTableDetailPanel';
import RelationshipCanvas from '@/components/semantic/RelationshipCanvas';
import KpiPanel from '@/components/semantic/KpiPanel';
import BulkImportModal from '@/components/semantic/BulkImportModal';
import HelpTooltip from '@/components/HelpTooltip';
import api from '@/lib/api';
import { isAdmin, getToken } from '@/lib/auth';
import { SourceTable, SourceColumn, KpiDefinition, CrossSourceView, ProductColumn, ProductTreeItem } from '@/components/semantic/types';

type MainTab = 'definitions' | 'relationships' | 'kpis';

interface Connection { id: number; name: string; domains?: string[]; }

function SemanticInner() {
  const params      = useSearchParams();
  const paramConnId = params.get('connectionId');

  // ── All connections ────────────────────────────────────────────────────────
  const [connections, setConnections]   = useState<Connection[]>([]);

  // ── Per-connection lazy data ───────────────────────────────────────────────
  const [tablesByConn, setTablesByConn]     = useState<Record<number, SourceTable[]>>({});
  const [columnsByTable, setColumnsByTable] = useState<Record<number, SourceColumn[]>>({});
  const [expandedConns, setExpandedConns]   = useState<Set<number>>(new Set());
  const [loadingConns, setLoadingConns]     = useState<Set<number>>(new Set());

  // ── Selection ──────────────────────────────────────────────────────────────
  const [activeConnId, setActiveConnId]     = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId]   = useState<number | null>(null);
  const [selectedColumnId, setSelectedColumnId] = useState<number | null>(null);
  const [zoomToTableId, setZoomToTableId]       = useState<number | null>(null);

  // ── KPIs (for active connection) ───────────────────────────────────────────
  const [kpis, setKpis] = useState<KpiDefinition[]>([]);

  const [tab, setTab] = useState<MainTab>('definitions');

  // ── Cross-source views (for Relationships tab) ────────────────────────────
  const [views, setViews] = useState<CrossSourceView[]>([]);
  const [activeViewId, setActiveViewId] = useState<number | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // ── Auto-approve settings ─────────────────────────────────────────────────
  const [showApprovalSettings, setShowApprovalSettings] = useState(false);
  const [autoApproveEnabled, setAutoApproveEnabled] = useState(true);
  const [autoApproveDays, setAutoApproveDays] = useState(7);
  const [approvalSettingsLoading, setApprovalSettingsLoading] = useState(false);
  const [approvalSettingsSaved, setApprovalSettingsSaved] = useState(false);

  // ── Product tree state ────────────────────────────────────────────────────
  const [productTree, setProductTree] = useState<ProductTreeItem[]>([]);
  const [productColumnsByTable, setProductColumnsByTable] = useState<Record<number, ProductColumn[]>>({});
  const [selectedProductTableId, setSelectedProductTableId] = useState<number | null>(null);
  const [selectedProductColumnId, setSelectedProductColumnId] = useState<number | null>(null);
  const [loadingProductColumns, setLoadingProductColumns] = useState<Set<number>>(new Set());
  // Track which layer is active: source or product
  const [selectionLayer, setSelectionLayer] = useState<'source' | 'product'>('source');

  const hasAutoExpanded = useRef<Set<number>>(new Set());

  // ── Load connections on mount ──────────────────────────────────────────────
  useEffect(() => {
    api.get('/connections').then((res) => {
      const conns: Connection[] = res.data.data ?? [];
      setConnections(conns);

      if (!conns.length) return;

      // Determine which connection to auto-expand & select
      let targetId: number | null = null;
      if (paramConnId) {
        targetId = Number(paramConnId);
      } else {
        const remembered = localStorage.getItem('databridge_last_conn');
        const valid = remembered && conns.some((c) => c.id === Number(remembered));
        targetId = valid ? Number(remembered) : conns[0].id;
      }

      if (targetId) {
        loadConnectionTables(targetId);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramConnId]);

  // ── Load product tree on mount ──────────────────────────────────────────────
  useEffect(() => {
    api.get('/semantic/product-tree').then((res) => {
      setProductTree(res.data.data ?? []);
    }).catch(() => {});
  }, []);

  // ── Load auto-approve settings on mount ─────────────────────────────────────
  useEffect(() => {
    if (!isAdmin()) return;
    api.get('/settings/approval').then((res) => {
      const d = res.data.data;
      if (d) {
        setAutoApproveEnabled(d.autoApproveAiDrafts ?? true);
        setAutoApproveDays(d.autoApproveDelayDays ?? 7);
      }
    }).catch(() => {});
  }, []);

  async function saveApprovalSettings() {
    setApprovalSettingsLoading(true);
    setApprovalSettingsSaved(false);
    try {
      await api.put('/settings/approval', {
        autoApproveAiDrafts: autoApproveEnabled,
        autoApproveDelayDays: autoApproveDays,
      });
      setApprovalSettingsSaved(true);
      setTimeout(() => setApprovalSettingsSaved(false), 2000);
    } catch {
      alert('Failed to save approval settings');
    } finally {
      setApprovalSettingsLoading(false);
    }
  }

  // ── Load tables + columns for a connection ─────────────────────────────────
  async function loadConnectionTables(connId: number) {
    if (hasAutoExpanded.current.has(connId)) return; // already loaded
    hasAutoExpanded.current.add(connId);

    setLoadingConns((prev) => new Set(prev).add(connId));
    try {
      const tRes = await api.get(`/semantic/tables?connectionId=${connId}`);
      const tbls: SourceTable[] = tRes.data.data ?? [];
      setTablesByConn((prev) => ({ ...prev, [connId]: tbls }));

      // Load columns in batches of 5 to avoid 429 rate limits
      const colMap: Record<number, SourceColumn[]> = {};
      const BATCH = 5;
      for (let i = 0; i < tbls.length; i += BATCH) {
        const batch = tbls.slice(i, i + BATCH);
        await Promise.all(batch.map(async (t) => {
          const r = await api.get(`/semantic/columns?tableId=${t.id}`);
          colMap[t.id] = r.data.data ?? [];
        }));
      }
      setColumnsByTable((prev) => ({ ...prev, ...colMap }));

      // Auto-select first table on first load
      if (tbls.length && !selectedTableId) {
        setActiveConnId(connId);
        setSelectedTableId(tbls[0].id);
      }
    } finally {
      setLoadingConns((prev) => { const s = new Set(prev); s.delete(connId); return s; });
    }
  }

  // ── Reload tables after a save ─────────────────────────────────────────────
  const reloadConnectionTables = useCallback(async (connId: number) => {
    const tRes = await api.get(`/semantic/tables?connectionId=${connId}`);
    const tbls: SourceTable[] = tRes.data.data ?? [];
    setTablesByConn((prev) => ({ ...prev, [connId]: tbls }));

    const colMap: Record<number, SourceColumn[]> = {};
    const BATCH = 5;
    for (let i = 0; i < tbls.length; i += BATCH) {
      const batch = tbls.slice(i, i + BATCH);
      await Promise.all(batch.map(async (t) => {
        const r = await api.get(`/semantic/columns?tableId=${t.id}`);
        colMap[t.id] = r.data.data ?? [];
      }));
    }
    setColumnsByTable((prev) => ({ ...prev, ...colMap }));
  }, []);

  // ── KPIs for active connection ─────────────────────────────────────────────
  const loadKpis = useCallback(async () => {
    if (!activeConnId) return;
    const res = await api.get(`/semantic/kpis?connectionId=${activeConnId}`);
    setKpis(res.data.data ?? []);
  }, [activeConnId]);

  useEffect(() => { loadKpis(); }, [loadKpis]);

  // ── Load cross-source views for active connection ─────────────────────────
  const loadViews = useCallback(async () => {
    if (!activeConnId) { setViews([]); return; }
    try {
      const res = await api.get(`/cross-views?connectionId=${activeConnId}`);
      setViews(res.data.data ?? res.data ?? []);
    } catch { setViews([]); }
  }, [activeConnId]);

  useEffect(() => { loadViews(); }, [loadViews]);

  async function handleCreateView() {
    const name = window.prompt('New view name:');
    if (!name || !activeConnId) return;
    try {
      const res = await api.post('/cross-views', { name, connectionId: activeConnId });
      await loadViews();
      const newId = res.data?.data?.id ?? res.data?.id;
      if (newId) setActiveViewId(newId);
    } catch { /* ignore */ }
  }

  async function handleDeleteView(viewId: number) {
    if (!confirm('Delete this view?')) return;
    try {
      await api.delete(`/cross-views/${viewId}`);
      if (activeViewId === viewId) setActiveViewId(null);
      await loadViews();
    } catch { /* ignore */ }
  }

  async function handleRenameView(viewId: number) {
    const v = views.find((vw) => vw.id === viewId);
    const name = window.prompt('Rename view:', v?.name ?? '');
    if (!name) return;
    try {
      await api.patch(`/cross-views/${viewId}`, { name });
      await loadViews();
    } catch { /* ignore */ }
  }

  // ── Toggle connection open/closed ─────────────────────────────────────────
  function handleToggleConnection(connId: number) {
    setExpandedConns((prev) => {
      const next = new Set(prev);
      if (next.has(connId)) {
        next.delete(connId);
      } else {
        next.add(connId);
        loadConnectionTables(connId);
        // Activating a connection switches the right panel to it
        setActiveConnId(connId);
        setSelectedTableId(null);
        setSelectedColumnId(null);
        localStorage.setItem('databridge_last_conn', String(connId));
      }
      return next;
    });
  }

  // ── Select a source table ────────────────────────────────────────────────────
  function handleSelectTable(connId: number, tableId: number) {
    setActiveConnId(connId);
    setSelectedTableId(tableId);
    setSelectedColumnId(null);
    setSelectedProductTableId(null);
    setSelectedProductColumnId(null);
    setSelectionLayer('source');
    setZoomToTableId(tableId);
    localStorage.setItem('databridge_last_conn', String(connId));
    if (tab === 'kpis') setTab('definitions');
  }

  function handleSelectColumn(tableId: number, columnId: number) {
    setSelectedColumnId(columnId);
    setSelectionLayer('source');
    if (tab === 'definitions') {
      setTimeout(() => {
        document.getElementById(`col-${columnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
    }
  }

  // ── Select a product table ─────────────────────────────────────────────────
  function handleSelectProductTable(productId: number, tableId: number) {
    setSelectedProductTableId(tableId);
    setSelectedProductColumnId(null);
    setSelectedTableId(null);
    setSelectedColumnId(null);
    setSelectionLayer('product');
    if (tab === 'kpis') setTab('definitions');

    // Lazy-load product columns
    if (!productColumnsByTable[tableId]) {
      setLoadingProductColumns((prev) => new Set(prev).add(tableId));
      api.get(`/semantic/product-columns?tablePgId=${tableId}`).then((res) => {
        const cols: ProductColumn[] = res.data.data ?? [];
        setProductColumnsByTable((prev) => ({ ...prev, [tableId]: cols }));
      }).catch(() => {}).finally(() => {
        setLoadingProductColumns((prev) => { const s = new Set(prev); s.delete(tableId); return s; });
      });
    }
  }

  function handleSelectProductColumn(tableId: number, columnId: number) {
    setSelectedProductColumnId(columnId);
    setSelectionLayer('product');
  }

  function handleCanvasSelectTable(tableId: number) {
    setSelectedTableId(tableId);
    setSelectedColumnId(null);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const allTables   = Object.values(tablesByConn).flat();
  const selectedTable = allTables.find((t) => t.id === selectedTableId) ?? null;
  const selectedCols  = selectedTableId ? (columnsByTable[selectedTableId] ?? []) : [];

  const tabBtn = (t: MainTab, label: string, icon: React.ReactNode) => (
    <button
      onClick={() => setTab(t)}
      className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all whitespace-nowrap relative ${
        tab === t
          ? 'text-white'
          : 'text-white/50 hover:text-white/80'
      }`}
    >
      {icon}
      {label}
      {tab === t && (
        <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-cyan-400 rounded-full shadow-glow-teal" />
      )}
    </button>
  );

  return (
    <div className="flex flex-col bg-surface" style={{ height: '100vh', overflow: 'hidden' }}>
      {/* Tab bar — gradient mesh style (no separate Nav bar — actions are inline) */}
      <div className="gradient-mesh px-4 flex items-center gap-0 flex-shrink-0 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute -top-6 -left-6 w-24 h-24 rounded-full bg-white/[0.03]" />
        <div className="absolute -bottom-4 right-1/3 w-16 h-16 rounded-full bg-white/[0.02]" />

        <div className="relative flex items-center gap-0">
          {tabBtn('definitions', 'Tables & Columns', (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M3 6h18M3 18h18" />
            </svg>
          ))}
          <HelpTooltip text="Define what your tables and columns mean so the AI understands your data. Confirm AI drafts or edit descriptions." />
          {tabBtn('relationships', 'Relationships', (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
            </svg>
          ))}
          <HelpTooltip text="Define how tables relate to each other (foreign keys). This helps the AI write correct JOIN queries." />
          {tabBtn('kpis', 'KPIs', (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          ))}
          <HelpTooltip text="Define business KPIs with SQL formulas. The AI uses these to answer metric questions accurately." />
        </div>

        {/* Spacer + action buttons */}
        <div className="flex-1" />
        {isAdmin() && activeConnId && (
          <div className="relative flex items-center gap-2 py-2">
            <button
              onClick={() => setShowImportModal(true)}
              className="px-3.5 py-1.5 text-xs font-semibold text-white/80 bg-white/10 border border-white/15 rounded-xl hover:bg-white/15 hover:text-white transition-all backdrop-blur-sm"
            >
              Import Definitions
            </button>
            <button
              onClick={async () => {
                try {
                  const res = await api.get(`/semantic/dictionary?connectionId=${activeConnId}&format=html`, { responseType: 'blob' });
                  const blob = new Blob([res.data], { type: 'text/html' });
                  const url = URL.createObjectURL(blob);
                  window.open(url, '_blank');
                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                } catch (err) {
                  alert('Failed to load data dictionary. Check the console for details.');
                  console.error('Dictionary error:', err);
                }
              }}
              className="px-3.5 py-1.5 text-xs font-semibold text-cyan-300 bg-cyan-500/15 border border-cyan-400/20 rounded-xl hover:bg-cyan-500/25 transition-all backdrop-blur-sm"
            >
              Data Dictionary
            </button>
            {/* Export Dictionary dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowExportMenu((v) => !v)}
                className="px-3.5 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-500/15 border border-emerald-400/20 rounded-xl hover:bg-emerald-500/25 transition-all backdrop-blur-sm"
              >
                Export Dictionary
              </button>
              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-white/10 rounded-xl shadow-xl overflow-hidden min-w-[140px]">
                  <button
                    className="w-full px-4 py-2 text-xs text-left text-slate-200 hover:bg-white/10 transition-colors"
                    onClick={() => {
                      setShowExportMenu(false);
                      const backendUrl = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';
                      const url = `${backendUrl}/api/semantic/export/csv?connectionId=${activeConnId}`;
                      const token = getToken();
                      fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
                        .then((r) => r.blob())
                        .then((blob) => {
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `data-dictionary-${activeConnId}.csv`;
                          a.click();
                          URL.revokeObjectURL(a.href);
                        })
                        .catch(() => alert('Export failed'));
                    }}
                  >
                    Export as CSV
                  </button>
                  <button
                    className="w-full px-4 py-2 text-xs text-left text-slate-200 hover:bg-white/10 transition-colors"
                    onClick={() => {
                      setShowExportMenu(false);
                      const backendUrl = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';
                      const url = `${backendUrl}/api/semantic/export/xlsx?connectionId=${activeConnId}`;
                      const token = getToken();
                      fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
                        .then((r) => r.blob())
                        .then((blob) => {
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `data-dictionary-${activeConnId}.xlsx`;
                          a.click();
                          URL.revokeObjectURL(a.href);
                        })
                        .catch(() => alert('Export failed'));
                    }}
                  >
                    Export as XLSX
                  </button>
                </div>
              )}
            </div>
            {/* Auto-approve settings gear */}
            <div className="relative">
              <button
                onClick={() => setShowApprovalSettings((v) => !v)}
                className="p-1.5 text-white/50 hover:text-white/80 transition-colors rounded-lg hover:bg-white/10"
                title="AI suggestion settings"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              {showApprovalSettings && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-white/10 rounded-xl shadow-xl p-4 min-w-[280px]">
                  <div className="text-xs font-semibold text-white/90 mb-3">AI Suggestion Settings</div>
                  <label className="flex items-center gap-2.5 cursor-pointer mb-3">
                    <input
                      type="checkbox"
                      checked={autoApproveEnabled}
                      onChange={(e) => setAutoApproveEnabled(e.target.checked)}
                      className="w-4 h-4 rounded border-white/20 bg-white/10 text-cyan-500 focus:ring-cyan-400/50 accent-cyan-500"
                    />
                    <span className="text-xs text-white/80">Auto-confirm AI suggestions</span>
                  </label>
                  {autoApproveEnabled && (
                    <div className="flex items-center gap-2 mb-3 pl-6">
                      <span className="text-xs text-white/60">after</span>
                      <input
                        type="number"
                        min={1}
                        max={90}
                        value={autoApproveDays}
                        onChange={(e) => setAutoApproveDays(Math.max(1, Math.min(90, Number(e.target.value) || 7)))}
                        className="w-14 px-2 py-1 text-xs bg-white/10 border border-white/15 rounded-lg text-white text-center focus:outline-none focus:ring-1 focus:ring-cyan-400/50"
                      />
                      <span className="text-xs text-white/60">days with no review</span>
                    </div>
                  )}
                  <p className="text-[10px] text-white/40 mb-3 leading-relaxed">
                    When enabled, AI-generated definitions are automatically confirmed if no one reviews them within the specified number of days.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={saveApprovalSettings}
                      disabled={approvalSettingsLoading}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-cyan-500/30 border border-cyan-400/20 rounded-lg hover:bg-cyan-500/40 transition-all disabled:opacity-50"
                    >
                      {approvalSettingsLoading ? 'Saving...' : 'Save'}
                    </button>
                    {approvalSettingsSaved && (
                      <span className="text-xs text-emerald-400">Saved</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — dark tree, no white bg or border */}
        <div className="flex-shrink-0 overflow-y-auto" style={{ width: 260 }}>
            <DatabaseTree
              connections={connections}
              tablesByConnection={tablesByConn}
              columnsByTable={columnsByTable}
              expandedConnectionIds={expandedConns}
              loadingConnectionIds={loadingConns}
              activeConnectionId={activeConnId}
              selectedTableId={selectionLayer === 'source' ? selectedTableId : null}
              selectedColumnId={selectionLayer === 'source' ? selectedColumnId : null}
              onToggleConnection={handleToggleConnection}
              onSelectTable={handleSelectTable}
              onSelectColumn={handleSelectColumn}
              productTree={productTree}
              productColumnsByTable={productColumnsByTable}
              selectedProductTableId={selectionLayer === 'product' ? selectedProductTableId : null}
              selectedProductColumnId={selectionLayer === 'product' ? selectedProductColumnId : null}
              onSelectProductTable={handleSelectProductTable}
              onSelectProductColumn={handleSelectProductColumn}
            />
        </div>

        {/* Right panel — overflow-hidden for canvas tabs so flex heights propagate correctly */}
        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          {tab === 'definitions' && (
            selectionLayer === 'product' && selectedProductTableId ? (
              <ProductTableDetailPanel
                key={`pt-${selectedProductTableId}`}
                tableId={selectedProductTableId}
                productTree={productTree}
                columns={productColumnsByTable[selectedProductTableId] ?? []}
                focusColumnId={selectedProductColumnId}
                onSaved={() => {
                  // Reload product tree + columns
                  api.get('/semantic/product-tree').then((res) => setProductTree(res.data.data ?? [])).catch(() => {});
                  api.get(`/semantic/product-columns?tablePgId=${selectedProductTableId}`).then((res) => {
                    setProductColumnsByTable((prev) => ({ ...prev, [selectedProductTableId!]: res.data.data ?? [] }));
                  }).catch(() => {});
                }}
              />
            ) : selectedTable ? (
              <TableDetailPanel
                key={selectedTable.id}
                table={selectedTable}
                columns={selectedCols}
                focusColumnId={selectedColumnId}
                connectionDomains={connections.find((c) => c.id === activeConnId)?.domains ?? []}
                onSaved={() => activeConnId && reloadConnectionTables(activeConnId)}
              />
            ) : connections.length === 0 ? (
              <div className="flex flex-col items-center justify-center flex-1 text-center py-16 px-4 bg-gradient-to-br from-surface via-surface to-surface-container-low/30 animate-fadeIn">
                <div className="w-20 h-20 rounded-2xl gradient-mesh flex items-center justify-center mb-5 shadow-glow-teal">
                  <svg className="w-10 h-10 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
                <h3 className="text-lg font-headline font-bold text-slate-800 mb-1">No data sources connected</h3>
                <p className="text-sm text-slate-500 max-w-md mb-6">
                  Connect a database to start building your data dictionary. The AI will draft definitions for all your tables and columns.
                </p>
                <a href="/setup" className="px-6 py-2.5 gradient-primary text-white rounded-xl text-sm font-semibold hover:opacity-90 transition-all shadow-glow-primary hover:shadow-glow-teal-md">
                  Connect a source
                </a>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-center py-16 px-4 bg-gradient-to-br from-surface via-surface to-surface-container-low/30 animate-fadeIn">
                <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                </div>
                <p className="text-sm text-slate-400">Select a table from the left panel to view and edit its definitions</p>
              </div>
            )
          )}

          {tab === 'relationships' && (
            <div className="flex-1 min-h-0 flex flex-col" style={{ height: '100%' }}>
              <div className="flex-1 min-h-0">
                <RelationshipCanvas
                  connectionId={String(activeConnId ?? '')}
                  tables={activeConnId ? (tablesByConn[activeConnId] ?? []) : []}
                  columnsByTable={columnsByTable}
                  focusTableId={selectedTableId}
                  focusColumnId={selectedColumnId}
                  zoomToTableId={zoomToTableId}
                  onSelectTable={handleCanvasSelectTable}
                  onSelectColumn={handleSelectColumn}
                  onClearSelection={() => { setSelectedTableId(null); setSelectedColumnId(null); }}
                  viewId={activeViewId}
                />
              </div>
              {/* View tab bar */}
              <div className="h-10 border-t border-slate-200/50 bg-surface-container-lowest flex items-center gap-0 px-2 overflow-x-auto flex-shrink-0">
                <button
                  onClick={() => setActiveViewId(null)}
                  className={`px-3.5 h-full text-xs whitespace-nowrap transition-all ${
                    activeViewId === null
                      ? 'border-b-2 border-cyan-500 text-primary font-semibold'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  All tables
                </button>
                {views.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setActiveViewId(v.id)}
                    onDoubleClick={(e) => { e.preventDefault(); handleRenameView(v.id); }}
                    className={`px-3.5 h-full text-xs whitespace-nowrap transition-all flex items-center gap-1 ${
                      activeViewId === v.id
                        ? 'border-b-2 border-cyan-500 text-primary font-semibold'
                        : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {v.name}
                    <span
                      onClick={(e) => { e.stopPropagation(); handleDeleteView(v.id); }}
                      className="ml-1 text-slate-300 hover:text-red-500 cursor-pointer text-sm leading-none transition-colors"
                      title="Delete view"
                    >
                      &times;
                    </span>
                  </button>
                ))}
                <button
                  onClick={handleCreateView}
                  className="px-2.5 h-full text-slate-300 hover:text-cyan-600 text-lg leading-none transition-colors"
                  title="Create new view"
                >
                  +
                </button>
              </div>
            </div>
          )}

          {tab === 'kpis' && (
            <KpiPanel
              connectionId={String(activeConnId ?? '')}
              kpis={kpis}
              onSaved={loadKpis}
            />
          )}

        </div>
      </div>

      {/* Bulk Import Modal */}
      {showImportModal && activeConnId && (
        <BulkImportModal
          connectionId={activeConnId}
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            if (activeConnId) reloadConnectionTables(activeConnId);
          }}
        />
      )}
    </div>
  );
}

export default function SemanticPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-400">Loading…</div>
    }>
      <SemanticInner />
    </Suspense>
  );
}
