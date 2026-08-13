'use client';

import { Check, X, Loader2, AlertTriangle, Info } from 'lucide-react';
import type { Cardinality, Measurement, MeasureVerdict, PendingDraw } from './types';

/**
 * The measurement IS the confirmation dialog.
 *
 * A drawn line does not ask "is this one-to-many?" — nobody reliably knows, and
 * asking pushes a data question onto the person least able to answer it. It
 * shows what the data says and asks only "keep this?".
 *
 * Nothing here blocks. A weak or broken result is reported and the Keep button
 * stays enabled, because a half-synced source looks exactly like low containment
 * and the person drawing may know something the data does not show yet.
 */

export const VERDICT_STYLE: Record<MeasureVerdict, { fg: string; bg: string; border: string; label: string }> = {
  strong:       { fg: '#3f7a5c', bg: '#dbe8e0', border: '#a8c9b6', label: 'This holds' },
  weak:         { fg: '#a06a1c', bg: '#f1e4c8', border: '#dcc48a', label: 'Unconfirmed' },
  broken:       { fg: '#a43a3a', bg: '#f1d7d7', border: '#dda9a9', label: "This doesn't hold" },
  unmeasurable: { fg: '#4a5660', bg: '#e3e6ea', border: '#c8ced4', label: 'Could not check' },
};

const CARDINALITY_TEXT: Record<Cardinality, string> = {
  one_to_one: 'one-to-one',
  one_to_many: 'one-to-many',
  many_to_one: 'many-to-one',
  many_to_many: 'many-to-many',
};

/**
 * One sentence explaining the verdict, in the words a business user would use.
 *
 * Thresholds come from the response rather than being hardcoded here: they live
 * in the detector's environment, and a UI that states a different number from
 * the one the detector applied is lying about which of the two is wrong.
 */
export function explain(m: Measurement): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const n = m.containment?.sampledDistinct ?? 0;
  const values = `${n} ${n === 1 ? 'value' : 'different values'}`;

  switch (m.reason) {
    case 'ok':
      return `Every check passed — ${pct(m.containment?.ratio ?? 0)} of values were found on the other side.`;
    case 'too-few-distinct':
      // A ratio of 0 here is not "not enough evidence", it is evidence: the
      // handful of values there are do not exist on the other side. Saying
      // "it may still be right" over a 0% is the confusing part, so split it.
      if ((m.containment?.ratio ?? 0) === 0) {
        return `This column holds only ${values}, and none of them exist on the other side. `
          + `Either the link is wrong or that table hasn't finished syncing.`;
      }
      return `All matched, but this column holds only ${values} — too few for agreement to `
        + `mean much (we look for at least ${m.thresholds.minDistinct}). It may still be right.`;
    case 'target-not-key':
      return `The other column repeats itself, so it isn't an identifier — `
        + `${m.target?.distinct ?? 0} different values across ${m.target?.rows ?? 0} rows.`;
    case 'low-containment':
      return `Only ${pct(m.containment?.ratio ?? 0)} of values were found on the other side `
        + `(a real link is usually above ${pct(m.thresholds.minContainment)}).`;
    case 'no-values':
      return 'That column is empty, so there is nothing to compare yet.';
    case 'timeout':
      return 'The check took too long to finish. The data may be large, or the source may still be syncing.';
    case 'query-failed':
      return "We couldn't read those columns — the source may not have finished syncing.";
  }
}

/**
 * How much of one column exists in the other, as a bar.
 *
 * A bare "FOUND 0%" in a row of three statistics is a number to decode. A bar
 * with the counts written out is the same fact already read: *2 of 24 values in
 * this column exist in that one*.
 */
export function OverlapBar({ m, targetLabel }: { m: Measurement; targetLabel: string }) {
  if (!m.containment || m.containment.sampledDistinct === 0) return null;
  const { matchedDistinct, sampledDistinct, ratio } = m.containment;
  const v = VERDICT_STYLE[m.verdict];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink2">
          <span className="font-medium tabular-nums text-ink">
            {matchedDistinct.toLocaleString('en-GB')} of {sampledDistinct.toLocaleString('en-GB')}
          </span>{' '}
          values exist in {targetLabel}
        </span>
        <span className="shrink-0 text-[12px] font-medium tabular-nums" style={{ color: v.fg }}>
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-soft">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%`, background: v.fg }}
        />
      </div>
    </div>
  );
}

/**
 * A measurement reduced to the one thing a list can show.
 *
 * Deliberately NOT the four verdicts. In a per-table sweep the question is
 * "which of these do I have to look at?", and the useful split is *how badly*
 * a link misses: values that partly line up are usually a formatting problem
 * worth fixing, values that do not line up at all are usually the wrong column
 * or an unfinished sync. `weak` and `broken` blur that; the ratio does not.
 *
 * `holds` still requires the full verdict, not just a high ratio — a link can
 * match 100% and still fail because the other column is not an identifier.
 */
