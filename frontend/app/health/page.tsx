'use client';

import { useState, useEffect, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import QualityPanel from '@/components/QualityPanel';
import api from '@/lib/api';

interface TableHealth {
  id: number;
  connection_id: number;
  table_name: string;
  display_name: string | null;
  layer: 'source' | 'product';
  product_name: string | null;
  product_table_id: number | null;
  table_role: string | null;
  profiled_at: string | null;
  overall_score: number | null;
  row_count: number | null;
  rag: 'green' | 'amber' | 'red' | 'grey';
}

interface Connection {
  id: number;
  name: string;
}

function ScoreCell({ score }: { score: number | null }) {
  if (score === null) return <span className="text-label-sm text-on-surface-variant/30">—</span>;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-amber-400/15 text-amber-700' : pct >= 70 ? 'bg-amber-400/10 text-amber-600' : 'bg-error/10 text-error';
  return <span className={`text-label-md font-bold px-2 py-0.5 rounded-lg ${cls}`}>{pct}%</span>;
}

function ScoreDot({ score }: { score: number | null }) {
  if (score === null) return <span className="w-2 h-2 rounded-full bg-outline-variant/30 inline-block" />;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-amber-400' : pct >= 70 ? 'bg-amber-500' : 'bg-error';
  return <span className={`w-2 h-2 rounded-full ${cls} inline-block`} />;
}

export default function HealthPage() {
  const [tables, setTables] = useState<TableHealth[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [selectedTable, setSelectedTable] = useState<{ connId: number; tableName: string; productTableId?: number | null } | null>(null);
  const [activePill, setActivePill] = useState('overview');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tablesRes, connsRes] = await Promise.all([
        api.get('/quality/tables'),
        api.get('/connections'),
      ]);
      setTables(tablesRes.data.data ?? []);
      const conns = (connsRes.data.data ?? []) as Connection[];
      setConnections(conns);
      if (!selectedConnId && conns.length > 0) setSelectedConnId(conns[0].id);
    } catch {} finally { setLoading(false); }
  }, [selectedConnId]);

  useEffect(() => { loadData(); }, []);

  const filteredTables = selectedConnId
    ? tables.filter((t) => t.connection_id === selectedConnId)
    : tables;

  const profiledTables = filteredTables.filter((t) => t.overall_score !== null);
  const avgScore = profiledTables.length > 0
    ? Math.round((profiledTables.reduce((s, t) => s + (t.overall_score ?? 0), 0) / profiledTables.length) * 100)
    : 0;

  const contextPanel = (
    <div className="p-4 space-y-2">
      {/* "All" option */}
      <button
        onClick={() => { setSelectedConnId(null); setSelectedTable(null); setActivePill('overview'); }}
        className={`w-full text-left px-3 py-2 rounded-lg text-body-sm font-medium transition-colors ${
          selectedConnId === null
            ? 'bg-surface-container-highest text-on-surface'
            : 'text-on-surface-variant hover:bg-surface-container'
        }`}>
        All sources
        <span className="text-on-surface-variant/40 ml-1">({tables.length})</span>
      </button>

      {/* Sources section */}
      <div className="text-label-md text-on-surface-variant/50 font-semibold uppercase tracking-wider px-2 pt-3">Sources</div>
      {connections.map((conn) => {
        const connTables = tables.filter((t) => t.connection_id === conn.id && t.layer === 'source');
        if (connTables.length === 0) return null;
        const connAvg = connTables.filter((t) => t.overall_score !== null);
        const avg = connAvg.length > 0 ? Math.round((connAvg.reduce((s, t) => s + (t.overall_score ?? 0), 0) / connAvg.length) * 100) : null;
        const isSelected = selectedConnId === conn.id;
        return (
          <div key={conn.id}>
            {/* Clickable connection header */}
            <button
              onClick={() => { setSelectedConnId(isSelected ? null : conn.id); setSelectedTable(null); setActivePill('overview'); }}
              className={`w-full text-left px-3 py-2 rounded-lg text-body-sm flex items-center justify-between transition-colors ${
                isSelected
                  ? 'bg-surface-container-highest text-on-surface font-semibold'
                  : 'text-on-surface-variant hover:bg-surface-container font-medium'
              }`}>
              <div className="flex items-center gap-2">
                <ScoreDot score={avg !== null ? avg / 100 : null} />
                <span className="truncate">{conn.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {avg !== null && <span className="text-label-sm text-on-surface-variant/50">{avg}%</span>}
                <span className="text-label-sm text-on-surface-variant/30">{isSelected ? '▾' : '▸'}</span>
              </div>
            </button>

            {/* Expandable table list — only shown when connection is selected */}
            {isSelected && (
              <div className="ml-3 mt-1 space-y-0.5 mb-2">
                {connTables.map((t) => (
                  <button key={t.id}
                    onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name }); setActivePill('detail'); }}
                    className={`w-full text-left px-3 py-1.5 rounded-lg text-body-sm flex items-center gap-2 transition-colors ${
                      selectedTable?.tableName === t.table_name && selectedTable?.connId === t.connection_id
                        ? 'bg-surface-container-highest text-on-surface font-medium'
                        : 'text-on-surface-variant hover:bg-surface-container'
                    }`}>
                    <ScoreDot score={t.overall_score} />
                    <span className="truncate">{t.display_name || t.table_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Products section */}
      {(() => {
        const productTables = tables.filter((t) => t.layer === 'product');
        const productNames = [...new Set(productTables.map((t) => t.product_name).filter(Boolean))] as string[];
        if (productNames.length === 0) return null;
        return (<>
          <div className="text-label-md text-on-surface-variant/50 font-semibold uppercase tracking-wider px-2 pt-3">Products</div>
          {productNames.map((pn) => {
            const ptables = productTables.filter((t) => t.product_name === pn);
            const ptAvg = ptables.filter((t) => t.overall_score !== null);
            const avg = ptAvg.length > 0 ? Math.round((ptAvg.reduce((s, t) => s + (t.overall_score ?? 0), 0) / ptAvg.length) * 100) : null;
            const isExpanded = selectedConnId === -ptables[0]?.id; // use negative id as product group key
            return (
              <div key={pn}>
                <button
                  onClick={() => { setSelectedConnId(isExpanded ? null : -ptables[0]?.id); setSelectedTable(null); setActivePill('overview'); }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-body-sm flex items-center justify-between transition-colors ${
                    isExpanded ? 'bg-surface-container-highest text-on-surface font-semibold' : 'text-on-surface-variant hover:bg-surface-container font-medium'
                  }`}>
                  <div className="flex items-center gap-2">
                    <span className="text-label-sm">⭐</span>
                    <span className="truncate">{pn}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {avg !== null && <span className="text-label-sm text-on-surface-variant/50">{avg}%</span>}
                    <span className="text-label-sm text-on-surface-variant/30">{isExpanded ? '▾' : '▸'}</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="ml-3 mt-1 space-y-0.5 mb-2">
                    {ptables.map((t) => (
                      <button key={t.id}
                        onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name, productTableId: t.product_table_id }); setActivePill('detail'); }}
                        className={`w-full text-left px-3 py-1.5 rounded-lg text-body-sm flex items-center gap-2 transition-colors ${
                          selectedTable?.tableName === t.table_name ? 'bg-surface-container-highest text-on-surface font-medium' : 'text-on-surface-variant hover:bg-surface-container'
                        }`}>
                        <ScoreDot score={t.overall_score} />
                        <span className="truncate">{t.table_name}</span>
                        <span className="text-label-sm text-on-surface-variant/30 ml-auto">{t.table_role === 'fact' ? 'F' : 'D'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>);
      })()}

      {tables.length === 0 && !loading && (
        <p className="text-label-sm text-on-surface-variant/40 px-3 py-4">No tables profiled yet</p>
      )}
    </div>
  );

  return (
    <AppShell
      title="Data Health"
      subtitle={`${profiledTables.length} tables profiled • Average score: ${avgScore}%`}
      contextPanel={contextPanel}
      pills={[
        { key: 'overview', label: 'Overview' },
        { key: 'detail', label: 'Table Detail' },
      ]}
      activePill={activePill}
      onPillChange={setActivePill}
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="w-6 h-6 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : activePill === 'overview' ? (
        <div className="p-6 space-y-6 max-w-5xl">
          {/* Hero score */}
          <div className="bg-surface-container-lowest rounded-2xl shadow-ambient p-8 flex items-center gap-8">
            <div className="w-24 h-24 rounded-full border-4 flex items-center justify-center flex-shrink-0"
              style={{ borderColor: avgScore >= 90 ? '#f59e0b' : avgScore >= 70 ? '#d97706' : '#ba1a1a' }}>
              <span className="font-headline text-display-md font-bold text-on-surface">{avgScore}</span>
            </div>
            <div>
              <h2 className="font-headline text-headline-md font-bold text-on-surface">Overall Health Score</h2>
              <p className="text-body-md text-on-surface-variant mt-1">
                {profiledTables.length} of {filteredTables.length} tables profiled across{' '}
                {connections.find((c) => c.id === selectedConnId)?.name ?? 'all connections'}
              </p>
            </div>
          </div>

          {/* Table quality grid */}
          <div className="bg-surface-container-lowest rounded-2xl shadow-ambient overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container-low">
                  <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Table</th>
                  <th className="text-center px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Score</th>
                  <th className="text-right px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Rows</th>
                  <th className="text-right px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Last Profiled</th>
                </tr>
              </thead>
              <tbody>
                {filteredTables
                  .sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2))
                  .map((t, i) => (
                  <tr key={t.id}
                    onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name }); setActivePill('detail'); }}
                    className={`cursor-pointer transition-colors hover:bg-surface-container-low ${i % 2 === 1 ? 'bg-surface/50' : ''}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <ScoreDot score={t.overall_score} />
                        <span className="text-body-sm font-medium text-on-surface">{t.display_name || t.table_name}</span>
                        {t.display_name && t.display_name !== t.table_name && (
                          <span className="text-label-sm text-on-surface-variant/40">{t.table_name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center"><ScoreCell score={t.overall_score} /></td>
                    <td className="px-5 py-3 text-right text-body-sm text-on-surface-variant">
                      {t.row_count != null ? t.row_count.toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-label-sm text-on-surface-variant/50">
                      {t.profiled_at ? new Date(t.profiled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredTables.length === 0 && (
              <div className="text-center py-12 text-on-surface-variant text-body-md">
                No tables found. Run profiling from the Connect page first.
              </div>
            )}
          </div>
        </div>
      ) : selectedTable ? (
        /* Detail view — renders QualityPanel for selected table */
        <div className="p-4">
          <QualityPanel connId={selectedTable.connId} tableName={selectedTable.tableName} />
        </div>
      ) : (
        <div className="flex items-center justify-center h-64 text-on-surface-variant text-body-md">
          Select a table from the left panel to view quality details
        </div>
      )}
    </AppShell>
  );
}
