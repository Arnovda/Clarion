'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Nav from '@/components/Nav';
import DatabaseTree from '@/components/semantic/DatabaseTree';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import RelationshipCanvas from '@/components/semantic/RelationshipCanvas';
import KpiPanel from '@/components/semantic/KpiPanel';
import PathFinderPanel from '@/components/semantic/PathFinderPanel';
import QualityPanel from '@/components/QualityPanel';
import QualityAlertBanner from '@/components/QualityAlertBanner';
import IntegrationsPanel from '@/components/IntegrationsPanel';
import AuditPanel from '@/components/semantic/AuditPanel';
import BulkImportModal from '@/components/semantic/BulkImportModal';
import api from '@/lib/api';
import { isAdmin } from '@/lib/auth';
import { SourceTable, SourceColumn, KpiDefinition, CrossSourceView } from '@/components/semantic/types';

type MainTab = 'definitions' | 'relationships' | 'pathfinder' | 'kpis' | 'quality' | 'integrations' | 'audit';

interface QualityTableItem {
  id:               number;
  connection_id:    number;
  table_name:       string;
  display_name:     string;
  layer:            'source' | 'product';
  product_name:     string | null;
  product_table_id: number | null;
  table_role:       string | null;
  overall_score:    number | null;
  rag:              'green' | 'amber' | 'red' | 'grey';
}

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

  // ── Quality tab ────────────────────────────────────────────────────────────
  const [qualityTables, setQualityTables]             = useState<QualityTableItem[]>([]);
  const [qualityTablesLoading, setQualityTablesLoading] = useState(false);
  const [selectedQualityItem, setSelectedQualityItem]  = useState<QualityTableItem | null>(null);

  // ── Cross-source views (for Relationships tab) ────────────────────────────
  const [views, setViews] = useState<CrossSourceView[]>([]);
  const [activeViewId, setActiveViewId] = useState<number | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);

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
        setExpandedConns(new Set([targetId]));
        loadConnectionTables(targetId);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramConnId]);

  // ── Load tables + columns for a connection ─────────────────────────────────
  async function loadConnectionTables(connId: number) {
    if (hasAutoExpanded.current.has(connId)) return; // already loaded
    hasAutoExpanded.current.add(connId);

    setLoadingConns((prev) => new Set(prev).add(connId));
    try {
      const tRes = await api.get(`/semantic/tables?connectionId=${connId}`);
      const tbls: SourceTable[] = tRes.data.data ?? [];
      setTablesByConn((prev) => ({ ...prev, [connId]: tbls }));

      // Load columns for every table in parallel
      const colMap: Record<number, SourceColumn[]> = {};
      await Promise.all(tbls.map(async (t) => {
        const r = await api.get(`/semantic/columns?tableId=${t.id}`);
        colMap[t.id] = r.data.data ?? [];
      }));
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
    await Promise.all(tbls.map(async (t) => {
      const r = await api.get(`/semantic/columns?tableId=${t.id}`);
      colMap[t.id] = r.data.data ?? [];
    }));
    setColumnsByTable((prev) => ({ ...prev, ...colMap }));
  }, []);

  // ── KPIs for active connection ─────────────────────────────────────────────
  const loadKpis = useCallback(async () => {
    if (!activeConnId) return;
    const res = await api.get(`/semantic/kpis?connectionId=${activeConnId}`);
    setKpis(res.data.data ?? []);
  }, [activeConnId]);

  useEffect(() => { loadKpis(); }, [loadKpis]);

  // ── Load quality tables (source + product) ───────────────────────────────
  async function loadQualityTables() {
    setQualityTablesLoading(true);
    try {
      const res = await api.get('/quality/tables');
      const items: QualityTableItem[] = res.data.data ?? [];
      setQualityTables(items);
      if (!selectedQualityItem && items.length) setSelectedQualityItem(items[0]);
    } catch { /* ignore */ }
    setQualityTablesLoading(false);
  }

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

  // ── Select a table ─────────────────────────────────────────────────────────
  function handleSelectTable(connId: number, tableId: number) {
    setActiveConnId(connId);
    setSelectedTableId(tableId);
    setSelectedColumnId(null);
    setZoomToTableId(tableId);
    localStorage.setItem('databridge_last_conn', String(connId));
    // Switching tables while on KPIs → go back to definitions; Quality stays on quality
    if (tab === 'kpis') setTab('definitions');
  }

  function handleSelectColumn(tableId: number, columnId: number) {
    setSelectedColumnId(columnId);
    if (tab === 'definitions') {
      setTimeout(() => {
        document.getElementById(`col-${columnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
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

  function handleTabChange(t: MainTab) {
    setTab(t);
    if (t === 'quality' && qualityTables.length === 0) loadQualityTables();
  }

  const tabBtn = (t: MainTab, label: string) => (
    <button
      onClick={() => handleTabChange(t)}
      className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        tab === t ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col bg-slate-50" style={{ height: '100vh', overflow: 'hidden' }}>
      <Nav />

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200 px-4 flex items-center gap-0 flex-shrink-0">
        {tabBtn('definitions', 'Tables & Columns')}
        {tabBtn('quality', 'Quality')}
        {tabBtn('relationships', 'Relationships')}
        {tabBtn('pathfinder', 'Path Finder')}
        {tabBtn('integrations', 'Integrations')}
        {tabBtn('kpis', 'KPIs')}
        {tabBtn('audit', 'Audit Trail')}

        {/* Spacer + action buttons */}
        <div className="flex-1" />
        {isAdmin() && activeConnId && (
          <div className="flex items-center gap-2 py-2">
            <button
              onClick={() => setShowImportModal(true)}
              className="px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
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
              className="px-3 py-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors"
            >
              Data Dictionary
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <div className="flex-shrink-0 overflow-y-auto bg-white border-r border-slate-200" style={{ width: 260 }}>
          {tab === 'quality' ? (
            <div className="flex flex-col h-full">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Data Health</span>
                <button onClick={loadQualityTables} className="text-slate-400 hover:text-blue-600 text-sm" title="Refresh">↺</button>
              </div>
              {qualityTablesLoading ? (
                <div className="p-4 text-xs text-slate-400">Loading…</div>
              ) : (
                <div className="overflow-y-auto flex-1">
                  {/* Sources section */}
                  {qualityTables.filter((t) => t.layer === 'source').length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-50">Sources</div>
                      {qualityTables.filter((t) => t.layer === 'source').map((t) => (
                        <button
                          key={`src-${t.id}`}
                          onClick={() => setSelectedQualityItem(t)}
                          className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-slate-50 transition-colors ${
                            selectedQualityItem?.id === t.id && selectedQualityItem?.layer === 'source' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            t.rag === 'green' ? 'bg-emerald-500' :
                            t.rag === 'amber' ? 'bg-amber-400' :
                            t.rag === 'red'   ? 'bg-red-500'   : 'bg-slate-300'
                          }`} />
                          <span className="truncate">{t.display_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Products section — grouped by product_name */}
                  {qualityTables.filter((t) => t.layer === 'product').length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-50">Products</div>
                      {Array.from(new Set(qualityTables.filter((t) => t.layer === 'product').map((t) => t.product_name))).map((prodName) => (
                        <div key={prodName}>
                          <div className="px-3 py-1 text-xs text-slate-500 font-medium bg-white border-b border-slate-100">{prodName}</div>
                          {qualityTables.filter((t) => t.layer === 'product' && t.product_name === prodName).map((t) => (
                            <button
                              key={`prod-${t.product_table_id}`}
                              onClick={() => setSelectedQualityItem(t)}
                              className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 hover:bg-slate-50 transition-colors ${
                                selectedQualityItem?.product_table_id === t.product_table_id && selectedQualityItem?.layer === 'product' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700'
                              }`}
                            >
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                t.rag === 'green' ? 'bg-emerald-500' :
                                t.rag === 'amber' ? 'bg-amber-400' :
                                t.rag === 'red'   ? 'bg-red-500'   : 'bg-slate-300'
                              }`} />
                              <span className="truncate">{t.display_name}</span>
                              {t.table_role && (
                                <span className={`ml-auto text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${
                                  t.table_role === 'fact' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                }`}>{t.table_role}</span>
                              )}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {qualityTables.length === 0 && (
                    <div className="p-4 text-xs text-slate-400">No profiled tables yet</div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <DatabaseTree
              connections={connections}
              tablesByConnection={tablesByConn}
              columnsByTable={columnsByTable}
              expandedConnectionIds={expandedConns}
              loadingConnectionIds={loadingConns}
              activeConnectionId={activeConnId}
              selectedTableId={selectedTableId}
              selectedColumnId={selectedColumnId}
              onToggleConnection={handleToggleConnection}
              onSelectTable={handleSelectTable}
              onSelectColumn={handleSelectColumn}
            />
          )}
        </div>

        {/* Right panel — overflow-hidden for canvas tabs so flex heights propagate correctly */}
        <div className={`flex-1 min-h-0 flex flex-col ${tab === 'integrations' || tab === 'pathfinder' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {tab === 'definitions' && (
            selectedTable ? (
              <TableDetailPanel
                key={selectedTable.id}
                table={selectedTable}
                columns={selectedCols}
                focusColumnId={selectedColumnId}
                connectionDomains={connections.find((c) => c.id === activeConnId)?.domains ?? []}
                onSaved={() => activeConnId && reloadConnectionTables(activeConnId)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                Select a table from the left panel
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
              <div className="h-10 border-t border-slate-200 bg-white flex items-center gap-0 px-2 overflow-x-auto flex-shrink-0">
                <button
                  onClick={() => setActiveViewId(null)}
                  className={`px-3 h-full text-xs whitespace-nowrap transition-colors ${
                    activeViewId === null
                      ? 'border-b-2 border-blue-600 text-blue-700 font-medium'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  All tables
                </button>
                {views.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setActiveViewId(v.id)}
                    onDoubleClick={(e) => { e.preventDefault(); handleRenameView(v.id); }}
                    className={`px-3 h-full text-xs whitespace-nowrap transition-colors flex items-center gap-1 ${
                      activeViewId === v.id
                        ? 'border-b-2 border-blue-600 text-blue-700 font-medium'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {v.name}
                    <span
                      onClick={(e) => { e.stopPropagation(); handleDeleteView(v.id); }}
                      className="ml-1 text-slate-400 hover:text-red-500 cursor-pointer text-sm leading-none"
                      title="Delete view"
                    >
                      &times;
                    </span>
                  </button>
                ))}
                <button
                  onClick={handleCreateView}
                  className="px-2 h-full text-slate-400 hover:text-blue-600 text-lg leading-none transition-colors"
                  title="Create new view"
                >
                  +
                </button>
              </div>
            </div>
          )}

          {tab === 'pathfinder' && (
            <div className="flex-1 min-h-0 flex flex-col" style={{ height: '100%' }}>
              <PathFinderPanel
                connectionId={String(activeConnId ?? '')}
                tables={activeConnId ? (tablesByConn[activeConnId] ?? []) : []}
                columnsByTable={columnsByTable}
              />
            </div>
          )}

          {tab === 'kpis' && (
            <KpiPanel
              connectionId={String(activeConnId ?? '')}
              kpis={kpis}
              onSaved={loadKpis}
            />
          )}

          {tab === 'quality' && (
            <>
              <QualityAlertBanner />
              {selectedQualityItem ? (
                <QualityPanel
                  key={`${selectedQualityItem.connection_id}-${selectedQualityItem.table_name}`}
                  connId={selectedQualityItem.connection_id}
                  tableName={selectedQualityItem.table_name}
                  productTableId={selectedQualityItem.product_table_id ?? undefined}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                  Select a table from the left panel
                </div>
              )}
            </>
          )}

          {tab === 'integrations' && (
            <div className="flex flex-col flex-1 min-h-0">
              <IntegrationsPanel selectedTableId={selectedTableId} />
            </div>
          )}

          {tab === 'audit' && (
            <div className="px-6 py-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Audit Trail</h2>
              <AuditPanel limit={100} />
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
