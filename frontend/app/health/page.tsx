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
  if (score === null) return <span className="text-xs text-on-surface-variant/30">—</span>;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-emerald-500/15 text-emerald-600' : pct >= 70 ? 'bg-amber-500/15 text-amber-600' : 'bg-red-500/15 text-red-600';
  return <span className={`text-sm font-bold px-2 py-0.5 rounded-lg ${cls}`}>{pct}%</span>;
}

function ScoreDot({ score }: { score: number | null }) {
  if (score === null) return <span className="w-2 h-2 rounded-full bg-white/15 inline-block" />;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-emerald-400' : pct >= 70 ? 'bg-amber-400' : 'bg-red-400';
  return <span className={`w-2 h-2 rounded-full ${cls} inline-block`} />;
}

function HealthRing({ percent, size = 18 }: { percent: number; size?: number }) {
  const r = (size - 4) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const color = percent >= 80 ? '#10b981' : percent >= 50 ? '#f59e0b' : '#64748b';
  return (
    <svg className="flex-shrink-0" width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={2}
        strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease', transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }} />
    </svg>
  );
}

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
  </svg>
);

const DbIcon = ({ active }: { active?: boolean }) => (
  <svg className={`w-4 h-4 flex-shrink-0 transition-colors ${active ? 'text-cyan-400' : 'text-cyan-600/60'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <ellipse cx="12" cy="6" rx="8" ry="3" strokeWidth={2} />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6v6c0 1.657 3.582 3 8 3s8-1.343 8-3V6" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12v6c0 1.657 3.582 3 8 3s8-1.343 8-3v-6" />
  </svg>
);

const TableIcon = ({ active }: { active: boolean }) => (
  <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-colors ${active ? 'text-cyan-400' : 'text-slate-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M3 10h18M3 14h18M10 4v16M3 4h18a1 1 0 011 1v14a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1z" />
  </svg>
);

export default function HealthPage() {
  const [tables, setTables] = useState<TableHealth[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [selectedTable, setSelectedTable] = useState<{ connId: number; tableName: string; productTableId?: number | null } | null>(null);
  const [activePill, setActivePill] = useState('overview');
  const [profilingKey, setProfilingKey] = useState<string | null>(null); // e.g. "conn-22" or "product-Sales"
  const [profilingProgress, setProfilingProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tablesRes, connsRes] = await Promise.all([
        api.get('/quality/tables'),
        api.get('/connections').catch(() => ({ data: { data: [] } })),
      ]);
      const allTables = (tablesRes.data.data ?? []) as TableHealth[];
      setTables(allTables);

      // Build connections from API or derive from tables
      let conns = (connsRes.data.data ?? []) as Connection[];
      if (conns.length === 0 && allTables.length > 0) {
        // Derive unique connections from table data
        const connIds = [...new Set(allTables.filter(t => (t.layer ?? 'source') === 'source').map(t => t.connection_id))];
        conns = connIds.map(id => ({ id, name: `Connection ${id}` }));
      }
      setConnections(conns);
      // Auto-expand first connection
      if (conns.length > 0) setSelectedConnId(conns[0].id);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Profile all source tables in a connection
  const profileAllSource = useCallback(async (connId: number, sourceTables: TableHealth[], e: React.MouseEvent) => {
    e.stopPropagation();
    const key = `conn-${connId}`;
    setProfilingKey(key);
    setProfilingProgress({ done: 0, total: sourceTables.length });
    for (let i = 0; i < sourceTables.length; i++) {
      const t = sourceTables[i];
      try {
        await api.post(`/quality/${t.connection_id}/${encodeURIComponent(t.table_name)}/profile`);
      } catch { /* continue on error */ }
      setProfilingProgress({ done: i + 1, total: sourceTables.length });
    }
    setProfilingKey(null);
    await loadData();
  }, [loadData]);

  // Profile all product tables in a product group (ptables is already deduplicated by table_name)
  const profileAllProduct = useCallback(async (productName: string, ptables: TableHealth[], e: React.MouseEvent) => {
    e.stopPropagation();
    const key = `product-${productName}`;
    setProfilingKey(key);
    setProfilingProgress({ done: 0, total: ptables.length });
    for (let i = 0; i < ptables.length; i++) {
      const t = ptables[i];
      if (t.product_table_id == null) { setProfilingProgress({ done: i + 1, total: ptables.length }); continue; }
      try { await api.post(`/quality/product/${t.product_table_id}/profile`); } catch { /* continue */ }
      setProfilingProgress({ done: i + 1, total: ptables.length });
    }
    setProfilingKey(null);
    await loadData();
  }, [loadData]);

  const filteredTables = selectedConnId
    ? tables.filter((t) => t.connection_id === selectedConnId)
    : tables;

  const profiledTables = filteredTables.filter((t) => t.overall_score !== null);
  const avgScore = profiledTables.length > 0
    ? Math.round((profiledTables.reduce((s, t) => s + (t.overall_score ?? 0), 0) / profiledTables.length) * 100)
    : 0;

  const contextPanel = (
    <div className="dark-tree flex flex-col h-full min-h-0 text-white/80">
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
        {/* "All sources" option */}
        <button
          onClick={() => { setSelectedConnId(null); setSelectedTable(null); setActivePill('overview'); }}
          className={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center gap-2.5 transition-colors ${
            selectedConnId === null
              ? 'bg-white/[0.07] border-l-2 border-cyan-400 text-white font-semibold'
              : 'border-l-2 border-transparent text-white/60 hover:bg-white/[0.04] hover:text-white/80'
          }`}>
          <DbIcon active={selectedConnId === null} />
          <span className="truncate">All sources</span>
          <span className="ml-auto text-[10px] text-white/30">{tables.length}</span>
        </button>

        {/* Sources section */}
        <div className="text-[10px] font-semibold text-cyan-500/60 uppercase tracking-[0.15em] px-3 pt-4 pb-1">Sources</div>
        {connections.map((conn) => {
          const connTables = tables.filter((t) => t.connection_id === conn.id && (t.layer ?? 'source') === 'source');
          if (connTables.length === 0) return null;
          const connAvg = connTables.filter((t) => t.overall_score !== null);
          const avg = connAvg.length > 0 ? Math.round((connAvg.reduce((s, t) => s + (t.overall_score ?? 0), 0) / connAvg.length) * 100) : null;
          const isSelected = selectedConnId === conn.id;
          return (
            <div key={conn.id}>
              <button
                onClick={() => { setSelectedConnId(isSelected ? null : conn.id); setSelectedTable(null); setActivePill('overview'); }}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center gap-2.5 transition-colors ${
                  isSelected
                    ? 'bg-white/[0.07] border-l-2 border-cyan-400 text-white font-semibold'
                    : 'border-l-2 border-transparent text-white/60 hover:bg-white/[0.04] hover:text-white/80'
                }`}>
                <ChevronIcon expanded={isSelected} />
                <DbIcon active={isSelected} />
                <span className="truncate flex-1">{conn.name}</span>
                {avg !== null && <HealthRing percent={avg} size={18} />}
                <span className="text-[10px] text-white/30">{connTables.length}</span>
              </button>

              {/* Nested table list */}
              {isSelected && (
                <div className="ml-5 border-l border-white/[0.06] mt-0.5 mb-1">
                  {connTables.map((t) => {
                    const isActive = selectedTable?.tableName === t.table_name && selectedTable?.connId === t.connection_id;
                    return (
                      <button key={t.id}
                        onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name }); setActivePill('detail'); }}
                        className={`w-full text-left pl-4 pr-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                          isActive
                            ? 'bg-cyan-500/10 border-r-2 border-cyan-400 text-cyan-300 font-semibold'
                            : 'border-r-2 border-transparent text-white/50 hover:bg-white/[0.04] hover:text-white/70'
                        }`}>
                        <TableIcon active={isActive} />
                        <span className="truncate flex-1">{t.display_name || t.table_name}</span>
                        <ScoreDot score={t.overall_score} />
                      </button>
                    );
                  })}
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
            <div className="text-[10px] font-semibold text-purple-400/70 uppercase tracking-[0.15em] px-3 pt-4 pb-1 flex items-center gap-1.5">
              <span>Products</span>
            </div>
            {productNames.map((pn) => {
              const allPtables = productTables.filter((t) => t.product_name === pn);
              const seenNames = new Map<string, TableHealth>();
              for (const t of allPtables) {
                const existing = seenNames.get(t.table_name);
                if (!existing || (t.overall_score !== null && existing.overall_score === null)) {
                  seenNames.set(t.table_name, t);
                }
              }
              const ptables = Array.from(seenNames.values())
                .sort((a, b) => (a.table_role === 'fact' ? -1 : 1) - (b.table_role === 'fact' ? -1 : 1) || a.table_name.localeCompare(b.table_name));
              const ptAvg = ptables.filter((t) => t.overall_score !== null);
              const avg = ptAvg.length > 0 ? Math.round((ptAvg.reduce((s, t) => s + (t.overall_score ?? 0), 0) / ptAvg.length) * 100) : null;
              const isExpanded = selectedConnId === -ptables[0]?.id;
              return (
                <div key={pn}>
                  <button
                    onClick={() => { setSelectedConnId(isExpanded ? null : -ptables[0]?.id); setSelectedTable(null); setActivePill('overview'); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center gap-2.5 transition-colors ${
                      isExpanded
                        ? 'bg-white/[0.07] border-l-2 border-purple-400 text-white font-semibold'
                        : 'border-l-2 border-transparent text-white/60 hover:bg-white/[0.04] hover:text-white/80'
                    }`}>
                    <ChevronIcon expanded={isExpanded} />
                    <span className="text-xs">&#11088;</span>
                    <span className="truncate flex-1">{pn}</span>
                    {avg !== null && <HealthRing percent={avg} size={18} />}
                    <span className="text-[10px] text-white/30">{ptables.length}</span>
                  </button>
                  {isExpanded && (
                    <div className="ml-5 border-l border-white/[0.06] mt-0.5 mb-1">
                      {ptables.map((t) => {
                        const isActive = selectedTable?.tableName === t.table_name;
                        return (
                          <button key={t.id}
                            onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name, productTableId: t.product_table_id }); setActivePill('detail'); }}
                            className={`w-full text-left pl-4 pr-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                              isActive
                                ? 'bg-cyan-500/10 border-r-2 border-cyan-400 text-cyan-300 font-semibold'
                                : 'border-r-2 border-transparent text-white/50 hover:bg-white/[0.04] hover:text-white/70'
                            }`}>
                            <TableIcon active={isActive} />
                            <span className="truncate flex-1">{t.table_name}</span>
                            <span className="text-[10px] text-white/25 mr-1">{t.table_role === 'fact' ? 'F' : 'D'}</span>
                            <ScoreDot score={t.overall_score} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>);
        })()}

        {tables.length === 0 && !loading && (
          <p className="text-xs text-white/30 px-3 py-4 text-center">No tables profiled yet</p>
        )}
      </div>
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
          {(() => {
            // Determine what's selected and which profile action to show
            const selectedConn = connections.find((c) => c.id === selectedConnId);
            const selectedProduct = (() => {
              if (selectedConnId == null || selectedConnId > 0) return null;
              const ptables = tables.filter((t) => t.layer === 'product');
              // selectedConnId is negative product group key
              const matchTable = ptables.find((t) => -t.id === selectedConnId);
              return matchTable ? ptables.filter((t) => t.product_name === matchTable.product_name) : null;
            })();
            const selectedProductName = selectedProduct?.[0]?.product_name ?? null;
            const sourceTables = filteredTables.filter((t) => (t.layer ?? 'source') === 'source');
            const isProfilingThis = profilingKey === (selectedConn ? `conn-${selectedConn.id}` : selectedProductName ? `product-${selectedProductName}` : null);
            return (
              <div className="glass-card rounded-2xl p-8 flex items-center gap-8">
                <div className="w-24 h-24 rounded-full border-4 flex items-center justify-center flex-shrink-0"
                  style={{ borderColor: avgScore >= 90 ? '#06b6d4' : avgScore >= 70 ? '#d97706' : '#ba1a1a' }}>
                  <span className="text-4xl font-bold text-on-surface">{avgScore}</span>
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold text-on-surface">Overall Health Score</h2>
                  <p className="text-sm text-on-surface-variant mt-1">
                    {profiledTables.length} of {filteredTables.length} tables profiled across{' '}
                    {selectedConn?.name ?? selectedProductName ?? 'all connections'}
                  </p>
                </div>
                {/* Profile all button — only shown when a specific source or product is selected */}
                {(selectedConn || selectedProductName) && (
                  <div className="flex-shrink-0">
                    {isProfilingThis ? (
                      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500/10 text-cyan-700 text-sm font-medium">
                        <span className="w-4 h-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                        Profiling {profilingProgress.done}/{profilingProgress.total}…
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          if (selectedConn) {
                            profileAllSource(selectedConn.id, sourceTables, e);
                          } else if (selectedProductName && selectedProduct) {
                            profileAllProduct(selectedProductName, selectedProduct, e);
                          }
                        }}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-primary text-on-primary text-sm font-medium shadow-glow-primary hover:shadow-glow-teal-md transition-all">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
                        </svg>
                        Profile all {filteredTables.length} tables
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Table quality grid */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container">
                  <th className="text-left px-5 py-3 text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider">Table</th>
                  <th className="text-center px-5 py-3 text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider">Score</th>
                  <th className="text-right px-5 py-3 text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider">Rows</th>
                  <th className="text-right px-5 py-3 text-[10px] font-semibold text-on-surface-variant uppercase tracking-wider">Last Profiled</th>
                </tr>
              </thead>
              <tbody>
                {filteredTables
                  .sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2))
                  .map((t, i) => (
                  <tr key={t.id}
                    onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name }); setActivePill('detail'); }}
                    className={`cursor-pointer transition-colors hover:bg-white/40 border-b border-white/40 last:border-0 ${i % 2 === 1 ? 'bg-white/30' : 'bg-white/60'}`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <ScoreDot score={t.overall_score} />
                        <span className="text-sm font-medium text-on-surface">{t.display_name || t.table_name}</span>
                        {t.display_name && t.display_name !== t.table_name && (
                          <span className="text-xs text-on-surface-variant/40">{t.table_name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center"><ScoreCell score={t.overall_score} /></td>
                    <td className="px-5 py-3 text-right text-sm text-on-surface-variant">
                      {t.row_count != null ? t.row_count.toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-xs text-on-surface-variant/50">
                      {t.profiled_at ? new Date(t.profiled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredTables.length === 0 && (
              <div className="text-center py-12 text-on-surface-variant text-sm">
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
        <div className="flex items-center justify-center h-64 text-on-surface-variant text-sm">
          Select a table from the left panel to view quality details
        </div>
      )}
    </AppShell>
  );
}
