'use client';

import { useMemo, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { collapseUnchanged, diffLines, diffStats } from './diff';

// ---------------------------------------------------------------------------
// The proposed change, shown where it would land.
//
// The AI does not write a cell any more — it proposes, and this is the review:
// what would be removed, what would come in its place, and two buttons. Until
// Keep is pressed the cell still holds the user's own code, so rejecting is
// not an undo, it is simply not doing the thing.
//
// It renders IN THE CELL rather than in the assistant panel on purpose. The
// panel is 440px wide and code needs width; more importantly the question
// being asked — "is this logic right?" — is asked about the cell, and the
// answer is easier to see in the place the code will actually live.
// ---------------------------------------------------------------------------

interface CellDiffProps {
  /** What the cell holds now — restored verbatim on reject. */
  previous: string;
  /** What the AI proposes to put there. */
  proposed: string;
  onAccept: () => void;
  onReject: () => void;
}

export default function CellDiff({ previous, proposed, onAccept, onReject }: CellDiffProps) {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => diffLines(previous, proposed), [previous, proposed]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  // Long untouched stretches fold away: a 200-line query with a one-line edit
  // should not make the reader scroll past 199 lines to find the change.
  const rows = useMemo(
    () => (showAll ? lines.map((line) => ({ line })) : collapseUnchanged(lines, 3)),
    [lines, showAll],
  );

  return (
    <div className="border-t border-violet-200/60 bg-violet-50/20">
      {/* The decision bar. It LEADS, because the decision is the point and a
          long diff must never push the buttons below the fold — the diff
          body scrolls under it, the buttons never leave. */}
      <div className="flex items-center gap-2 px-3 py-2 bg-violet-50/70 border-b border-violet-200/50">
        <Sparkles className="w-3.5 h-3.5 text-violet-600 shrink-0" strokeWidth={2} />
        <span className="text-[11px] font-semibold text-violet-700">Suggested change</span>
        <span className="text-[11px] font-mono text-violet-500/80 tabular-nums">
          {stats.unchanged
            ? 'identical to your code'
            : `+${stats.added} −${stats.removed}`}
        </span>
        <div className="flex-1" />
        <button
          onClick={onReject}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-on-surface-variant border border-outline-variant/40 bg-white hover:border-red-300 hover:text-red-600 transition-colors"
        >
          <X className="w-3 h-3" strokeWidth={2.5} />
          Discard
        </button>
        <button
          onClick={onAccept}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-white bg-violet-600 hover:bg-violet-700 transition-colors"
        >
          <Check className="w-3 h-3" strokeWidth={3} />
          Keep
        </button>
      </div>

      {stats.unchanged ? (
        <p className="px-4 py-3 text-[12px] text-on-surface-variant">
          The assistant came back with the code you already have — nothing to change.
        </p>
      ) : (
        <div className="max-h-[420px] overflow-auto font-mono text-[12px] leading-[1.55]">
          {rows.map((row, i) => {
            if ('gap' in row) {
              return (
                <button
                  key={`gap-${i}`}
                  onClick={() => setShowAll(true)}
                  className="w-full text-left px-3 py-1 text-[11px] text-on-surface-variant/60 bg-surface-container-low/40 hover:bg-surface-container-low border-y border-outline-variant/10 transition-colors"
                >
                  ⋯ {row.gap} unchanged {row.gap === 1 ? 'line' : 'lines'}
                </button>
              );
            }
            const { kind, text, oldNumber, newNumber } = row.line;
            const tone =
              kind === 'added' ? 'bg-emerald-50 text-emerald-900'
                : kind === 'removed' ? 'bg-red-50 text-red-900'
                  : 'text-on-surface';
            return (
              <div key={`l-${i}`} className={`flex ${tone}`}>
                {/* Line numbers, old then new — the pair is what tells you
                    whether a line moved or was replaced. */}
                <span className="w-9 shrink-0 px-1 text-right text-on-surface-variant/40 select-none tabular-nums">
                  {oldNumber ?? ''}
                </span>
                <span className="w-9 shrink-0 px-1 text-right text-on-surface-variant/40 select-none tabular-nums border-r border-outline-variant/10">
                  {newNumber ?? ''}
                </span>
                <span
                  className={`w-4 shrink-0 text-center select-none ${
                    kind === 'added' ? 'text-emerald-600' : kind === 'removed' ? 'text-red-500' : 'text-transparent'
                  }`}
                >
                  {kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}
                </span>
                {/* pre-wrap, not overflow-x: a long SQL line hidden off the
                    right edge is a line nobody reviewed. */}
                <span className="flex-1 whitespace-pre-wrap break-words pr-3">{text || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