export type Outcome = 'holds' | 'partial' | 'none' | 'unknown';

export function outcomeOf(m: Measurement | null | undefined): Outcome {
  if (!m || m.verdict === 'unmeasurable' || !m.containment) return 'unknown';
  if (m.verdict === 'strong') return 'holds';
  return m.containment.ratio > 0 ? 'partial' : 'none';
}

export const OUTCOME: Record<Outcome, { color: string; label: string }> = {
  holds:   { color: '#3f7a5c', label: 'hold' },
  partial: { color: '#a06a1c', label: 'partly match' },
  none:    { color: '#a43a3a', label: 'no match' },
  unknown: { color: '#8891a0', label: 'not checked' },
};

/**
 * The rules themselves, each with what was measured and what it had to beat.
 *
 * **There is no AI anywhere in this.** It is three fixed rules, run as SQL
 * against the tenant's own warehouse by `verifyFkCandidate` — the same function,
 * the same thresholds and the same sample the automatic detector uses. Showing
 * only the conclusion made that impossible to tell from the outside, and a
 * verdict you cannot audit is one you have to take on faith, which is exactly
 * what this pane exists not to ask for.
 *
 * All three rows always render, even though the detector short-circuits at the
 * first failure: the single measurement query computes every number regardless,
 * and seeing all three is what makes the verdict checkable rather than
 * announced.
 *
 * The thresholds come from the response, never hardcoded here — they live in
 * the detector's environment, and a panel stating a different number from the
 * one actually applied would be lying about which of the two is wrong.
 */
