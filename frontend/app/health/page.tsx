'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, Database, Table2, Play, Loader2 } from 'lucide-react';
import IconRail from '@/components/layout/IconRail';
import ContextPanel from '@/components/layout/ContextPanel';
import QualityPanel from '@/components/QualityPanel';
import CatalogBrowser, { type CatalogSelection } from '@/components/catalog/CatalogBrowser';
import api from '@/lib/api';
import { formatRelativeTime, getFreshnessStatus, getFreshnessTextColor } from '@/lib/freshness';

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
  if (score === null) return <span className="text-[11px] text-muted-2">—</span>;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-ok-soft text-ok' : pct >= 70 ? 'bg-warn-soft text-warn' : 'bg-err-soft text-err';
  return <span className={`text-[12px] font-mono tracking-[0.04em] tabular-nums px-2 py-0.5 rounded border border-line ${cls}`}>{pct}%</span>;
}

function ScoreDot({ score }: { score: number | null }) {
  if (score === null) return <span className="w-2 h-2 rounded-full bg-line inline-block" />;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-ok' : pct >= 70 ? 'bg-warn' : 'bg-err';
  return <span className={`w-2 h-2 rounded-full ${cls} inline-block`} />;
}

function HealthRing({ percent, size = 18 }: { percent: number; size?: number }) {
  const r = (size - 4) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (percent / 100) * circumference;
  const color = percent >= 80 ? '#3f7a5c' : percent >= 50 ? '#a06a1c' : '#6b7680';
  return (
    <svg className="flex-shrink-0" width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(13,28,47,0.08)" strokeWidth={2} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={2}
        strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease', transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }} />
    </svg>
  );
}

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <ChevronRight
    className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
    strokeWidth={2.5}
  />
);

const DbIcon = ({ active }: { active?: boolean }) => (
  <Database
    className={`w-4 h-4 flex-shrink-0 transition-colors ${active ? 'text-ocean' : 'text-muted'}`}
    strokeWidth={1.5}
  />
);

const TableIcon = ({ active }: { active: boolean }) => (
  <Table2
    className={`w-3.5 h-3.5 flex-shrink-0 transition-colors ${active ? 'text-ocean' : 'text-muted-2'}`}
    strokeWidth={1.5}
  />
);

