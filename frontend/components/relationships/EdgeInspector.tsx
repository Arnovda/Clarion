'use client';

import { useEffect, useState } from 'react';
import {
  Check, Trash2, RefreshCw, Loader2, X, Sparkles, Flag, Columns2, HelpCircle,
} from 'lucide-react';
import type { GraphColumn, GraphRelationship, Measurement, Provenance } from './types';
import {
  explain, OverlapBar, ValueComparison, CheckList, ContradictionFlag, VERDICT_STYLE,
} from './MeasurePanel';

const PROVENANCE_META: Record<Provenance, { label: string; hint: string; color: string; bg: string }> = {
  human: {
    label: 'Confirmed by you',
    hint: 'Someone on your team checked this. It survives every re-analysis.',
    color: '#164e63', bg: '#e8f0f3',
  },
  declared: {
    label: 'From the source',
    hint: "This comes from the system's own documentation, so it is reliable.",
    color: '#4a5660', bg: '#e3e6ea',
  },
  ai: {
    label: 'Suggested by Clarion',
    hint: 'Clarion worked this out from your data. Confirm it or remove it.',
    color: '#c08a5e', bg: '#f1e4d6',
  },
};

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

/** A section heading with an optional `?` and an optional right-hand action. */
function SectionHead({ label, hint, children }: {
  label: string; hint?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">{label}</div>
      {hint && <Hint text={hint} />}
      {children && <div className="ml-auto">{children}</div>}
    </div>
  );
}

