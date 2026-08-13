'use client';

import { useEffect, useState } from 'react';
import { Check, Trash2, RefreshCw, Loader2, X, Sparkles, Flag, Columns2 } from 'lucide-react';
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
 */
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
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted2 hover:bg-soft hover:text-ink" aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ color: prov.color, background: prov.bg }}
        >
          {prov.label}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{prov.hint}</p>

        {/* A flag is a standing statement about this link, so it sits at the
            top with the other things that describe what it IS — not down with
            the buttons, where it would read as one more action to take. */}
        {relationship.flagged && (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warnSoft px-2.5 py-2">
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

        <div className="mt-4">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">Shape</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            Clarion measures this, but you can correct it — you may know something
            the data does not show yet.
          </p>
          <div className="mt-1.5 grid grid-cols-2 gap-1">
            {(Object.keys(CARDINALITY_TEXT) as string[]).map((k) => (
              <button
                key={k}
                type="button"
                disabled={busy !== null}
                onClick={() => onChangeType(k)}
                className={`rounded-lg border px-2 py-1 text-[11.5px] transition-colors disabled:opacity-50 ${
                  relationship.relationshipType === k
                    ? 'border-ocean bg-ocean text-white'
                    : 'border-line bg-surface text-ink2 hover:bg-soft'
                }`}
              >
                {CARDINALITY_TEXT[k]}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
            Matched on
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            If Clarion picked the wrong columns, change them here.
          </p>
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
          </div>
        </div>

        <div className="mt-4 border-t border-line/60 pt-3">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">
              Checked against your data
            </div>
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
          </div>

          {!m && busy !== 'measure' && (
            <p className="mt-1.5 text-[11.5px] text-muted">Not checked yet.</p>
          )}

          {/* Reading the two columns is its own act, available whether or not a
              measurement exists — you often want the values BECAUSE the number
              is surprising, and sometimes before there is a number at all. */}
          {relationship.fromColumnId != null && relationship.toColumnId != null && (
            <button
              type="button"
              onClick={onCompareValues}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink2 hover:bg-soft"
            >
              <Columns2 size={11} />
              Compare the values side by side
            </button>
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
                <CheckList m={m} />
              </div>

              {(m.cardinality || m.orphans) && (
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  {m.cardinality && (
                    <div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted2">Shape</div>
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
            </>
          )}
        </div>

        <div className="mt-4 border-t border-line/60 pt-3">
          <label className="font-mono text-[10px] uppercase tracking-wider text-muted2" htmlFor="rel-desc">
            What this means
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            <Sparkles size={10} className="mr-1 inline" />
            Clarion reads this when answering questions. A sentence in your own words
            helps more than anything else here.
          </p>
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
