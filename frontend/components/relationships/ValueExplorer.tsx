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
    distinct: number; truncated: boolean; shown: number;
  } | null;
  limit: number;
}

/**
 * There is deliberately NO merge here, and the reason is worth keeping.
 *
 * An earlier version interleaved the two lists so equal values shared a row. It
 * looked like the most informative thing to do and it was the least: in a
 * containment check "found" means the two values are **textually equal**, so a
 * paired row showed the same string twice, and an unpaired row showed a blank.
 * Neither case carried information. What the alignment *did* do was fill the
 * gaps with parent keys nobody asked about — with 20 child values against 1,289
 * parent values, that was 280 rows of noise before the first row that mattered.
 *
 * So the two columns are independent lists, each ascending, each scrolling on
 * its own. Nothing on screen implies a row-by-row correspondence, because there
 * is none. The tick carries the only fact that needs carrying, and it is
 * measured against the whole parent column rather than the sample beside it.
 */
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

function ValueRow({ text, mark }: { text: string; mark?: 'found' | 'missing' }) {
  const missing = mark === 'missing';
  return (
    <div
      className="flex items-center gap-1.5 px-5 py-[3px] font-mono text-[11.5px]"
      style={{ background: missing ? '#f9eaea' : undefined }}
    >
      {mark && (
        <span
          className="shrink-0 text-[10px] leading-none"
          style={{ color: missing ? '#a43a3a' : '#3f7a5c' }}
          aria-hidden
        >
          {missing ? '✗' : '✓'}
        </span>
      )}
      <span
        className="min-w-0 truncate"
        style={{ color: missing ? '#a43a3a' : '#334049' }}
        title={text}
      >
        {text === '' ? <span className="text-muted2">(blank)</span> : text}
      </span>
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

  /**
   * Counts come from the per-value `matched` flag, measured against the WHOLE
   * parent column — never from what happens to be listed beside it. Deriving
   * them from the two visible lists is what once reported 458 mismatches on a
   * relationship measuring a true 100%.
   */
  const found = result?.left?.values.filter((v) => v.matched).length ?? 0;
  const total = result?.left?.values.length ?? 0;
  const leftShown = useMemo(() => {
    const all = result?.left?.values ?? [];
    return onlyDiff ? all.filter((v) => !v.matched) : all;
  }, [result, onlyDiff]);

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
            <div className="flex items-center gap-3 border-b border-line/70 bg-surface px-5 py-2 text-[12px]">
              <span className="min-w-0 text-muted">
                <span className="font-medium tabular-nums text-ink">
                  {found.toLocaleString('en-GB')} of {total.toLocaleString('en-GB')}
                </span>{' '}
                {result.left.column} values exist in {result.right.column}
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
              {total > found && (
                <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 text-ink2">
                  <input
                    type="checkbox"
                    checked={onlyDiff}
                    onChange={(e) => setOnlyDiff(e.target.checked)}
                    className="accent-ocean"
                  />
                  Only show what wasn&apos;t found
                </label>
              )}
            </div>

            {/* Two panes, each scrolling on its own. Position carries no meaning
                across the divider, and nothing here suggests it does. */}
            <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-line/70">
              <div className="flex min-h-0 flex-col">
                <div className="border-b border-line/50 px-5 py-2">
                  <SideHeader
                    table={result.left.table}
                    column={result.left.column}
                    distinct={result.left.distinct}
                    note={result.left.truncated ? `first ${result.left.values.length}` : undefined}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-1">
                  {leftShown.length === 0 ? (
                    <p className="px-5 py-6 text-[12px] text-muted">
                      Every value was found on the other side.
                    </p>
                  ) : leftShown.map((val) => (
                    <ValueRow key={val.v} text={val.v} mark={val.matched ? 'found' : 'missing'} />
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="border-b border-line/50 px-5 py-2">
                  <SideHeader
                    table={result.right.table}
                    column={result.right.column}
                    distinct={result.right.distinct}
                    note={result.right.truncated ? `first ${result.right.shown}` : undefined}
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-1">
                  {result.right.values.map((v) => <ValueRow key={v} text={v} />)}
                </div>
              </div>
            </div>

            <div className="border-t border-line/70 bg-surface px-5 py-2 text-[11px] leading-relaxed text-muted2">
              Compared as text, the same way Clarion checks whether the values match. The tick is
              measured against the whole {result.right.column} column — the list beside it is a
              sample of what that column looks like, not what each value matched against.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
