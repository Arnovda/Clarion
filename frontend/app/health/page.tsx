'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, Database, Table2, Play, Loader2 } from 'lucide-react';
import IconRail from '@/components/layout/IconRail';
import ContextPanel from '@/components/layout/ContextPanel';
import QualityPanel from '@/components/QualityPanel';
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
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  function toggleSection(key: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
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
    <div className="flex flex-col h-full min-h-0 bg-soft text-ink-2">
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {/* "All sources" option */}
        <button
          onClick={() => { setSelectedConnId(null); setSelectedTable(null); setActivePill('overview'); }}
          className={`w-full text-left px-3 py-2 rounded-md text-[12px] flex items-center gap-2.5 transition-colors ${
            selectedConnId === null
              ? 'bg-ocean-softer border-l-2 border-ocean text-ink font-medium'
              : 'border-l-2 border-transparent text-ink-3 hover:bg-softer hover:text-ink-2'
          }`}>
          <DbIcon active={selectedConnId === null} />
          <span className="truncate">All sources</span>
          <span className="ml-auto text-[10px] font-mono tracking-[0.06em] text-muted-2 tabular-nums">{tables.length}</span>
        </button>

        {/* Sources section */}
        <div className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted px-3 pt-4 pb-1.5">Sources</div>
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
                className={`w-full text-left px-3 py-2 rounded-md text-[12px] flex items-center gap-2 transition-colors ${
                  isSelected
                    ? 'bg-ocean-softer border-l-2 border-ocean text-ink font-medium'
                    : 'border-l-2 border-transparent text-ink-3 hover:bg-softer hover:text-ink-2'
                }`}>
                <ChevronIcon expanded={isSelected} />
                <DbIcon active={isSelected} />
                <span className="truncate flex-1">{conn.name}</span>
                {avg !== null && <HealthRing percent={avg} size={16} />}
                <span className="text-[10px] font-mono tabular-nums text-muted-2">{connTables.length}</span>
              </button>

              {/* Nested table list */}
              {isSelected && (
                <div className="ml-5 border-l border-line mt-0.5 mb-1">
                  {connTables.map((t) => {
                    const isActive = selectedTable?.tableName === t.table_name && selectedTable?.connId === t.connection_id;
                    return (
                      <button key={t.id}
                        onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name, displayName: t.display_name || undefined }); setActivePill('detail'); }}
                        className={`w-full text-left pl-4 pr-3 py-1.5 text-[12px] flex items-center gap-2 transition-colors ${
                          isActive
                            ? 'bg-ocean-softer text-ocean font-medium'
                            : 'text-ink-3 hover:bg-softer hover:text-ink-2'
                        }`}>
                        <TableIcon active={isActive} />
                        <span className="truncate flex-1">{t.display_name || t.table_name}</span>
                        {t.profiled_at && (
                          <span className={`text-[9px] font-mono ${getFreshnessTextColor(getFreshnessStatus(t.profiled_at))}`}>
                            {formatRelativeTime(t.profiled_at)}
                          </span>
                        )}
                        <ScoreDot score={t.overall_score} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Fact & Dimension sections (matching Data Dictionary layout) */}
        {(() => {
          const productTables = tables.filter((t) => t.layer === 'product');
          if (productTables.length === 0) return null;

          // Deduplicate dimensions across products, collect facts grouped by product
          const dimByName = new Map<string, { best: TableHealth; products: Set<string> }>();
          const factsByProduct = new Map<string, TableHealth[]>();

          for (const t of productTables) {
            const pn = t.product_name ?? 'Unknown';
            if (t.table_role === 'dimension' || t.table_role === 'bridge' || t.table_role === 'junk') {
              const existing = dimByName.get(t.table_name);
              if (!existing) {
                dimByName.set(t.table_name, { best: t, products: new Set([pn]) });
              } else {
                existing.products.add(pn);
                // Prefer tables with data: first by score, then by row_count (warehouse data exists)
                const curHasData = existing.best.row_count != null && existing.best.row_count > 0;
                const newHasData = t.row_count != null && t.row_count > 0;
                if (
                  (t.overall_score !== null && existing.best.overall_score === null) ||
                  (!curHasData && newHasData)
                ) {
                  existing.best = t;
                }
              }
            } else {
              const arr = factsByProduct.get(pn);
              if (arr) { if (!arr.find(x => x.table_name === t.table_name)) arr.push(t); }
              else factsByProduct.set(pn, [t]);
            }
          }

          const dimensions = [...dimByName.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, { best, products }]) => ({ name, table: best, usedBy: [...products].sort() }));

          const factGroups = [...factsByProduct.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([productName, tbls]) => ({ productName, tables: tbls.sort((a, b) => a.table_name.localeCompare(b.table_name)) }));

          return (<>
            <div className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted px-3 pt-5 pb-1.5">Organized data</div>

            {/* ── Dimensions (shared/deduplicated) ── */}
            {dimensions.length > 0 && (
              <>
                <div className="px-3 pt-1 pb-1">
                  <button onClick={() => toggleSection('dims')} className="flex items-center gap-2 w-full text-left">
                    <ChevronIcon expanded={expandedSections.has('dims')} />
                    <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-ai">Reference tables</span>
                    <span className="text-[10px] font-mono text-muted-2 ml-auto tabular-nums">{dimensions.length}</span>
                  </button>
                </div>
                {expandedSections.has('dims') && (
                  <div className="ml-5 border-l border-line">
                    {dimensions.map((dim) => {
                      const isActive = selectedTable?.tableName === dim.name;
                      return (
                        <button key={dim.name}
                          onClick={() => { setSelectedTable({ connId: dim.table.connection_id, tableName: dim.name, displayName: dim.table.display_name || undefined, productTableId: dim.table.product_table_id }); setActivePill('detail'); }}
                          className={`w-full text-left flex items-center gap-2 pl-4 pr-3 py-[7px] text-[12px] transition-colors ${
                            isActive
                              ? 'bg-ai-soft text-ai font-medium'
                              : 'text-ink-3 hover:bg-softer hover:text-ink-2'
                          }`}>
                          <TableIcon active={isActive} />
                          <span className="truncate flex-1">{dim.table.display_name || dim.name}</span>
                          {dim.usedBy.length > 1 && (
                            <span className="text-[9px] px-1.5 py-0.5 bg-ocean-softer text-ocean border border-line rounded font-mono tabular-nums" title={`Used in: ${dim.usedBy.join(', ')}`}>
                              {dim.usedBy.length}x
                            </span>
                          )}
                          {dim.table.profiled_at && (
                            <span className={`text-[9px] font-mono ${getFreshnessTextColor(getFreshnessStatus(dim.table.profiled_at))}`}>
                              {formatRelativeTime(dim.table.profiled_at)}
                            </span>
                          )}
                          <ScoreDot score={dim.table.overall_score} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* ── Transaction Tables (grouped by product) ── */}
            {factGroups.length > 0 && (
              <>
                <div className="px-3 pt-4 pb-1">
                  <button onClick={() => toggleSection('facts')} className="flex items-center gap-2 w-full text-left">
                    <ChevronIcon expanded={expandedSections.has('facts')} />
                    <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-ocean">Transaction tables</span>
                    <span className="text-[10px] font-mono text-muted-2 ml-auto tabular-nums">{factGroups.reduce((n, g) => n + g.tables.length, 0)}</span>
                  </button>
                </div>
                {expandedSections.has('facts') && (
                  <div className="ml-5 border-l border-line">
                    {factGroups.map((group) => (
                      <div key={group.productName}>
                        <div className="pl-4 pr-3 pt-3 pb-1">
                          <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted-2">{group.productName}</span>
                        </div>
                        {group.tables.map((t) => {
                          const isActive = selectedTable?.tableName === t.table_name && selectedTable?.productTableId === t.product_table_id;
                          return (
                            <button key={t.id}
                              onClick={() => { setSelectedTable({ connId: t.connection_id, tableName: t.table_name, displayName: t.display_name || undefined, productTableId: t.product_table_id }); setActivePill('detail'); }}
                              className={`w-full text-left flex items-center gap-2 pl-4 pr-3 py-[7px] text-[12px] transition-colors ${
                                isActive
                                  ? 'bg-ocean-softer text-ocean font-medium'
                                  : 'text-ink-3 hover:bg-softer hover:text-ink-2'
                              }`}>
                              <TableIcon active={isActive} />
                              <span className="truncate flex-1">{t.display_name || t.table_name}</span>
                              {t.profiled_at && (
                                <span className={`text-[9px] font-mono ${getFreshnessTextColor(getFreshnessStatus(t.profiled_at))}`}>
                                  {formatRelativeTime(t.profiled_at)}
                                </span>
                              )}
                              <ScoreDot score={t.overall_score} />
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>);
        })()}

        {tables.length === 0 && !loading && (
          <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2 px-3 py-4 text-center">No tables profiled yet</p>
        )}
      </div>
    </div>
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
