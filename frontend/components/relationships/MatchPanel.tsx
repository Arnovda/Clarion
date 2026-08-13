'use client';

import { Check, X, Loader2, AlertTriangle, Users } from 'lucide-react';
import type { MatchMeasurement, PendingMatch } from './types';

/**
 * What a link BETWEEN two sources means, and whether it works.
 *
 * A join panel asks "does this hold?". A match panel asks a different question:
 * "are these the same things?" — and the honest answer is a rate plus the rows
 * that found nobody. There is no cardinality here, because there is no key: two
 * systems describing the same 900 customers is 900 separate per-row facts, not
 * one structural rule.
 *
 * The unmatched samples do most of the work. A rate of 68% tells you there is a
 * gap; seeing that every miss reads `BE 0123.456.789` while the other side
 * writes `BE0123456789` tells you it is a formatting problem you can fix, not a
 * data problem you have to live with.
 */

function pct(n: number) { return `${Math.round(n * 100)}%`; }

function Side({ title, total, matched, sample }: {
  title: string; total: number; matched: number; sample: string[];
}) {
  const missing = total - matched;
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-[10px] uppercase tracking-wider text-muted2">{title}</div>
      <div className="mt-0.5 text-[13px] tabular-nums text-ink">
        {matched.toLocaleString('en-GB')} of {total.toLocaleString('en-GB')} matched
      </div>
      {missing > 0 && sample.length > 0 && (
        <>
          <div className="mt-1.5 text-[11px] text-muted">
            {missing.toLocaleString('en-GB')} found no partner, for example:
          </div>
          <ul className="mt-1 space-y-0.5">
            {sample.slice(0, 5).map((v) => (
              <li key={v} className="truncate rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink2">
                {v}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function MatchPanel({
  match, saving, onKeep, onDiscard, onToggleNormalisation,
}: {
  match: PendingMatch;
  saving: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onToggleNormalisation: () => void;
}) {
  const m = match.measurement;

  return (
    <div className="w-[400px] overflow-hidden rounded-xl border border-line bg-raised shadow-xl">
      <div className="border-b border-line/70 px-4 py-3">
        <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted2">
          <Users size={11} /> Across sources
        </div>
        <div className="mt-1 truncate text-[13px] text-ink">
          {match.fromLabel} <span className="text-muted2">↔</span> {match.toLabel}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
          This says the two sides describe the <em>same things</em> — not that one points at
          the other. Clarion checks how many actually line up.
        </p>
      </div>

      {!m && !match.error && (
        <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" />
          Comparing the two sources…
        </div>
      )}

      {match.error && (
        <div className="flex items-start gap-2 px-4 py-4 text-[13px] text-ink2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
          <span>{match.error}</span>
        </div>
      )}

      {m && m.ok && (
        <div className="px-4 py-3">
          <div className="flex items-baseline gap-2">
            <div className="font-serif text-[26px] leading-none text-ink tabular-nums">
              {m.matchRate != null ? pct(m.matchRate) : '—'}
            </div>
            <div className="text-[12px] text-muted">of the left side found a partner</div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-4 border-t border-line/60 pt-3">
            {m.left && (
              <Side title={match.fromLabel} total={m.left.total} matched={m.left.matched} sample={m.left.unmatchedSample} />
            )}
            {m.right && (
              <Side title={match.toLabel} total={m.right.total} matched={m.right.matched} sample={m.right.unmatchedSample} />
            )}
          </div>

          <button
            type="button"
            onClick={onToggleNormalisation}
            className="mt-3 text-[11.5px] text-ocean hover:underline"
          >
            {m.normalisation === 'loose'
              ? 'Ignoring spacing, punctuation and case — compare exactly instead'
              : 'Comparing exactly — ignore spacing, punctuation and case instead'}
          </button>
        </div>
      )}

      {m && !m.ok && (
        <div className="flex items-start gap-2 px-4 py-4 text-[13px] text-ink2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
          <span>
            {m.reason === 'table-not-found'
              ? "One of these tables hasn't been synced into the warehouse yet."
              : m.reason === 'timeout'
                ? 'The comparison took too long to finish. These tables may be very large.'
                : "We couldn't compare those columns."}
          </span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line/70 bg-surface px-4 py-2.5">
        <button
          type="button" onClick={onDiscard} disabled={saving}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink2 hover:bg-soft disabled:opacity-50"
        >
          <X size={12} className="mr-1 inline" /> Discard
        </button>
        <button
          type="button" onClick={onKeep} disabled={saving || (!m && !match.error)}
          className="rounded-lg bg-ocean px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-oceanHover disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : <Check size={12} className="mr-1 inline" />}
          Keep it
        </button>
      </div>
    </div>
  );
}

export type { MatchMeasurement };
