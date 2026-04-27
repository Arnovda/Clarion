'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import CatalogBrowser, { type CatalogSelection } from '@/components/catalog/CatalogBrowser';
import { parseIdFromSlug } from '@/lib/catalog';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import ProductTableDetailPanel from '@/components/semantic/ProductTableDetailPanel';
import RelationshipCanvas from '@/components/semantic/RelationshipCanvas';
import BulkImportModal from '@/components/semantic/BulkImportModal';
import HelpTooltip from '@/components/HelpTooltip';
import api from '@/lib/api';
import { isAdmin, getToken } from '@/lib/auth';
import { useToast } from '@/components/ui/Toast';
import { SourceTable, SourceColumn, CrossSourceView, ProductColumn, ProductTreeItem } from '@/components/semantic/types';

type MainTab = 'definitions' | 'relationships';

interface Connection { id: number; name: string; domains?: string[]; }

function SemanticInner() {
  const toast       = useToast();
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

  // ── Batch approve ─────────────────────────────────────────────────────────
  const [pendingCount, setPendingCount] = useState(0);
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveProgress, setApproveProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  // ── Product tree state ────────────────────────────────────────────────────
  const [productTree, setProductTree] = useState<ProductTreeItem[]>([]);
  const [productColumnsByTable, setProductColumnsByTable] = useState<Record<number, ProductColumn[]>>({});
  const [selectedProductTableId, setSelectedProductTableId] = useState<number | null>(null);
  const [selectedProductColumnId, setSelectedProductColumnId] = useState<number | null>(null);
  const [loadingProductColumns, setLoadingProductColumns] = useState<Set<number>>(new Set());
  // Track which layer is active: source or product
  const [selectionLayer, setSelectionLayer] = useState<'source' | 'product'>('source');

  // ── Catalog browser selection (mirrors current selection for the new tree) ──
  const [catalogSelection, setCatalogSelection] = useState<CatalogSelection | null>(null);

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
      toast.error('Could not save approval settings');
    } finally {
      setApprovalSettingsLoading(false);
    }
  }

  // ── Pending AI draft count (refreshed on admin mount) ─────────────────────
  const refreshPendingCount = useCallback(async () => {
    if (!isAdmin()) return;
    try {
      const res = await api.get('/semantic/pending-approvals');
      setPendingCount((res.data.data ?? []).length);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshPendingCount(); }, [refreshPendingCount]);

  // ── Batch approve all AI drafts ───────────────────────────────────────────
  async function approveAllDrafts() {
    if (approvingAll) return;
    try {
      const res = await api.get('/semantic/pending-approvals');
      const items: Array<{ id: number; type: 'table' | 'column' | 'kpi' }> = res.data.data ?? [];
      if (items.length === 0) {
        toast.info('No AI suggestions to approve');
        return;
      }
      if (!confirm(`Approve all ${items.length} AI suggestion${items.length === 1 ? '' : 's'}? This cannot be undone individually.`)) {
        return;
      }
      setApprovingAll(true);
      setApproveProgress({ done: 0, total: items.length });

      let ok = 0;
      let failed = 0;
      for (let i = 0; i < items.length; i++) {
        try {
          await api.post('/semantic/approve', {
            entityType: items[i].type,
            entityId:   items[i].id,
            action:     'approve',
          });
          ok++;
        } catch {
          failed++;
        }
        setApproveProgress({ done: i + 1, total: items.length });
      }

      if (failed === 0) {
        toast.success(`Approved ${ok} suggestion${ok === 1 ? '' : 's'}`);
      } else {
        toast.warn(`Approved ${ok} of ${items.length}`, {
          description: `${failed} could not be approved. Try again or review individually.`,
        });
      }
      refreshPendingCount();
      // Reload tables so confirmed ones shed their AI-draft badge
      if (activeConnId) {
        hasAutoExpanded.current.delete(activeConnId);
        await loadConnectionTables(activeConnId);
      }
    } finally {
      setApprovingAll(false);
      setApproveProgress({ done: 0, total: 0 });
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

  // ── Catalog browser → existing handlers ──────────────────────────────────
  async function handleCatalogSelect(sel: CatalogSelection) {
    setCatalogSelection(sel);
    const schemaId = parseIdFromSlug(sel.schemaSlug);
    if (schemaId == null) return;
    const tableId = Number(sel.tableId);
    if (!Number.isFinite(tableId)) return;

    if (sel.catalog === 'sources') {
      // Make sure the connection's tables/columns are loaded so detail panel works
      if (!tablesByConn[schemaId]) await loadConnectionTables(schemaId);
      handleSelectTable(schemaId, tableId);
    } else {
      handleSelectProductTable(schemaId, tableId);
    }
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
      className={`flex items-center gap-2 px-4 py-3 text-[13px] font-medium transition-colors whitespace-nowrap relative ${
        tab === t
          ? 'text-ink'
          : 'text-muted hover:text-ink-2'
      }`}
    >
      {icon}
      {label}
      {tab === t && (
        <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />
      )}
    </button>
  );

  return (
    <div className="flex flex-col bg-bg" style={{ height: '100vh', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div className="bg-raised border-b border-line px-4 flex items-center gap-0 flex-shrink-0">
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
        </div>

        {/* Spacer + action buttons */}
        <div className="flex-1" />
        {isAdmin() && activeConnId && (
          <div className="relative flex items-center gap-1.5 py-2">
            {pendingCount > 0 && (
              <button
                onClick={approveAllDrafts}
                disabled={approvingAll}
                className="px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors flex items-center gap-1.5"
                title="Approve every AI-drafted table, column and KPI definition in one go"
              >
                {approvingAll ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {approveProgress.done}/{approveProgress.total}
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Approve all AI suggestions ({pendingCount})
                  </>
                )}
              </button>
            )}
            <button
              onClick={() => setShowImportModal(true)}
              className="px-3 py-1.5 text-[12px] text-ink-2 bg-raised border border-line rounded-md hover:bg-softer hover:border-line-strong transition-colors"
            >
              Import definitions
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
              className="px-3 py-1.5 text-[12px] text-ocean bg-ocean-softer border border-line rounded-md hover:bg-ocean-soft transition-colors"
            >
              Data dictionary
            </button>
            {/* Export Dictionary dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowExportMenu((v) => !v)}
                className="px-3 py-1.5 text-[12px] text-ok bg-ok-soft border border-line rounded-md hover:bg-ok/15 transition-colors"
              >
                Export dictionary
              </button>
              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-raised border border-line rounded-md shadow-2 overflow-hidden min-w-[160px]">
                  <button
                    className="w-full px-4 py-2 text-[12px] text-left text-ink-2 hover:bg-softer transition-colors"
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
                    className="w-full px-4 py-2 text-[12px] text-left text-ink-2 hover:bg-softer transition-colors border-t border-line"
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
                className="w-8 h-8 flex items-center justify-center text-muted hover:text-ink-2 transition-colors rounded-md hover:bg-softer"
                title="AI suggestion settings"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              {showApprovalSettings && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-raised border border-line rounded-md shadow-2 p-4 min-w-[300px]">
                  <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-3">AI suggestion settings</p>
                  <label className="flex items-center gap-2.5 cursor-pointer mb-3">
                    <input
                      type="checkbox"
                      checked={autoApproveEnabled}
                      onChange={(e) => setAutoApproveEnabled(e.target.checked)}
                      className="w-4 h-4 rounded border-line accent-ocean"
                    />
                    <span className="text-[12px] text-ink-2">Auto-confirm AI suggestions</span>
                  </label>
                  {autoApproveEnabled && (
                    <div className="flex items-center gap-2 mb-3 pl-6">
                      <span className="text-[11px] text-muted">after</span>
                      <input
                        type="number"
                        min={1}
                        max={90}
                        value={autoApproveDays}
                        onChange={(e) => setAutoApproveDays(Math.max(1, Math.min(90, Number(e.target.value) || 7)))}
                        className="w-14 px-2 py-1 text-[12px] bg-raised border border-line rounded-md text-ink-2 text-center focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                      />
                      <span className="text-[11px] text-muted">days with no review</span>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-2 mb-3 leading-relaxed">
                    When enabled, AI-generated definitions are automatically confirmed if no one reviews them within the specified number of days.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={saveApprovalSettings}
                      disabled={approvalSettingsLoading}
                      className="px-3 py-1.5 text-[12px] font-medium text-white bg-ocean rounded-md hover:bg-ocean-hover transition-colors disabled:opacity-50"
                    >
                      {approvalSettingsLoading ? 'Saving…' : 'Save'}
                    </button>
                    {approvalSettingsSaved && (
                      <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ok">Saved</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — Unity-Catalog-style three-level browser */}
        <div className="flex-shrink-0 border-r border-line" style={{ width: 280 }}>
            <CatalogBrowser
              selected={catalogSelection}
              onSelectTable={handleCatalogSelect}
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
              <div className="flex flex-col items-center justify-center flex-1 text-center py-16 px-4 bg-bg animate-fadeIn">
                <div className="w-16 h-16 rounded-md bg-softer border border-line flex items-center justify-center mb-5 text-muted-2">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
                <h3 className="font-display text-[22px] font-medium text-ink mb-2">No data sources connected</h3>
                <p className="text-[14px] text-muted max-w-md mb-6">
                  Connect a database to start building your data dictionary. The AI will draft definitions for all your tables and columns.
                </p>
                <a href="/setup" className="px-5 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover transition-colors">
                  Connect a source
                </a>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-center py-16 px-4 bg-bg animate-fadeIn">
                <div className="w-12 h-12 rounded-md bg-softer border border-line flex items-center justify-center mb-4 text-muted-2">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                </div>
                <p className="text-[13px] text-ink-3">Select a table from the left panel to view and edit its definitions.</p>
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
              <div className="h-10 border-t border-line bg-raised flex items-center gap-0 px-2 overflow-x-auto flex-shrink-0">
                <button
                  onClick={() => setActiveViewId(null)}
                  className={`px-3 h-full text-[12px] whitespace-nowrap transition-colors ${
                    activeViewId === null
                      ? 'border-b-2 border-ocean text-ink font-medium'
                      : 'text-muted hover:text-ink-2'
                  }`}
                >
                  All tables
                </button>
                {views.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setActiveViewId(v.id)}
                    onDoubleClick={(e) => { e.preventDefault(); handleRenameView(v.id); }}
                    className={`px-3 h-full text-[12px] whitespace-nowrap transition-colors flex items-center gap-1 ${
                      activeViewId === v.id
                        ? 'border-b-2 border-ocean text-ink font-medium'
                        : 'text-muted hover:text-ink-2'
                    }`}
                  >
                    {v.name}
                    <span
                      onClick={(e) => { e.stopPropagation(); handleDeleteView(v.id); }}
                      className="ml-1 text-muted-2 hover:text-err cursor-pointer text-sm leading-none transition-colors"
                      title="Delete view"
                    >
                      &times;
                    </span>
                  </button>
                ))}
                <button
                  onClick={handleCreateView}
                  className="px-2.5 h-full text-muted hover:text-ocean text-lg leading-none transition-colors"
                  title="Create new view"
                >
                  +
                </button>
              </div>
            </div>
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