export function CheckList({ m }: { m: Measurement }) {
  if (!m.containment || !m.target) return null;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  const rules = [
    {
      ok: m.containment.sampledDistinct >= m.thresholds.minDistinct,
      label: 'Enough different values to judge',
      got: m.containment.sampledDistinct.toLocaleString('en-GB'),
      need: `${m.thresholds.minDistinct}+`,
    },
    {
      ok: m.target.isKey,
      label: 'The other column identifies one row',
      got: m.target.rows > 0
        ? `${pct(m.target.distinct / m.target.rows)} unique`
        : 'no rows',
      need: `${pct(m.thresholds.targetUniqueness)}+`,
    },
    {
      ok: m.containment.ratio >= m.thresholds.minContainment,
      label: 'Values found on the other side',
      got: pct(m.containment.ratio),
      need: `${pct(m.thresholds.minContainment)}+`,
    },
  ];

  return (
    <div>
      <ul className="space-y-1">
        {rules.map((r) => (
          <li key={r.label} className="flex items-baseline gap-1.5 text-[11.5px]">
            <span
              className="w-3 shrink-0 text-[11px] leading-none"
              style={{ color: r.ok ? '#3f7a5c' : '#a43a3a' }}
              aria-hidden
            >
              {r.ok ? '✓' : '✗'}
            </span>
            <span className="min-w-0 flex-1 text-ink2">{r.label}</span>
            <span
              className="shrink-0 tabular-nums"
              style={{ color: r.ok ? '#334049' : '#a43a3a' }}
            >
              {r.got}
            </span>
            <span className="w-[52px] shrink-0 text-right tabular-nums text-muted2">
              needs {r.need}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted2">
        Fixed rules, run as SQL against your own data. No AI is involved, and the
        same rules decide what Clarion suggests in the first place.
      </p>
    </div>
  );
}

/**
 * A trusted relationship that the data contradicts.
 *
 * This is the case worth interrupting someone for. A link the source system
 * documents, or one a colleague already confirmed, that now measures at almost
 * nothing is nearly always a sync that has not finished — not a wrong link — and
 * saying so is the difference between a number and a next step.
 */
export function ContradictionFlag({ m, provenance }: {
  m: Measurement;
  provenance: 'human' | 'declared' | 'ai';
}) {
  const trusted = provenance === 'declared' || provenance === 'human';
  if (!trusted || m.verdict !== 'broken') return null;

  return (
    <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-warn/40 bg-warnSoft px-2.5 py-2">
      <AlertTriangle size={12} className="mt-[2px] shrink-0 text-warn" />
      <p className="text-[11.5px] leading-relaxed text-ink2">
        {provenance === 'declared'
          ? 'The source system documents this link, but your data does not back it.'
          : 'Someone confirmed this link, but your data does not back it.'}{' '}
        Most often that means one of these tables has not finished syncing —
        check the source before removing the link.
      </p>
    </div>
  );
}

function ValueList({ title, values, mark }: {
  title: string;
  values: string[];
  mark?: 'found' | 'missing';
}) {
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-[9.5px] uppercase tracking-wider text-muted2">{title}</div>
      <ul className="mt-1 space-y-[3px]">
        {values.map((v, i) => (
          <li key={`${v}-${i}`} className="flex items-center gap-1">
            {mark && (
              <span
                className="shrink-0 text-[10px] leading-none"
                style={{ color: mark === 'found' ? '#3f7a5c' : '#a43a3a' }}
                aria-hidden
              >
                {mark === 'found' ? '✓' : '✗'}
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink2"
              title={v}
            >
              {v === '' ? <span className="text-muted2">(blank)</span> : v}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The values themselves, side by side.
 *
 * This is the part that turns a verdict into an action. `BE 0123.456.789`
 * against `be0123456789` is a formatting difference somebody can fix; a column
 * of GUIDs against a column of three-letter codes is the wrong column entirely.
 * No percentage distinguishes those two, and both look identical as "0%".
 *
 * Unmatched values come first when there are any — they are the ones carrying
 * the information.
 */
export function ValueComparison({ m, fromLabel, toLabel }: {
  m: Measurement;
  fromLabel: string;
  toLabel: string;
}) {
  const ex = m.examples;
  if (!ex || (!ex.matched.length && !ex.unmatched.length && !ex.target.length)) return null;

  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
        What the values look like
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-3">
        <div className="min-w-0 space-y-2">
          {ex.unmatched.length > 0 && (
            <ValueList title={`${fromLabel} — not found`} values={ex.unmatched} mark="missing" />
          )}
          {ex.matched.length > 0 && (
            <ValueList title={`${fromLabel} — found`} values={ex.matched} mark="found" />
          )}
        </div>
        {ex.target.length > 0 && <ValueList title={toLabel} values={ex.target} />}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-[10px] uppercase tracking-wider text-muted2">{label}</div>
      <div className="truncate text-[13px] tabular-nums text-ink">{value}</div>
    </div>
  );
}

export function MeasurePanel({
  draw, saving, onKeep, onDiscard,
}: {
  draw: PendingDraw;
  saving: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const m = draw.measurement;
  const v = VERDICT_STYLE[m?.verdict ?? 'unmeasurable'];

  return (
    <div className="w-[380px] overflow-hidden rounded-xl border border-line bg-raised shadow-xl">
      <div className="border-b border-line/70 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">New relationship</div>
        <div className="mt-1 truncate text-[13px] text-ink">
          {draw.fromLabel} <span className="text-muted2">→</span> {draw.toLabel}
        </div>
      </div>

      {!m && !draw.error && (
        <div className="flex items-center gap-2 px-4 py-5 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" />
          Checking this against your data…
        </div>
      )}

      {draw.error && (
        <div className="flex items-start gap-2 px-4 py-4 text-[13px] text-ink2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
          <span>{draw.error}</span>
        </div>
      )}

      {m && (
        <div className="px-4 py-3">
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
            style={{ color: v.fg, background: v.bg, borderColor: v.border }}
          >
            {m.verdict === 'strong' ? <Check size={11} />
              : m.verdict === 'unmeasurable' ? <Info size={11} />
              : <AlertTriangle size={11} />}
            {v.label}
          </div>

          <p className="mt-2 text-[12.5px] leading-relaxed text-ink2">{explain(m)}</p>

          <div className="mt-3 border-t border-line/60 pt-3">
            <OverlapBar m={m} targetLabel={draw.toLabel} />
          </div>

          <div className="mt-3">
            <CheckList m={m} />
          </div>

          {(m.cardinality || m.orphans) && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              {m.cardinality && (
                <Stat label="Shape" value={CARDINALITY_TEXT[m.cardinality.type]} />
              )}
              {m.orphans && (
                <Stat
                  label="Rows with no match"
                  value={m.orphans.rows.toLocaleString('en-GB')}
                />
              )}
            </div>
          )}

          {m.cardinality && m.cardinality.maxChildren > 1 && (
            <p className="mt-2 text-[11.5px] text-muted">
              On average {m.cardinality.avgChildren.toFixed(1)} rows per match, at most{' '}
              {m.cardinality.maxChildren.toLocaleString('en-GB')}.
            </p>
          )}

          {m.examples && (
            <div className="mt-3 border-t border-line/60 pt-3">
              <ValueComparison m={m} fromLabel={draw.fromLabel} toLabel={draw.toLabel} />
            </div>
          )}

          {m.containment && (
            <p className="mt-3 text-[11px] text-muted2">
              Compared {m.containment.sampledDistinct.toLocaleString('en-GB')} different values;
              row counts are from the whole table.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line/70 bg-surface px-4 py-2.5">
        <button
          type="button"
          onClick={onDiscard}
          disabled={saving}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink2 hover:bg-soft disabled:opacity-50"
        >
          <X size={12} className="mr-1 inline" />
          Discard
        </button>
        <button
          type="button"
          onClick={onKeep}
          disabled={saving || (!m && !draw.error)}
          className="rounded-lg bg-ocean px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-oceanHover disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : <Check size={12} className="mr-1 inline" />}
          Keep it
        </button>
      </div>
    </div>
  );
}