export default function HealthPage() {
  const [tables, setTables] = useState<TableHealth[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [selectedTable, setSelectedTable] = useState<{ connId: number; tableName: string; displayName?: string; productTableId?: number | null } | null>(null);
  const [activePill, setActivePill] = useState('overview');
  const [profilingKey, setProfilingKey] = useState<string | null>(null); // e.g. "conn-22" or "product-Sales"
  const [profilingProgress, setProfilingProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [catalogSelection, setCatalogSelection] = useState<CatalogSelection | null>(null);

  function handleCatalogSelect(sel: CatalogSelection) {
    setCatalogSelection(sel);
    setActivePill('detail');
    if (sel.catalog === 'sources') {
      // For source tables, schemaSlug encodes the connection id; resolve to a TableHealth row
      const m = sel.schemaSlug.match(/_(\d+)$/);
      const connId = m ? Number(m[1]) : null;
      if (connId == null || sel.tableName == null) return;
      setSelectedConnId(connId);
      const t = tables.find((x) => (x.layer ?? 'source') === 'source'
        && x.connection_id === connId && x.table_name === sel.tableName);
      setSelectedTable({
        connId,
        tableName: sel.tableName,
        displayName: t?.display_name ?? sel.tableLabel ?? undefined,
      });
    } else {
      // Product tables: match by (product_name, table_name) so we get the right TableHealth row
      const t = tables.find((x) => x.layer === 'product'
        && x.product_name === sel.schemaLabel && x.table_name === sel.tableName);
      if (!t) return;
      setSelectedConnId(null);
      setSelectedTable({
        connId: t.connection_id,
        tableName: t.table_name,
        displayName: t.display_name ?? sel.tableLabel ?? undefined,
        productTableId: t.product_table_id,
      });
    }
  }

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
    <CatalogBrowser selected={catalogSelection} onSelectTable={handleCatalogSelect} />
  );

  const pillBtn = (key: string, label: string) => (
    <button
      key={key}
      onClick={() => {
        setActivePill(key);
        // Symmetric navigation: clicking "Overview" while viewing a table
        // returns to the summary without requiring the user to deselect.
        if (key === 'overview') setSelectedTable(null);
      }}
      className={`px-4 py-3 text-[13px] transition-colors whitespace-nowrap relative ${
        activePill === key
          ? 'text-ink font-medium'
          : 'text-muted hover:text-ink-2'
      }`}
    >
      {label}
      {activePill === key && (
        <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />
      )}
    </button>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <IconRail />

      <ContextPanel>
        {contextPanel}
      </ContextPanel>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <div className="bg-raised border-b border-line px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Quality</p>
            <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em]">Data health</h1>
            <p className="text-[11px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-1">
              {profiledTables.length} tables profiled · Average {avgScore}%
            </p>
          </div>
          <div className="flex items-center gap-0">
            {pillBtn('overview', 'Overview')}
            {pillBtn('detail', 'Table detail')}
          </div>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-5 h-5 text-ocean animate-spin" strokeWidth={2} />
        </div>
      ) : activePill === 'overview' ? (
        <div className="max-w-5xl mx-auto px-6 pt-8 pb-10 space-y-6">
          {/* Hero score */}
          {(() => {
            const selectedConn = connections.find((c) => c.id === selectedConnId);
            const selectedProduct = (() => {
              if (selectedConnId == null || selectedConnId > 0) return null;
              const ptables = tables.filter((t) => t.layer === 'product');
              const matchTable = ptables.find((t) => -t.id === selectedConnId);
              return matchTable ? ptables.filter((t) => t.product_name === matchTable.product_name) : null;
            })();
            const selectedProductName = selectedProduct?.[0]?.product_name ?? null;
            const sourceTables = filteredTables.filter((t) => (t.layer ?? 'source') === 'source');
            const isProfilingThis = profilingKey === (selectedConn ? `conn-${selectedConn.id}` : selectedProductName ? `product-${selectedProductName}` : null);
            const ringColor = avgScore >= 90 ? 'var(--ok)' : avgScore >= 70 ? 'var(--warn)' : 'var(--err)';
            return (
              <div className="bg-raised border border-line rounded-lg p-8 flex items-center gap-8">
                <div className="w-24 h-24 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                  style={{ borderColor: ringColor }}>
                  <span className="font-display text-[36px] leading-none tabular-nums text-ink tracking-[-0.02em]">{avgScore}</span>
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Overall score</p>
                  <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.01em]">Health status</h2>
                  <p className="text-[13px] text-ink-3 mt-1 leading-relaxed">
                    {profiledTables.length} of {filteredTables.length} tables profiled across{' '}
                    {selectedConn?.name ?? selectedProductName ?? 'all connections'}
                  </p>
                </div>
                {(selectedConn || selectedProductName) && (
                  <div className="flex-shrink-0">
                    {isProfilingThis ? (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-ocean-softer text-ocean text-[12px] font-medium border border-line">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
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
                        className="flex items-center gap-2 px-4 py-2 rounded-md bg-ocean text-white text-[13px] font-medium hover:bg-ocean-hover transition-colors">
                        <Play className="w-3.5 h-3.5" strokeWidth={2} fill="currentColor" />
                        Profile all {filteredTables.length} tables
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Table quality grid */}
          <div className="bg-raised border border-line rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-softer border-b border-line">
                  <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Table</th>
                  <th className="text-center px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Score</th>
                  <th className="text-right px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Rows</th>
                  <th className="text-right px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Last profiled</th>
                </tr>
              </thead>
              <tbody>
                {filteredTables
                  .sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2))
                  .map((t) => (
                  <tr key={t.id}
                    onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name, displayName: t.display_name || undefined, productTableId: t.product_table_id ?? undefined }); setActivePill('detail'); }}
                    className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <ScoreDot score={t.overall_score} />
                        <span className="text-[13px] font-medium text-ink">{t.display_name || t.table_name}</span>
                        {t.display_name && t.display_name !== t.table_name && (
                          <span className="text-[11px] font-mono text-muted-2">{t.table_name}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center"><ScoreCell score={t.overall_score} /></td>
                    <td className="px-5 py-3 text-right text-[12px] text-ink-3 tabular-nums">
                      {t.row_count != null ? t.row_count.toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-right text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2">
                      {t.profiled_at ? new Date(t.profiled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredTables.length === 0 && (
              <div className="text-center py-12 text-[13px] text-ink-3">
                No tables found. Run profiling from the Connect page first.
              </div>
            )}
          </div>
        </div>
      ) : selectedTable ? (
        <div className="p-4">
          <QualityPanel connId={selectedTable.connId} tableName={selectedTable.tableName} displayName={selectedTable.displayName} productTableId={selectedTable.productTableId ?? undefined} />
        </div>
      ) : (
        <div className="flex items-center justify-center h-64 text-[13px] text-ink-3">
          Select a table from the left panel to view quality details.
        </div>
      )}
        </div>
      </div>
    </div>
  );
}
