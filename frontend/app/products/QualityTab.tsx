'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Play } from 'lucide-react';
import api from '@/lib/api';
import QualityPanel from '@/components/QualityPanel';

interface ProductTableHealth {
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

export default function QualityTab() {
  const [tables, setTables] = useState<ProductTableHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ProductTableHealth | null>(null);
  const [profilingProduct, setProfilingProduct] = useState<string | null>(null);
  const [profilingProgress, setProfilingProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/quality/tables');
      const all = (res.data.data ?? []) as ProductTableHealth[];
      setTables(all.filter((t) => t.layer === 'product'));
    } catch { /* noop */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

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

  // Group by product
  const byProduct: Record<string, ProductTableHealth[]> = {};
  for (const t of tables) {
    const k = t.product_name ?? 'Untitled';
    if (!byProduct[k]) byProduct[k] = [];
    byProduct[k].push(t);
  }

  if (tables.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-10">
        <div className="bg-raised border border-line rounded-lg p-12 text-center">
          <p className="text-[13px] text-ink-3">No product tables yet. Build a product first to see quality scores.</p>
        </div>
      </div>
    );
  }

  const ringColor = avgScore >= 90 ? 'var(--ok)' : avgScore >= 70 ? 'var(--warn)' : 'var(--err)';

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
            {profiled.length} of {tables.length} product tables profiled across {Object.keys(byProduct).length} products
          </p>
        </div>
      </div>

      {/* Per-product groups */}
      {Object.entries(byProduct).map(([productName, ptables]) => {
        const isProfiling = profilingProduct === productName;
        const sorted = [...ptables].sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2));
        return (
          <div key={productName} className="bg-raised border border-line rounded-lg overflow-hidden">
            <div className="px-5 py-3 bg-softer border-b border-line flex items-center justify-between">
              <p className="text-[11px] font-mono tracking-[0.1em] uppercase text-ink-2 font-medium">{productName}</p>
              {isProfiling ? (
                <div className="flex items-center gap-2 text-[11px] text-ocean">
                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
                  Profiling {profilingProgress.done}/{profilingProgress.total}…
                </div>
              ) : (
                <button
                  onClick={() => profileAll(productName, ptables)}
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
}
