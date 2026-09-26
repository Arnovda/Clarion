'use client';

/**
 * <QualityOverview> — embeddable "is my data trustworthy?" surface.
 *
 * A shell-free version of the old /health overview. `compact` (the catalog
 * landing) renders <CompactHealth> instead: one sentence + what needs a look.
 * Self-contained: loads /quality/tables, shows an average-score hero + a
 * worst-first table grid, and drills into the existing <QualityPanel> inline.
 *
 * Deliberately NO IconRail/ContextPanel — the host page already provides the
 * shell. This is composition, reusing the working QualityPanel for detail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, ChevronLeft, ChevronDown, ChevronRight, Play, RotateCw } from 'lucide-react';
import api from '@/lib/api';
import QualityPanel from '@/components/QualityPanel';
import { formatDate, formatRelativeLong } from '@/lib/dates';

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

export default function QualityOverview({ compact = false }: { compact?: boolean } = {}) {
  const [tables, setTables] = useState<TableHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<
    { connId: number; tableName: string; displayName?: string; productTableId?: number | null } | null
  >(null);
  const [profiling, setProfiling] = useState<{ done: number; total: number } | null>(null);

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

  // Profile every table (source tables by connection+name, product tables by
  // product_table_id). User-initiated; runs sequentially with a progress
  // counter so the user can see it work. Profiling can also be triggered
  // per-source from Sources (Studio) — this is the convenient "do it all" path.
  const profileAll = useCallback(async () => {
    if (profiling) return;
    setProfiling({ done: 0, total: tables.length });
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      try {
        if (t.layer === 'product' && t.product_table_id != null) {
          await api.post(`/quality/product/${t.product_table_id}/profile`);
        } else if ((t.layer ?? 'source') === 'source') {
          await api.post(`/quality/${t.connection_id}/${encodeURIComponent(t.table_name)}/profile`);
        }
      } catch { /* continue on error */ }
      setProfiling({ done: i + 1, total: tables.length });
    }
    setProfiling(null);
    await load();
  }, [profiling, tables, load]);

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
          Back
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

  const openTable = (t: TableHealth) => setSelected({
    connId: t.connection_id,
    tableName: t.table_name,
    displayName: t.display_name || undefined,
    productTableId: t.product_table_id ?? undefined,
  });

  if (compact) {
    return (
      <CompactHealth
        tables={tables}
        sorted={sorted}
        profiling={profiling}
        onProfileAll={profileAll}
        onOpen={openTable}
      />
    );
  }

  return (
    <div className="space-y-6">
      {!compact && (
        <div>
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Catalog</p>
          <h1 className="font-display text-[28px] text-ink leading-tight tracking-[-0.02em] mb-1">Trust</h1>
          <p className="text-[12.5px] text-muted leading-relaxed max-w-2xl">
            How healthy your data is — completeness, validity and freshness across every table. Click a table to see what&apos;s driving its score.
          </p>
        </div>
      )}

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
        {tables.length > 0 && (
          <div className="flex-shrink-0">
            {profiling ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-ocean-softer text-ocean text-[12px] font-medium border border-line">
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                Checking {profiling.done}/{profiling.total}…
              </div>
            ) : (
              <button
                type="button"
                onClick={profileAll}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-ocean text-white text-[13px] font-medium hover:bg-ocean-hover transition-colors"
              >
                <Play className="w-3.5 h-3.5" strokeWidth={2} fill="currentColor" />
                Check all {tables.length} tables
              </button>
            )}
          </div>
        )}
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
                onClick={() => openTable(t)}
                className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer"
              >
                <TableRowCells t={t} />
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

function TableRowCells({ t }: { t: TableHealth }) {
  return (
    <>
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
    </>
  );
}

/** Older than this and the summary says the reading may have moved since. */
const STALE_DAYS = 14;

/**
 * The catalog landing's health: ONE sentence, not a dashboard.
 *
 * The full overview (a score ring over a worst-first list of every table)
 * read fine on its own page, but on the landing it became the page: on a
 * healthy workspace it is seventy rows of green 100%, the one line that
 * needed a decision sat above it in small type, and the loudest control on
 * screen was "check all tables" — a sweep nobody needed that minute. And an
 * average that is 100 says nothing when the checks are weeks old, which is
 * exactly when it reads most reassuring.
 *
 * So: a sentence that says how many tables pass and WHEN they were checked,
 * the tables that need a look listed by name (below 90%, or never checked),
 * and the full list behind a disclosure for whoever wants to browse it.
 */
