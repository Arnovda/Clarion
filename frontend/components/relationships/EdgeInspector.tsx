'use client';

import { useEffect, useState } from 'react';
import {
  Check, Trash2, RefreshCw, Loader2, X, Flag, Columns2, HelpCircle, UserCheck,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import type { GraphRelationship, Measurement } from './types';
import { laidBy, originOf, TIER_STYLE } from './provenance';
import {
  explain, ValueComparison, CheckList, ContradictionFlag,
  checkAssertion, shortFinding, outcomeOf, OUTCOME,
} from './MeasurePanel';

const CARDINALITY_TEXT: Record<string, string> = {
  one_to_one: 'one-to-one',
  one_to_many: 'one-to-many',
  many_to_one: 'many-to-one',
  many_to_many: 'many-to-many',
};

/**
 * Everything you can do to one relationship.
 *
 * Confirming and removing are the two actions that make this a review tool
 * rather than a picture, and both are one click with a keyboard equivalent —
 * this is repetitive work and the hand should not have to leave the keys.
 *
 * The description is editable here because it is **what the AI reads**. A
 * relationship's description is the sentence that ends up in the NL-to-SQL
 * prompt, so this field is the most direct way a person can teach Clarion
 * something it could not infer.
 *
 * **ORDER IS THE DESIGN.** The evidence comes first, because the question this
 * panel exists to answer is "does this relationship hold?" — and everything
 * else is either how to correct it or how to describe it. An earlier version
 * opened with the shape picker and the column pickers, so the measurement (the
 * only thing that could tell you whether the shape and columns were even worth
 * correcting) sat below the fold behind four explanatory paragraphs.
 */

/**
 * Explanations are worth having and worth hiding. Each one is true and each one
 * is read exactly once; left on screen they are the difference between a panel
 * you scan and a panel you read.
 */
function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded p-0.5 transition-colors ${open ? 'text-ocean' : 'text-muted2 hover:text-ink2'}`}
        aria-label={open ? 'Hide explanation' : 'What is this?'}
        aria-expanded={open}
      >
        <HelpCircle size={12} />
      </button>
      {open && <p className="mt-1 basis-full text-[11.5px] leading-relaxed text-muted">{text}</p>}
    </>
  );
}

/**
 * A closed drawer. Everything true but not decision-changing lives in one.
 *
 * `onOpen` fires the first time it is opened — used so "Check it against your
 * data" measures on the way in rather than making somebody open a drawer and
 * then find a button inside it.
 */
function Fold({ label, children, onOpen }: {
  label: string;
  children: React.ReactNode;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => { if (!open) onOpen?.(); setOpen((v) => !v); }}
        className="flex w-full items-center gap-1 py-1 text-left text-[12px] text-ocean hover:underline"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {open && children}
    </div>
  );
}

export function EdgeInspector({
  relationship, fromLabel, toLabel, busy,
  onConfirm, onDelete, onRemeasure, onFlag, onCompareValues, onClose,
}: {
  relationship: GraphRelationship;
  fromLabel: string;
  toLabel: string;
  busy: 'confirm' | 'delete' | 'measure' | 'save' | 'flag' | null;
  onConfirm: () => void;
  onDelete: () => void;
  onRemeasure: () => void;
  onFlag: (flagged: boolean, reason: string) => void;
  onCompareValues: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(relationship.flaggedReason ?? '');
  useEffect(() => { setReason(relationship.flaggedReason ?? ''); }, [relationship.id, relationship.flaggedReason]);

  const origin = originOf(relationship.provenance, relationship.semanticSource);
  const tier = TIER_STYLE[origin.tier];
  const m = relationship.measured as Measurement | null;
  // The binding constraint, in the words the list uses. One vocabulary across
  // both panes is what makes a row and its panel obviously the same thing.
  // WHO LAID THE LINE decides what the measurement MEANS, so it is read before
  // the measurement is rendered rather than mentioned beside it.
  const laid = laidBy(relationship);
  const finding = shortFinding(m, toLabel, laid);
  const outcome = OUTCOME[outcomeOf(m, laid)];

  return (
    <aside className="flex h-full w-[340px] flex-col border-l border-line bg-raised">
      <div className="flex items-start gap-2 border-b border-line/70 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
            {relationship.kind === 'match' ? 'Match' : 'Relationship'}
            {relationship.isCrossSource && ' · across sources'}
          </div>
          <div className="mt-1 break-words text-[13px] leading-snug text-ink">
            {fromLabel} <span className="text-muted2">→</span> {toLabel}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted2 hover:bg-soft hover:text-ink" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* A flag is a standing statement about this link, so it sits at the
            top with the other things that describe what it IS — not down with
            the buttons, where it would read as one more action to take. */}
        {relationship.flagged && (
          <div className="mb-4 rounded-lg border border-warn/40 bg-warnSoft px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink">
              <Flag size={11} className="text-warn" />
              Flagged as a problem
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink2">
              Clarion has stopped using this link when answering questions.
            </p>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => {
                if (reason.trim() !== (relationship.flaggedReason ?? '')) onFlag(true, reason);
              }}
              placeholder="Why? e.g. waiting on a full re-sync"
              className="mt-1.5 w-full rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-muted2 focus:border-ocean"
            />
            <button
              type="button"
              onClick={() => onFlag(false, '')}
              disabled={busy !== null}
              className="mt-1.5 text-[11.5px] text-ocean hover:underline disabled:opacity-50"
            >
              Resolved — remove the flag
            </button>
          </div>
        )}

        {/* ── THE ONE SECOND ────────────────────────────────────────────
            Verdict, overlap, who. Nothing else is above the fold, because
            nothing else changes the decision. The three-rule checklist, the
            sampling caveat, the shape and the orphan count are all true and all
            an audit trail — they belong one click away, not in front of someone
            who has thirty of these to get through. */}
        <div className="rounded-xl px-3 py-2.5" style={{ background: outcome.bg }}>
          <div className="flex items-start gap-2.5">
            <span
              className="text-[22px] font-bold leading-none"
              style={{ color: outcome.color, marginTop: '-1px' }}
              aria-hidden
            >
              {outcome.glyph}
            </span>
            <div className="min-w-0">
              <div className="font-serif text-[16px] font-semibold leading-tight" style={{ color: outcome.color }}>
                {m ? outcome.head : 'Not checked yet'}
              </div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink2">
                {m
                  ? (finding?.detail ?? explain(m))
                  : 'Nobody has measured this against your data.'}
              </p>
            </div>
          </div>
        </div>

        {m?.containment && (
          <div className="mt-2.5">
            <div className="flex items-baseline justify-between text-[11.5px] text-muted">
              <span>values found on the other side</span>
              <span className="font-medium tabular-nums" style={{ color: outcome.color }}>
                {Math.round(m.containment.ratio * 100)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-soft">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(m.containment.ratio * 100, m.containment.ratio > 0 ? 2 : 0)}%`,
                  background: outcome.color,
                }}
              />
            </div>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ color: tier.fg, background: tier.bg }}
          >
            {origin.label}
          </span>
          {origin.confirmed && origin.recorded && (
            <span className="inline-flex items-center gap-1 text-[11px] text-ocean">
              <UserCheck size={11} /> confirmed
            </span>
          )}
          <Hint text={origin.hint} />
        </div>

        {m && (
          <ContradictionFlag
            m={m}
            provenance={relationship.provenance}
            semanticSource={relationship.semanticSource}
            laid={laid}
          />
        )}

        {/* Everything below is one click away and nothing above needs it. */}
        <div className="mt-3 space-y-0.5 border-t border-line/60 pt-2">
          <Fold
            label={m ? 'How this was checked' : 'Check it against your data'}
            onOpen={m ? undefined : onRemeasure}
          >
            <div className="pb-1 pt-1">
              <div className="mb-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onRemeasure}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ocean hover:bg-oceanSofter disabled:opacity-50"
                >
                  {busy === 'measure'
                    ? <Loader2 size={11} className="animate-spin" />
                    : <RefreshCw size={11} />}
                  {m ? 'Check again' : 'Check now'}
                </button>
                <Hint text={checkAssertion(fromLabel, toLabel)} />
              </div>
              {m && <CheckList m={m} fromLabel={fromLabel} toLabel={toLabel} prose={false} />}
              {m && (
                <p className="mt-2 text-[10.5px] leading-relaxed text-muted2">
                  {m.cardinality && <>Measured {CARDINALITY_TEXT[m.cardinality.type]}. </>}
                  {m.orphans && m.orphans.rows > 0 && (
                    <>
                      <span className="tabular-nums">{m.orphans.rows.toLocaleString('en-GB')}</span>
                      {' '}rows have no match.{' '}
                    </>
                  )}
                  {m.containment && (
                    <>
                      Compared {m.containment.sampledDistinct.toLocaleString('en-GB')} different
                      values{m.containment.sampledDistinct >= m.thresholds.sampleSize
                        && ' (a sample of the column)'}; row counts are from the whole table.
                    </>
                  )}
                </p>
              )}
              {m?.examples && (
                <div className="mt-3">
                  <ValueComparison m={m} fromLabel={fromLabel} toLabel={toLabel} />
                </div>
              )}
            </div>
          </Fold>

          {relationship.fromColumnId != null && relationship.toColumnId != null && (
            <button
              type="button"
              onClick={onCompareValues}
              className="flex w-full items-center gap-1.5 py-1 text-left text-[12px] text-ocean hover:underline"
            >
              <Columns2 size={12} />
              Compare the values side by side
            </button>
          )}

        </div>

      </div>

      <div className="flex items-center gap-2 border-t border-line/70 bg-surface px-4 py-3">
        <button
          type="button"
          onClick={onDelete}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-err hover:bg-errSoft disabled:opacity-50"
          title="Remove (N)"
        >
          {busy === 'delete' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          Remove
        </button>
        {/* Flagging is the answer to "this is wrong but I am not deleting it",
            which is the common case for a link the source documents and the
            data contradicts. Without it the only options were to assert
            something false or to throw away something probably real. */}
        {!relationship.flagged && (
          <button
            type="button"
            onClick={() => onFlag(true, '')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-ink2 hover:bg-soft disabled:opacity-50"
            title="Mark as a problem to come back to"
          >
            {busy === 'flag' ? <Loader2 size={12} className="animate-spin" /> : <Flag size={12} />}
            Flag
          </button>
        )}
        {relationship.provenance !== 'human' && (
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy !== null}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-ocean px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-oceanHover disabled:opacity-50"
            title="Confirm (Y)"
          >
            {busy === 'confirm' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Looks right
          </button>
        )}
      </div>
    </aside>
  );
}
