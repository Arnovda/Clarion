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

const VERDICT_STYLE: Record<MeasureVerdict, { fg: string; bg: string; border: string; label: string }> = {
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
  switch (m.reason) {
    case 'ok':
      return `Every check passed — ${pct(m.containment?.ratio ?? 0)} of values were found in the target.`;
    case 'too-few-distinct':
      return `Only ${m.containment?.sampledDistinct ?? 0} different values to compare (we need at least `
        + `${m.thresholds.minDistinct} before agreement means anything). It may still be right.`;
    case 'target-not-key':
      return `The target column repeats itself, so it isn't a key — `
        + `${m.target?.distinct ?? 0} different values across ${m.target?.rows ?? 0} rows.`;
    case 'low-containment':
      return `Only ${pct(m.containment?.ratio ?? 0)} of values were found in the target `
        + `(we'd expect at least ${pct(m.thresholds.minContainment)} for a real link).`;
    case 'no-values':
      return 'That column is empty, so there is nothing to compare yet.';
    case 'timeout':
      return 'The check took too long to finish. The data may be large, or the source may still be syncing.';
    case 'query-failed':
      return "We couldn't read those columns — the source may not have finished syncing.";
  }
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

          {(m.containment || m.cardinality || m.orphans) && (
            <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line/60 pt-3">
              {m.containment && (
                <Stat label="Found" value={`${Math.round(m.containment.ratio * 100)}%`} />
              )}
              {m.cardinality && (
                <Stat label="Shape" value={CARDINALITY_TEXT[m.cardinality.type]} />
              )}
              {m.orphans && (
                <Stat label="Unmatched" value={m.orphans.rows.toLocaleString('en-GB')} />
              )}
            </div>
          )}

          {m.cardinality && m.cardinality.maxChildren > 1 && (
            <p className="mt-2 text-[11.5px] text-muted">
              On average {m.cardinality.avgChildren.toFixed(1)} rows per match, at most{' '}
              {m.cardinality.maxChildren.toLocaleString('en-GB')}.
            </p>
          )}

          {m.containment && (
            <p className="mt-2 text-[11px] text-muted2">
              Checked {m.containment.sampledDistinct.toLocaleString('en-GB')} different values;
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