function ColumnPicker({ label, value, options, disabled, onChange }: {
  label: string;
  value: number | null;
  options: GraphColumn[];
  disabled: boolean;
  onChange: (id: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-[38%] shrink-0 truncate text-[11.5px] text-muted" title={label}>{label}</span>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-ocean disabled:opacity-50"
      >
        {value == null && <option value="">— pick a column —</option>}
        {options.map((c) => (
          <option key={c.id} value={c.id}>{c.column_name}</option>
        ))}
      </select>
    </label>
  );
}

export function EdgeInspector({
  relationship, fromLabel, toLabel, fromColumns, toColumns, busy,
  onConfirm, onDelete, onRemeasure, onSaveDescription, onChangeType, onChangeColumns,
  onFlag, onCompareValues, onClose,
}: {
  relationship: GraphRelationship;
  fromLabel: string;
  toLabel: string;
  fromColumns: GraphColumn[];
  toColumns: GraphColumn[];
  busy: 'confirm' | 'delete' | 'measure' | 'save' | 'flag' | null;
  onConfirm: () => void;
  onDelete: () => void;
  onRemeasure: () => void;
  onSaveDescription: (text: string) => void;
  onChangeType: (type: string) => void;
  onChangeColumns: (change: { from?: number; to?: number }) => void;
  onFlag: (flagged: boolean, reason: string) => void;
  onCompareValues: () => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(relationship.description ?? '');
  const [reason, setReason] = useState(relationship.flaggedReason ?? '');
  useEffect(() => { setReason(relationship.flaggedReason ?? ''); }, [relationship.id, relationship.flaggedReason]);
  useEffect(() => { setDescription(relationship.description ?? ''); }, [relationship.id, relationship.description]);

  const prov = PROVENANCE_META[relationship.provenance];
  const m = relationship.measured as Measurement | null;
  const verdict = VERDICT_STYLE[m?.verdict ?? 'unmeasurable'];
  const dirty = description.trim() !== (relationship.description ?? '').trim();

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
          {/* Who asserted this is a one-word fact, so it rides on the title
              line as a chip. It used to open the panel as a chip plus a full
              sentence of explanation, which put the measurement — the thing
              you came for — below the fold. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ color: prov.color, background: prov.bg }}
            >
              {prov.label}
            </span>
            <Hint text={prov.hint} />
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

        <div>
          <SectionHead
            label="Checked against your data"
            hint="Three fixed SQL rules run against the warehouse. No AI is involved — the same rules Clarion uses when it detects relationships in the first place."
          >
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
          </SectionHead>

          {!m && busy !== 'measure' && (
            <p className="mt-1.5 text-[11.5px] text-muted">Not checked yet.</p>
          )}

          {m && (
            <>
              {/* Verdict first, in words. The old block led with "FOUND 0%"
                  above a sentence saying "it may still be right", which reads
                  as a contradiction — the headline has to be the conclusion. */}
              <div
                className="mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                style={{ color: verdict.fg, background: verdict.bg, borderColor: verdict.border }}
              >
                {verdict.label}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink2">{explain(m)}</p>

              <ContradictionFlag m={m} provenance={relationship.provenance} />

              <div className="mt-2.5">
                <OverlapBar m={m} targetLabel={toLabel} />
              </div>

              <div className="mt-2.5">
                <CheckList m={m} fromLabel={fromLabel} toLabel={toLabel} />
              </div>

              {(m.cardinality || m.orphans) && (
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  {m.cardinality && (
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
                        Measured shape
                      </div>
                      <div className="text-[13px] text-ink">{CARDINALITY_TEXT[m.cardinality.type]}</div>
                    </div>
                  )}
                  {m.orphans && (
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
                        Rows with no match
                      </div>
                      <div className="text-[13px] tabular-nums text-ink">
                        {m.orphans.rows.toLocaleString('en-GB')}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {m.examples && (
                <div className="mt-3">
                  <ValueComparison m={m} fromLabel={fromLabel} toLabel={toLabel} />
                </div>
              )}

              {/* The two numbers above are measured over DIFFERENT populations:
                  the percentage is distinct values from a bounded sample, the
                  row count is the whole table. Presenting them side by side
                  without saying so is how a reader ends up dividing one by the
                  other — the same mistake the detector itself made in 2026-08. */}
              {m.containment && (
                <p className="mt-2 text-[10.5px] leading-relaxed text-muted2">
                  Compared {m.containment.sampledDistinct.toLocaleString('en-GB')} different
                  values{m.containment.sampledDistinct >= m.thresholds.sampleSize
                    && ` (a sample of the column)`}; row counts are from the whole table.
                </p>
              )}
            </>
          )}

          {/* Reading the two columns is its own act, available whether or not a
              measurement exists — you often want the values BECAUSE the number
              is surprising, and sometimes before there is a number at all. It
              closes the section rather than opening it: a button offering to
              go deeper reads as noise above the answer it is deepening. */}
          {relationship.fromColumnId != null && relationship.toColumnId != null && (
            <button
              type="button"
              onClick={onCompareValues}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink2 hover:bg-soft"
            >
              <Columns2 size={11} />
              Compare the values side by side
            </button>
          )}
        </div>

        {/* Corrections come after the evidence, because the evidence is what
            tells you whether a correction is called for. */}
        <div className="mt-4 border-t border-line/60 pt-3">
          <SectionHead
            label="Matched on"
            hint="These are the two columns Clarion compares. If it picked the wrong ones, change them here — the check re-runs against the columns you choose."
          />
          <div className="mt-1.5 space-y-1.5">
            <ColumnPicker
              label={fromLabel.split('.')[0]}
              value={relationship.fromColumnId}
              options={fromColumns}
              disabled={busy !== null}
              onChange={(id) => onChangeColumns({ from: id })}
            />
            <ColumnPicker
              label={toLabel.split('.')[0]}
              value={relationship.toColumnId}
              options={toColumns}
              disabled={busy !== null}
              onChange={(id) => onChangeColumns({ to: id })}
            />
            {/* A dropdown, not four buttons. The shape is a stored value that
                is almost always already right — four always-visible options
                gave a settled field the weight of a decision. */}
            <label className="flex items-center gap-2">
              <span className="w-[38%] shrink-0 truncate text-[11.5px] text-muted">Shape</span>
              <select
                value={relationship.relationshipType ?? ''}
                disabled={busy !== null}
                onChange={(e) => onChangeType(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-ocean disabled:opacity-50"
              >
                {!relationship.relationshipType && <option value="">— not set —</option>}
                {Object.keys(CARDINALITY_TEXT).map((k) => (
                  <option key={k} value={k}>{CARDINALITY_TEXT[k]}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-4 border-t border-line/60 pt-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="font-mono text-[10px] uppercase tracking-wider text-muted2" htmlFor="rel-desc">
              What this means
            </label>
            <Hint text="Clarion reads this when answering questions. A sentence in your own words helps more than anything else here." />
            <Sparkles size={10} className="text-muted2" />
          </div>
          <textarea
            id="rel-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="e.g. Every invoice line belongs to one invoice."
            className="mt-2 w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted2 focus:border-ocean"
          />
          {dirty && (
            <button
              type="button"
              onClick={() => onSaveDescription(description)}
              disabled={busy !== null}
              className="mt-1.5 rounded-lg bg-ocean px-2.5 py-1 text-[12px] font-medium text-white hover:bg-oceanHover disabled:opacity-50"
            >
              {busy === 'save' ? <Loader2 size={11} className="mr-1 inline animate-spin" /> : null}
              Save
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
