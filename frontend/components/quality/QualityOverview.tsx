'use client';

/**
 * <QualityOverview> — embeddable "is my data trustworthy?" surface.
 *
 * A shell-free version of the /health overview, designed to mount inside the
 * Catalog "Trust" facet (and anywhere else that wants quality at a glance).
 * Self-contained: loads /quality/tables, shows an average-score hero + a
 * worst-first table grid, and drills into the existing <QualityPanel> inline.
 *
 * Deliberately NO IconRail/ContextPanel — the host page already provides the
 * shell. This is composition, reusing the working QualityPanel for detail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ChevronLeft } from 'lucide-react';
import api from '@/lib/api';
import QualityPanel from '@/components/QualityPanel';

interface TableHealth {
  id: number;
  connection_id: number;
  table_name: string;
  display_name: string | null;
  layer: 'source' | 'product';
  product_name: string | null;
  product_table_id: number | null;
  overall_score: number | null;
  row_count: number | null;
  profiled_at: string | null;
}

function ScoreCell({ score }: { score: number | null }) {
  if (score === null) return <span className="text-[11px] text-muted-2">—</span>;
  const pct = Math.round(score * 100);
  const cls = pct >= 90 ? 'bg-ok-soft text-ok' : pct >= 70 ? 'bg-warn-soft text-warn' : 'bg-err-soft text-err';
  return <span className={`text-[12px] font-mono tracking-[0.04em] tabular-nums px-2 py-0.5 rounded border border-line ${cls}`}>{pct}%</span>;
}

function ScoreDot({ score }: { score: number | null }) {
  const cls = score === null ? 'bg-line' : (score >= 0.9 ? 'bg-ok' : score >= 0.7 ? 'bg-warn' : 'bg-err');
  return <span className={`w-2 h-2 rounded-full ${cls} inline-block`} />;
}

export default function QualityOverview() {
  const [tables, setTables] = useState<TableHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<
    { connId: number; tableName: string; displayName?: string; productTableId?: number | null } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/quality/tables');
      setTables((res.data?.data ?? []) as TableHealth[]);
    } catch {
      setTables([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const profiled = useMemo(() => tables.filter((t) => t.overall_score !== null), [tables]);
  const avgScore = profiled.length > 0
    ? Math.round((profiled.reduce((s, t) => s + (t.overall_score ?? 0), 0) / profiled.length) * 100)
    : 0;
  const sorted = useMemo(
    () => [...tables].sort((a, b) => (a.overall_score ?? 2) - (b.overall_score ?? 2)),
    [tables],
  );
  const ringColor = avgScore >= 90 ? 'var(--ok)' : avgScore >= 70 ? 'var(--warn)' : 'var(--err)';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-5 h-5 text-ocean animate-spin" strokeWidth={2} />
      </div>
    );
  }

  // Inline detail — reuse the existing QualityPanel.
  if (selected) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="inline-flex items-center gap-1.5 mb-4 px-2.5 py-1 text-[12px] font-medium text-muted hover:text-ink rounded hover:bg-soft transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2} />
          Back to all tables
        </button>
        <QualityPanel
          connId={selected.connId}
          tableName={selected.tableName}
          displayName={selected.displayName}
          productTableId={selected.productTableId ?? undefined}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Catalog</p>
        <h1 className="font-display text-[28px] text-ink leading-tight tracking-[-0.02em] mb-1">Trust</h1>
        <p className="text-[12.5px] text-muted leading-relaxed max-w-2xl">
          How healthy your data is — completeness, validity and freshness across every table. Click a table to see what's driving its score.
        </p>
      </div>

      {/* Hero score */}
      <div className="bg-raised border border-line rounded-lg p-8 flex items-center gap-8">
        <div className="w-24 h-24 rounded-full border-2 flex items-center justify-center flex-shrink-0" style={{ borderColor: ringColor }}>
          <span className="font-display text-[36px] leading-none tabular-nums text-ink tracking-[-0.02em]">{avgScore}</span>
        </div>
        <div className="flex-1">
          <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Overall score</p>
          <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.01em]">Health status</h2>
          <p className="text-[13px] text-ink-3 mt-1 leading-relaxed">
            {profiled.length} of {tables.length} tables profiled across all your data
          </p>
        </div>
      </div>

      {/* Worst-first table grid */}
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
            {sorted.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSelected({
                  connId: t.connection_id,
                  tableName: t.table_name,
                  displayName: t.display_name || undefined,
                  productTableId: t.product_table_id ?? undefined,
                })}
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
        {tables.length === 0 && (
          <div className="text-center py-12 text-[13px] text-ink-3">
            No tables profiled yet. Connect a source and run profiling to see quality here.
          </div>
        )}
      </div>
    </div>
  );
}
