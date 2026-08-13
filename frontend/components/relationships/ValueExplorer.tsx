'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';

export interface ColumnSide {
  table: string;
  column: string;
  values: string[];
  distinct: number;
}

export interface ValueComparisonResult {
  ok: boolean;
  reason: 'ok' | 'timeout' | 'query-failed';
  left: ColumnSide | null;
  right: ColumnSide | null;
  limit: number;
}

export interface ValueRow {
  left: string | null;
  right: string | null;
}

/**
 * Interleave two sorted lists so equal values land on the SAME row.
 *
 * This is the difference between showing two lists and showing a comparison.
 * Side by side but independently scrolled, two columns tell you almost nothing:
 * row 40 on the left has no relationship to row 40 on the right. Merged, a
 * value present on both sides occupies one row and a value present on only one
 * leaves a gap opposite it — so the shape of the mismatch is the shape of the
 * whitespace, readable without comparing a single character.
 *
 * With a `BE 0123.456` / `be0123456` formatting difference every row is a gap,
 * and the two ragged columns say "these never line up" at a glance. That is
 * exactly the conclusion a percentage cannot deliver.
 */
export function mergeSorted(left: readonly string[], right: readonly string[]): ValueRow[] {
  const out: ValueRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i >= left.length) { out.push({ left: null, right: right[j++] }); continue; }
    if (j >= right.length) { out.push({ left: left[i++], right: null }); continue; }
    if (left[i] === right[j]) { out.push({ left: left[i++], right: right[j++] }); continue; }
    if (left[i] < right[j]) out.push({ left: left[i++], right: null });
    else out.push({ left: null, right: right[j++] });
  }
  return out;
}

function SideHeader({ side, limit }: { side: ColumnSide; limit: number }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12.5px] font-medium text-ink" title={`${side.table}.${side.column}`}>
        {side.column}
      </div>
      <div className="truncate text-[11px] text-muted">
        {side.table} · {side.distinct.toLocaleString('en-GB')} different values
        {side.distinct > limit && ` · showing first ${limit}`}
      </div>
    </div>
  );
}

/**
 * Read both columns against each other.
 *
 * Sits in the middle of the screen rather than in the side panel on purpose:
 * this is not a property of the relationship, it is an investigation, and it
 * wants the width to put two columns of real values next to each other.
 */
export function ValueExplorer({
  title, result, loading, onClose,
}: {
  title: string;
  result: ValueComparisonResult | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [onlyDiff, setOnlyDiff] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = useMemo(
    () => (result?.left && result?.right ? mergeSorted(result.left.values, result.right.values) : []),
    [result],
  );
  const shown = onlyDiff ? rows.filter((r) => !r.left || !r.right) : rows;
  const shared = rows.length - rows.filter((r) => !r.left || !r.right).length;

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-ink/20 p-6 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3 border-b border-line/70 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
              Compare the values
            </div>
            <div className="mt-0.5 truncate text-[13px] text-ink">{title}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted2 hover:bg-soft hover:text-ink"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 px-5 py-10 text-[13px] text-muted">
            <Loader2 size={15} className="animate-spin" />
            Reading both columns…
          </div>
        )}

        {!loading && result && !result.ok && (
          <div className="flex items-start gap-2 px-5 py-8 text-[13px] text-ink2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
            {result.reason === 'timeout'
              ? 'Reading these columns took too long. They may be very large, or the source may still be syncing.'
              : "We couldn't read those columns — the source may not have finished syncing."}
          </div>
        )}

        {!loading && result?.ok && result.left && result.right && (
          <>
            <div className="grid grid-cols-2 gap-4 border-b border-line/70 px-5 py-2.5">
              <SideHeader side={result.left} limit={result.limit} />
              <SideHeader side={result.right} limit={result.limit} />
            </div>

            <div className="flex items-center gap-3 border-b border-line/70 bg-surface px-5 py-1.5 text-[11.5px]">
              <span className="text-muted">
                <span className="font-medium tabular-nums text-ink">{shared.toLocaleString('en-GB')}</span>{' '}
                on both sides
                <span className="text-muted2"> · </span>
                <span className="font-medium tabular-nums text-ink">
                  {(rows.length - shared).toLocaleString('en-GB')}
                </span>{' '}
                on one side only
              </span>
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-ink2">
                <input
                  type="checkbox"
                  checked={onlyDiff}
                  onChange={(e) => setOnlyDiff(e.target.checked)}
                  className="accent-ocean"
                />
                Only show differences
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {shown.length === 0 && (
                <p className="px-5 py-8 text-center text-[12.5px] text-muted">
                  {onlyDiff ? 'Every value shown exists on both sides.' : 'Both columns are empty.'}
                </p>
              )}
              {shown.map((r, i) => {
                const both = r.left != null && r.right != null;
                return (
                  <div
                    key={`${r.left ?? ''}|${r.right ?? ''}|${i}`}
                    className="grid grid-cols-2 gap-4 border-b border-line/40 px-5 py-[3px] font-mono text-[11.5px] last:border-b-0"
                    style={{ background: both ? undefined : '#fbf7f0' }}
                  >
                    {/* A missing value is drawn as an empty cell, not a dash or
                        a label. The gap IS the finding, and anything written in
                        it reads as a value. */}
                    <span
                      className="min-w-0 truncate"
                      style={{ color: r.left == null ? 'transparent' : both ? '#334049' : '#a06a1c' }}
                      title={r.left ?? undefined}
                    >
                      {r.left ?? '·'}
                    </span>
                    <span
                      className="min-w-0 truncate"
                      style={{ color: r.right == null ? 'transparent' : both ? '#334049' : '#a06a1c' }}
                      title={r.right ?? undefined}
                    >
                      {r.right ?? '·'}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-line/70 bg-surface px-5 py-2 text-[11px] leading-relaxed text-muted2">
              Sorted and compared as text, the same way Clarion checks whether the values
              match. Rows where a value exists on one side only are highlighted.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
