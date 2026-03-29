'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Nav from '@/components/Nav';
import DatabaseTree from '@/components/semantic/DatabaseTree';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import RelationshipCanvas from '@/components/semantic/RelationshipCanvas';
import KpiPanel from '@/components/semantic/KpiPanel';
import QualityPanel from '@/components/QualityPanel';
import IntegrationsPanel from '@/components/IntegrationsPanel';
import api from '@/lib/api';
import { SourceTable, SourceColumn, KpiDefinition } from '@/components/semantic/types';

type MainTab = 'definitions' | 'relationships' | 'kpis' | 'quality' | 'integrations';

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

  const tabBtn = (t: MainTab, label: string) => (
    <button
      onClick={() => setTab(t)}
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
        {tabBtn('integrations', 'Integrations')}
        {tabBtn('kpis', 'KPIs')}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <div className="flex-shrink-0 overflow-y-auto bg-white border-r border-slate-200" style={{ width: 260 }}>
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
        </div>

        {/* Right panel — overflow-hidden for canvas tabs so flex heights propagate correctly */}
        <div className={`flex-1 min-h-0 flex flex-col ${tab === 'integrations' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
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
            <div className="flex-1 min-h-0" style={{ height: '100%' }}>
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
            selectedTable && activeConnId ? (
              <QualityPanel
                key={`${activeConnId}-${selectedTable.table_name}`}
                connId={activeConnId}
                tableName={selectedTable.table_name}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                Select a table from the left panel
              </div>
            )
          )}

          {tab === 'integrations' && (
            <div className="flex flex-col flex-1 min-h-0">
              <IntegrationsPanel selectedTableId={selectedTableId} />
            </div>
          )}
        </div>
      </div>
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
