'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';

export interface LeftValue { v: string; matched: boolean }

export interface ValueComparisonResult {
  ok: boolean;
  reason: 'ok' | 'timeout' | 'query-failed';
  left: {
    table: string; column: string; values: LeftValue[];
    distinct: number; truncated: boolean;
  } | null;
  right: {
    table: string; column: string; values: string[];
    distinct: number; truncated: boolean; rangeLimited: boolean; shown: number;
  } | null;
  limit: number;
}

export interface ValueRow {
  left: LeftValue | null;
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
export function mergeSorted(left: readonly LeftValue[], right: readonly string[]): ValueRow[] {
  const out: ValueRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i >= left.length) { out.push({ left: null, right: right[j++] }); continue; }
    if (j >= right.length) { out.push({ left: left[i++], right: null }); continue; }
    if (left[i].v === right[j]) { out.push({ left: left[i++], right: right[j++] }); continue; }
    if (left[i].v < right[j]) out.push({ left: left[i++], right: null });
    else out.push({ left: null, right: right[j++] });
  }
  return out;
}

function SideHeader({ table, column, distinct, note }: {
  table: string; column: string; distinct: number; note?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12.5px] font-medium text-ink" title={`${table}.${column}`}>
        {column}
      </div>
      <div className="truncate text-[11px] text-muted">
        {table} · {distinct.toLocaleString('en-GB')} different values
        {note && ` · ${note}`}
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
  /**
   * The headline counts come from the per-value `matched` flag, which was
   * measured against the WHOLE parent column — never from the merge.
   *
   * A row can sit here with nothing opposite it simply because the parent's
   * window did not reach that far, and counting those as mismatches is how the
   * first version reported 458 problems on a relationship that measures a true
   * 100%. The gap on screen is an alignment aid; the tick is the fact.
   */
  const found = result?.left?.values.filter((v) => v.matched).length ?? 0;
  const total = result?.left?.values.length ?? 0;
  const shown = onlyDiff ? rows.filter((r) => r.left && !r.left.matched) : rows;

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
              <SideHeader
                table={result.left.table}
                column={result.left.column}
                distinct={result.left.distinct}
                note={result.left.truncated ? `showing first ${result.limit}` : undefined}
              />
              <SideHeader
                table={result.right.table}
                column={result.right.column}
                distinct={result.right.distinct}
                // Saying "first 300" here would be wrong AND misleading: this
                // side is not the first 300 of the column, it is the part that
                // lines up with the values on the left.
                note={result.right.rangeLimited
                  ? `showing ${result.right.shown} that line up with the left`
                  : undefined}
              />
            </div>

            <div className="flex items-center gap-3 border-b border-line/70 bg-surface px-5 py-1.5 text-[11.5px]">
              <span className="text-muted">
                <span className="font-medium tabular-nums text-ink">
                  {found.toLocaleString('en-GB')} of {total.toLocaleString('en-GB')}
                </span>{' '}
                shown values exist in {result.right.column}
                {total > found && (
                  <>
                    <span className="text-muted2"> · </span>
                    <span className="font-medium tabular-nums" style={{ color: '#a43a3a' }}>
                      {(total - found).toLocaleString('en-GB')}
                    </span>{' '}
                    not found
                  </>
                )}
              </span>
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-ink2">
                <input
                  type="checkbox"
                  checked={onlyDiff}
                  onChange={(e) => setOnlyDiff(e.target.checked)}
                  className="accent-ocean"
                />
                Only show what wasn&apos;t found
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {shown.length === 0 && (
                <p className="px-5 py-8 text-center text-[12.5px] text-muted">
                  {onlyDiff ? 'Every value shown was found on the other side.' : 'Both columns are empty.'}
                </p>
              )}
              {shown.map((r, i) => {
                // Highlight only what is genuinely wrong: a LEFT value that
                // does not exist in the parent. A right-hand value with nothing
                // opposite it is just a parent key nobody references, which is
                // normal and not a finding.
                const missing = !!r.left && !r.left.matched;
                return (
                  <div
                    key={`${r.left?.v ?? ''}|${r.right ?? ''}|${i}`}
                    className="grid grid-cols-2 gap-4 border-b border-line/40 px-5 py-[3px] font-mono text-[11.5px] last:border-b-0"
                    style={{ background: missing ? '#f9eaea' : undefined }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {r.left && (
                        <span
                          className="shrink-0 text-[10px] leading-none"
                          style={{ color: r.left.matched ? '#3f7a5c' : '#a43a3a' }}
                          aria-hidden
                        >
                          {r.left.matched ? '✓' : '✗'}
                        </span>
                      )}
                      {/* A missing value is drawn as an empty cell, not a dash
                          or a label: the gap is the alignment, and anything
                          written in it reads as a value. */}
                      <span
                        className="min-w-0 truncate"
                        style={{ color: r.left == null ? 'transparent' : missing ? '#a43a3a' : '#334049' }}
                        title={r.left?.v}
                      >
                        {r.left?.v ?? '·'}
                      </span>
                    </span>
                    <span
                      className="min-w-0 truncate"
                      style={{ color: r.right == null ? 'transparent' : '#334049' }}
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
              match. The tick is measured against the whole {result.right.column} column, not
              just the values shown here.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