function CompactHealth({
  tables, sorted, profiling, onProfileAll, onOpen,
}: {
  tables: TableHealth[];
  sorted: TableHealth[];
  profiling: { done: number; total: number } | null;
  onProfileAll: () => void;
  onOpen: (t: TableHealth) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  if (tables.length === 0) {
    return (
      <div className="bg-raised border border-line rounded-lg px-4 py-3 text-[13px] text-ink-3">
        No tables have been checked yet. Once a source is synced and analysed, its tables show up here.
      </div>
    );
  }

  const checked = tables.filter((t) => t.overall_score !== null);
  const neverChecked = tables.filter((t) => t.overall_score === null);
  const needLook = sorted.filter((t) => t.overall_score !== null && t.overall_score < 0.9);
  const dates = checked
    .map((t) => (t.profiled_at ? new Date(t.profiled_at).getTime() : NaN))
    .filter((n) => !isNaN(n));
  const oldest = dates.length ? Math.min(...dates) : null;
  const newest = dates.length ? Math.max(...dates) : null;
  const oldestDays = oldest != null ? Math.floor((Date.now() - oldest) / 86_400_000) : null;
  const stale = oldestDays != null && oldestDays > STALE_DAYS;
  const sameDay = oldest != null && newest != null && formatDate(new Date(oldest)) === formatDate(new Date(newest));

  const headline = checked.length === 0
    ? 'None of your tables have been checked yet.'
    : needLook.length === 0
      ? `All ${checked.length} checked ${checked.length === 1 ? 'table passes' : 'tables pass'} their checks.`
      : `${needLook.length} of ${checked.length} checked ${checked.length === 1 ? 'table needs' : 'tables need'} a look.`;

  const when = oldest == null
    ? null
    : sameDay
      ? `Checked ${formatRelativeLong(new Date(oldest))}`
      : `Checked between ${formatDate(new Date(oldest))} and ${formatDate(new Date(newest!))}`;

  const dot = checked.length === 0 ? 'bg-line' : needLook.some((t) => (t.overall_score ?? 1) < 0.7) ? 'bg-err' : needLook.length > 0 ? 'bg-warn' : 'bg-ok';

  return (
    <div className="bg-raised border border-line rounded-lg">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={`w-2 h-2 rounded-full mt-[7px] shrink-0 ${dot}`} aria-hidden />
        <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
          <p className="text-ink">{headline}</p>
          {(when || neverChecked.length > 0) && (
            <p className={`text-[12.5px] ${stale ? 'text-warn' : 'text-muted'}`}>
              {when}
              {when && stale && ' — the numbers may have moved since'}
              {when && '.'}
              {neverChecked.length > 0 && (
                <span className="text-muted">
                  {when ? ' ' : ''}{neverChecked.length} {neverChecked.length === 1 ? 'table has' : 'tables have'} never been checked.
                </span>
              )}
            </p>
          )}
        </div>
        {profiling ? (
          <span className="shrink-0 inline-flex items-center gap-1.5 text-[12px] font-medium text-ocean">
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden />
            Checking {profiling.done}/{profiling.total}…
          </span>
        ) : (
          <button
            type="button"
            onClick={onProfileAll}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-soft transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
            {checked.length === 0 ? 'Check them' : 'Check again'}
          </button>
        )}
      </div>

      {(needLook.length > 0 || neverChecked.length > 0) && (
        <table className="w-full border-t border-line">
          <tbody>
            {[...needLook, ...neverChecked].map((t) => (
              <tr
                key={t.id}
                onClick={() => onOpen(t)}
                className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer"
              >
                <TableRowCells t={t} />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="border-t border-line">
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="w-full flex items-center gap-1.5 px-4 py-2 text-left text-[12px] font-medium text-muted hover:text-ink transition-colors"
        >
          {showAll
            ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
            : <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />}
          {showAll ? 'Hide the list' : `Show all ${tables.length} tables`}
        </button>
        {showAll && (
          <table className="w-full border-t border-line">
            <tbody>
              {sorted.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => onOpen(t)}
                  className="cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-softer"
                >
                  <TableRowCells t={t} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
