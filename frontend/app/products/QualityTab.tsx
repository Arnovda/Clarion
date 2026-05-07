'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Play, AlertTriangle, ChevronRight } from 'lucide-react';
import api from '@/lib/api';
import QualityPanel from '@/components/QualityPanel';

interface ProductTableHealth {
  id: number;
  connection_id: number;
  connection_name: string | null;
  table_name: string;
  display_name: string | null;
  layer: 'source' | 'product';
  product_id: number | null;
  product_name: string | null;
  product_table_id: number | null;
  table_role: string | null;
  profiled_at: string | null;
  overall_score: number | null;
  row_count: number | null;
}

interface FailingRule {
  rule_id: number;
  rule_name: string;
  dimension: string;
  connection_id: number;
  connection_name: string | null;
  table_name: string;
  pass_rate: number;
  pass_threshold: number;
  executed_at: string | null;
  total_records: number | null;
  failing_records: number | null;
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

export default function QualityTab({ productNameFilter }: { productNameFilter?: string } = {}) {
  const [tables, setTables] = useState<ProductTableHealth[]>([]);
  const [failingRules, setFailingRules] = useState<FailingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ProductTableHealth | null>(null);
  const [profilingProduct, setProfilingProduct] = useState<string | null>(null);
  const [profilingProgress, setProfilingProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tablesRes, rulesRes] = await Promise.all([
        api.get('/quality/tables'),
        api.get('/quality/rules/failing').catch(() => ({ data: { data: [] } })),
      ]);
      const all = (tablesRes.data.data ?? []) as ProductTableHealth[];
      const filtered = all.filter((t) => t.layer === 'product');
      setTables(productNameFilter ? filtered.filter((t) => t.product_name === productNameFilter) : filtered);
      setFailingRules(rulesRes.data.data ?? []);
    } catch { /* noop */ } finally { setLoading(false); }
  }, [productNameFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  // Drill into a failing rule by jumping to its (connection, table) in the
  // QualityPanel, which already has a Rules tab. We synthesise a minimal
  // ProductTableHealth shape so the existing `selected` flow handles it
  // without a second code path.
  const openRule = useCallback((rule: FailingRule) => {
    const match = tables.find((t) => t.connection_id === rule.connection_id && t.table_name === rule.table_name);
    if (match) { setSelected(match); return; }
    setSelected({
      id: -rule.rule_id, // negative so it can't collide with a real table id
      connection_id: rule.connection_id,
      connection_name: rule.connection_name,
      table_name: rule.table_name,
      display_name: rule.table_name.replace(/_/g, ' '),
      layer: 'product',
      product_id: null,
      product_name: null,
      product_table_id: null,
      table_role: null,
      profiled_at: null,
      overall_score: null,
      row_count: null,
    });
  }, [tables]);

  const profileAll = useCallback(async (productName: string, ptables: ProductTableHealth[]) => {
    setProfilingProduct(productName);
    setProfilingProgress({ done: 0, total: ptables.length });
    for (let i = 0; i < ptables.length; i++) {
      const t = ptables[i];
      if (t.product_table_id == null) { setProfilingProgress({ done: i + 1, total: ptables.length }); continue; }
      try { await api.post(`/quality/product/${t.product_table_id}/profile`); } catch { /* continue */ }
      setProfilingProgress({ done: i + 1, total: ptables.length });
    }
    setProfilingProduct(null);
    await loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-5 h-5 text-ocean animate-spin" strokeWidth={2} />
      </div>
    );
  }

  if (selected) {
    return (
      <div className="p-4">
        <button
          onClick={() => setSelected(null)}
          className="mb-3 text-[11px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink-2 transition-colors"
        >
          ← Back to overview
        </button>
        <QualityPanel
          connId={selected.connection_id}
          tableName={selected.table_name}
          displayName={selected.display_name ?? undefined}
          productTableId={selected.product_table_id ?? undefined}
        />
      </div>
    );
  }

  const profiled = tables.filter((t) => t.overall_score !== null);
  const avgScore = profiled.length > 0
    ? Math.round((profiled.reduce((s, t) => s + (t.overall_score ?? 0), 0) / profiled.length) * 100)
    : 0;

  // Group source → product. Same-name products from different sources
  // (e.g. two "Sales" products, one per ERP) used to merge silently
  // because the key was `product_name` alone. Now keyed first by source
  // name, then by product_id, so they stay distinct + render under the
  // correct source bucket — matches /catalog + BuildDashboard grouping.
  type ProductGroup = { productId: number; productName: string; tables: ProductTableHealth[] };
  const bySource: Record<string, Record<number, ProductGroup>> = {};
  for (const t of tables) {
    const sourceKey = t.connection_name ?? '__unassigned';
    const productKey = t.product_id ?? -1;
    if (!bySource[sourceKey]) bySource[sourceKey] = {};
    if (!bySource[sourceKey][productKey]) {
      bySource[sourceKey][productKey] = {
        productId: t.product_id ?? -1,
        productName: t.product_name ?? 'Untitled',
        tables: [],
      };
    }
    bySource[sourceKey][productKey].tables.push(t);
  }
  const orderedSources = Object.keys(bySource).sort((a, b) => {
    if (a === '__unassigned') return 1;
    if (b === '__unassigned') return -1;
    return a.localeCompare(b);
  });
  const totalProducts = orderedSources.reduce((n, s) => n + Object.keys(bySource[s]).length, 0);

  if (tables.length === 0) {
    return (
      <div className={productNameFilter ? '' : 'max-w-5xl mx-auto px-6 pt-8 pb-10'}>
        <div className="bg-raised border border-line rounded-lg p-12 text-center">
          <p className="text-[13px] text-ink-3">
            {productNameFilter
              ? 'No tables in this product yet, or none have been profiled.'
              : 'No product tables yet. Build a product first to see quality scores.'}
          </p>
        </div>
      </div>
    );
  }

  const ringColor = avgScore >= 90 ? 'var(--ok)' : avgScore >= 70 ? 'var(--warn)' : 'var(--err)';

  if (productNameFilter) {
    const ptables = tables;
    const isProfiling = profilingProduct === productNameFilter;
    const sorted = [...ptables].sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2));
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-full border-2 flex items-center justify-center"
              style={{ borderColor: ringColor }}
            >
              <span className="font-display text-[16px] tabular-nums text-ink">{avgScore}</span>
            </div>
            <div>
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">Overall score</p>
              <p className="text-[12px] text-ink-2">{profiled.length} of {tables.length} tables profiled</p>
            </div>
          </div>
          {isProfiling ? (
            <div className="flex items-center gap-2 text-[11px] text-ocean">
              <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
              Profiling {profilingProgress.done}/{profilingProgress.total}…
            </div>
          ) : (
            <button
              onClick={() => profileAll(productNameFilter, ptables)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium text-ocean hover:bg-ocean-softer transition-colors"
            >
              <Play className="w-2.5 h-2.5" strokeWidth={2} fill="currentColor" />
              Profile all
            </button>
          )}
        </div>
        <div className="bg-raised border border-line rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Table</th>
                <th className="text-center px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Score</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Rows</th>
                <th className="text-right px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Last profiled</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelected(t)}
                  className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer"
                >
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
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 pt-8 pb-10 space-y-6">
      {/* Hero score */}
      <div className="bg-raised border border-line rounded-lg p-8 flex items-center gap-8">
        <div
          className="w-24 h-24 rounded-full border-2 flex items-center justify-center flex-shrink-0"
          style={{ borderColor: ringColor }}
        >
          <span className="font-display text-[36px] leading-none tabular-nums text-ink tracking-[-0.02em]">{avgScore}</span>
        </div>
        <div className="flex-1">
          <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Overall score</p>
          <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.01em]">Product health</h2>
          <p className="text-[13px] text-ink-3 mt-1 leading-relaxed">
            {profiled.length} of {tables.length} product tables profiled across {totalProducts} products
            {orderedSources.filter((s) => s !== '__unassigned').length > 1 && (
              <> · {orderedSources.filter((s) => s !== '__unassigned').length} sources</>
            )}
          </p>
        </div>
      </div>

      {/* Failing rules — what's actually broken right now. Renders only
          when rules are present + sub-threshold. Each row clicks through
          to the QualityPanel for that table so users can see the failing
          records and act. */}
      {failingRules.length > 0 && (
        <div className="bg-raised border border-line rounded-lg overflow-hidden">
          <div className="px-5 py-3 bg-warn-soft border-b border-line flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-warn" strokeWidth={2} />
            <p className="text-[11px] font-mono tracking-[0.1em] uppercase text-ink-2 font-medium">
              {failingRules.length} rule{failingRules.length === 1 ? '' : 's'} failing
            </p>
          </div>
          <ul>
            {failingRules.map((r) => {
              const pct = Math.round(r.pass_rate * 100);
              const thresholdPct = Math.round(r.pass_threshold * 100);
              return (
                <li key={r.rule_id}>
                  <button
                    onClick={() => openRule(r)}
                    className="w-full text-left px-5 py-3 border-b border-line last:border-b-0 hover:bg-softer transition-colors flex items-center gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-ink leading-tight">{r.rule_name}</p>
                      <p className="text-[11px] text-muted-2 mt-0.5 font-mono tracking-[0.04em]">
                        {r.connection_name ?? `connection #${r.connection_id}`} · {r.table_name}
                        {r.failing_records != null && r.total_records != null && (
                          <> · {r.failing_records.toLocaleString()} of {r.total_records.toLocaleString()} records failing</>
                        )}
                      </p>
                    </div>
                    <span className="text-[12px] font-mono tabular-nums px-2 py-0.5 rounded border border-line bg-err-soft text-err">
                      {pct}%
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 hidden sm:inline">
                      ≥ {thresholdPct}% expected
                    </span>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-2 flex-shrink-0" strokeWidth={1.75} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Source → product → tables. Source headers suppressed when only
          one source is in scope; otherwise each source gets its own
          ocean-coloured eyebrow band so users can scan to the right
          ERP first, then drill into a specific product. */}
      {orderedSources.map((sourceKey) => {
        const productGroups = Object.values(bySource[sourceKey])
          .sort((a, b) => a.productName.localeCompare(b.productName));
        const showSourceHeader = orderedSources.length > 1;
        return (
          <div key={sourceKey} className="space-y-3">
            {showSourceHeader && (
              <div className="flex items-baseline gap-2 px-1">
                <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">
                  {sourceKey === '__unassigned' ? 'Unassigned' : sourceKey}
                </span>
                <span className="text-[10.5px] font-mono tabular-nums text-muted-2">
                  {productGroups.length} product{productGroups.length === 1 ? '' : 's'}
                </span>
              </div>
            )}
            {productGroups.map((pg) => {
              const ptables = pg.tables;
              const isProfiling = profilingProduct === pg.productName;
              const sorted = [...ptables].sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2));
              return (
                <div key={pg.productId} className="bg-raised border border-line rounded-lg overflow-hidden">
                  <div className="px-5 py-3 bg-softer border-b border-line flex items-center justify-between">
                    <p className="text-[11px] font-mono tracking-[0.1em] uppercase text-ink-2 font-medium">{pg.productName}</p>
                    {isProfiling ? (
                      <div className="flex items-center gap-2 text-[11px] text-ocean">
                        <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
                        Profiling {profilingProgress.done}/{profilingProgress.total}…
                      </div>
                    ) : (
                      <button
                        onClick={() => profileAll(pg.productName, ptables)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium text-ocean hover:bg-ocean-softer transition-colors"
                      >
                        <Play className="w-2.5 h-2.5" strokeWidth={2} fill="currentColor" />
                        Profile all
                      </button>
                    )}
                  </div>
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="text-left px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Table</th>
                        <th className="text-center px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Score</th>
                        <th className="text-right px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Rows</th>
                        <th className="text-right px-5 py-2.5 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Last profiled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((t) => (
                        <tr
                          key={t.id}
                          onClick={() => setSelected(t)}
                          className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer"
                        >
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
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
