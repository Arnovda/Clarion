'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Nav from '@/components/Nav';
import DatabaseTree from '@/components/semantic/DatabaseTree';
import TableDetailPanel from '@/components/semantic/TableDetailPanel';
import RelationshipCanvas from '@/components/semantic/RelationshipCanvas';
import KpiPanel from '@/components/semantic/KpiPanel';
import api from '@/lib/api';
import { SourceTable, SourceColumn, KpiDefinition } from '@/components/semantic/types';

type MainTab = 'definitions' | 'relationships' | 'kpis';

function SemanticInner() {
  const params       = useSearchParams();
  const connectionId = params.get('connectionId') ?? '1';

  const [tab, setTab]                           = useState<MainTab>('definitions');
  const [tables, setTables]                     = useState<SourceTable[]>([]);
  const [columnsByTable, setColumnsByTable]     = useState<Record<number, SourceColumn[]>>({});
  const [kpis, setKpis]                         = useState<KpiDefinition[]>([]);
  const [selectedTableId, setSelectedTableId]   = useState<number | null>(null);
  const [selectedColumnId, setSelectedColumnId] = useState<number | null>(null);
  const [zoomToTableId,   setZoomToTableId]     = useState<number | null>(null);
  const [connectionName, setConnectionName]     = useState('sample-sqlite');

  // Auto-select the first table exactly once on initial load — never again after that,
  // so clearing selection (click blank canvas, etc.) stays cleared.
  const hasAutoSelected = useRef(false);

  const loadTables = useCallback(async () => {
    const tRes = await api.get(`/semantic/tables?connectionId=${connectionId}`);
    const tbls: SourceTable[] = tRes.data.data;
    setTables(tbls);
    if (tbls.length && !hasAutoSelected.current) {
      setSelectedTableId(tbls[0].id);
      hasAutoSelected.current = true;
    }

    const colMap: Record<number, SourceColumn[]> = {};
    await Promise.all(tbls.map(async (t) => {
      const r = await api.get(`/semantic/columns?tableId=${t.id}`);
      colMap[t.id] = r.data.data;
    }));
    setColumnsByTable(colMap);

    const conns = await api.get('/connections').catch(() => null);
    const conn  = conns?.data?.data?.find((c: { id: number; name: string }) => String(c.id) === connectionId);
    if (conn) setConnectionName(conn.name);
  }, [connectionId]);  // ← selectedTableId removed from deps — prevents reload loop

  const loadKpis = useCallback(async () => {
    const res = await api.get(`/semantic/kpis?connectionId=${connectionId}`);
    setKpis(res.data.data);
  }, [connectionId]);

  useEffect(() => { loadTables(); loadKpis(); }, [loadTables, loadKpis]);

  // When a column is selected, scroll to it in the detail panel
  useEffect(() => {
    if (selectedColumnId && tab === 'definitions') {
      setTimeout(() => {
        document.getElementById(`col-${selectedColumnId}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
    }
  }, [selectedColumnId, tab]);

  const selectedTable = tables.find((t) => t.id === selectedTableId) ?? null;
  const selectedCols  = selectedTableId ? (columnsByTable[selectedTableId] ?? []) : [];

  // Left-pane click — highlight AND zoom to the table on the canvas
  function handleSelectTable(id: number) {
    setSelectedTableId(id);
    setSelectedColumnId(null);
    setZoomToTableId(id);          // triggers canvas zoom
    if (tab === 'kpis') setTab('definitions');
  }

  // Canvas header click — highlight only, no zoom/pan
  function handleCanvasSelectTable(id: number) {
    setSelectedTableId(id);
    setSelectedColumnId(null);
    // deliberately does NOT update zoomToTableId
  }

  function handleSelectColumn(tableId: number, columnId: number) {
    setSelectedTableId(tableId);
    setSelectedColumnId(columnId);
    if (tab === 'definitions') {
      setTimeout(() => {
        document.getElementById(`col-${columnId}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
    }
    // On relationships tab: stay there, canvas will zoom + highlight the column's edges
  }

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
    // Full viewport height, flex column, no page-level scroll
    <div className="flex flex-col bg-slate-50" style={{ height: '100vh', overflow: 'hidden' }}>
      <Nav />

      {/* Tab bar */}
      <div className="bg-white border-b border-slate-200 px-4 flex items-center gap-0 flex-shrink-0">
        {tabBtn('definitions', 'Tables & Columns')}
        {tabBtn('relationships', 'Relationships')}
        {tabBtn('kpis', 'KPIs')}
      </div>

      {/* Body — left sidebar + right panel, both scroll independently */}
      {/* min-h-0 is critical: without it flex children can't shrink below content size */}
      <div className="flex flex-1 min-h-0">

        {/* Left sidebar — independent scroll */}
        <div className="flex-shrink-0 overflow-y-auto bg-white border-r border-slate-200" style={{ width: 260 }}>
          <DatabaseTree
            connectionName={connectionName}
            tables={tables}
            columnsByTable={columnsByTable}
            selectedTableId={selectedTableId}
            selectedColumnId={selectedColumnId}
            onSelectTable={handleSelectTable}
            onSelectColumn={handleSelectColumn}
          />
        </div>

        {/* Right panel — independent scroll (except canvas which is self-contained) */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          {tab === 'definitions' && (
            selectedTable ? (
              <TableDetailPanel
                key={selectedTable.id}
                table={selectedTable}
                columns={selectedCols}
                focusColumnId={selectedColumnId}
                onSaved={loadTables}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                Select a table from the left panel
              </div>
            )
          )}

          {tab === 'relationships' && (
            // Canvas manages its own overflow — give it full height
            <div className="flex-1 min-h-0" style={{ height: '100%' }}>
              <RelationshipCanvas
                connectionId={connectionId}
                tables={tables}
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
              connectionId={connectionId}
              kpis={kpis}
              onSaved={loadKpis}
            />
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
