'use client';

/**
 * <ReviewQueueView> — guides the user through AI-drafted relationships one
 * at a time. Big card with both columns' descriptions and sample values,
 * three primary actions (Confirm / Reject / Edit), and a progress counter.
 *
 * The aim is to make reviewing 11 drafts in a wide schema feel like a
 * focused decision flow rather than a giant list to triage.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Check, X, Pencil, ArrowRight, ArrowLeft, ArrowRight as ArrowFwd,
  Sparkles, PartyPopper, ShieldCheck, Zap, Loader2,
} from 'lucide-react';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import {
  patchRelationship, deleteRelationship,
  type RelationshipRow,
} from './useSchema';
import EditRelationshipDialog from './EditRelationshipDialog';
import { cn } from '@/lib/cn';

interface Props {
  tables:         SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  relationships:  RelationshipRow[];
  onChanged:      () => void;
  /** When the queue is empty, offer to jump to the list view. */
  onSwitchToList: () => void;
}

export default function ReviewQueueView({
  tables, columnsByTable, relationships, onChanged, onSwitchToList,
}: Props) {
  const drafts = useMemo(
    () => relationships.filter((r) => r.ai_draft),
    [relationships],
  );
  const strongMatchCount = useMemo(
    () => drafts.filter(isStrongMatch).length,
    [drafts],
  );
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<RelationshipRow | null>(null);
  const [bulkBusy, setBulkBusy] = useState<null | 'strong' | 'all'>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  // Clamp index when the underlying list shrinks (e.g. after a confirm/reject).
  useEffect(() => {
    if (drafts.length === 0) return;
    if (index >= drafts.length) setIndex(Math.max(0, drafts.length - 1));
  }, [drafts.length, index]);

  // Keyboard shortcuts: Y/Enter = confirm, N = reject, → = next, ← = prev, E = edit
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (editing) return;                               // dialog is open; let it handle keys
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (drafts.length === 0) return;
      const r = drafts[index];
      if (!r) return;

      if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') { e.preventDefault(); doConfirm(r); }
      else if (e.key === 'n' || e.key === 'N')                  { e.preventDefault(); doReject(r); }
      else if (e.key === 'e' || e.key === 'E')                  { e.preventDefault(); setEditing(r); }
      else if (e.key === 'ArrowRight')                          { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft')                           { e.preventDefault(); prev(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, index, editing]);

  if (drafts.length === 0) {
    const confirmedCount = relationships.length;
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-5">
        <div className="w-16 h-16 rounded-full bg-ok-soft flex items-center justify-center text-ok">
          <PartyPopper className="w-7 h-7" strokeWidth={1.5} />
        </div>
        <div>
          <p className="font-display text-[20px] text-ink tracking-[-0.01em]">All drafts reviewed</p>
          <p className="text-[12.5px] text-muted mt-1.5 max-w-md">
            {confirmedCount > 0
              ? `${confirmedCount} relationship${confirmedCount === 1 ? '' : 's'} confirmed for this connection. New drafts will appear here whenever profiling runs again.`
              : 'No AI-drafted relationships are waiting for review. New drafts appear here whenever profiling runs.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <button
            onClick={onSwitchToList}
            className="inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-[0.06em] text-ocean bg-ocean-softer border border-ocean-soft rounded-md px-3 py-2 hover:bg-ocean hover:text-white transition"
          >
            View all relationships
            <ArrowFwd className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
    );
  }

  const r = drafts[index];
  const fromTable = tables.find((t) => t.id === r.from_table_id);
  const toTable   = tables.find((t) => t.id === r.to_table_id);
  const fromCol   = r.from_column_id ? columnsByTable[r.from_table_id]?.find((c) => c.id === r.from_column_id) : undefined;
  const toCol     = r.to_column_id   ? columnsByTable[r.to_table_id  ]?.find((c) => c.id === r.to_column_id)   : undefined;

  function next() { setIndex((i) => Math.min(drafts.length - 1, i + 1)); }
  function prev() { setIndex((i) => Math.max(0, i - 1)); }

  async function doConfirm(rel: RelationshipRow) {
    if (busy) return;
    setBusy(true);
    try {
      await patchRelationship(rel.id);
      await onChanged();
      // Index will auto-clamp via effect; stays on same position which is now the next draft.
    } finally {
      setBusy(false);
    }
  }

  async function doReject(rel: RelationshipRow) {
    if (busy) return;
    if (!confirm(`Reject this AI suggestion?\n\n${rel.from_table}.${rel.from_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}\n\nThis deletes the relationship. You can always add it back later.`)) return;
    setBusy(true);
    try {
      await deleteRelationship(rel.id);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function bulkConfirm(targetDrafts: RelationshipRow[], kind: 'strong' | 'all') {
    if (bulkBusy || busy) return;
    if (targetDrafts.length === 0) return;
    setBulkBusy(kind);
    setBulkProgress({ done: 0, total: targetDrafts.length });
    try {
      // Sequential, not parallel — server-side serialisation is friendlier
      // and we update progress per item.
      for (let i = 0; i < targetDrafts.length; i++) {
        try {
          await patchRelationship(targetDrafts[i].id);
        } catch (e) {
          // Don't fail the whole batch on a single error; log and continue.
          console.warn('bulk confirm: patch failed', targetDrafts[i].id, e);
        }
        setBulkProgress({ done: i + 1, total: targetDrafts.length });
      }
      await onChanged();
    } finally {
      setBulkBusy(null);
      setBulkProgress(null);
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
        <div className="max-w-3xl mx-auto">
          {/* Bulk confirm bar — shown only while drafts remain. */}
          {(strongMatchCount > 0 || drafts.length > 1) && (
            <div className="mb-4 bg-raised border border-line rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
              <span className="text-[11.5px] text-ink-2">
                {strongMatchCount > 0 ? (
                  <>
                    <span className="font-mono text-ok">{strongMatchCount}</span> of {drafts.length}{' '}
                    look like a sure thing — column names match.
                  </>
                ) : (
                  <>None of these match by name. Each needs a quick read.</>
                )}
              </span>

              <div className="ml-auto flex items-center gap-2">
                {strongMatchCount > 0 && (
                  <button
                    onClick={() => bulkConfirm(drafts.filter(isStrongMatch), 'strong')}
                    disabled={bulkBusy !== null || busy}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-mono uppercase tracking-[0.06em] text-ok bg-ok-soft border border-line rounded-md hover:bg-ok hover:text-white transition disabled:opacity-50"
                  >
                    {bulkBusy === 'strong' ? (
                      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2.5} />
                    ) : (
                      <ShieldCheck className="w-3 h-3" strokeWidth={2.5} />
                    )}
                    Confirm {strongMatchCount} strong {strongMatchCount === 1 ? 'match' : 'matches'}
                  </button>
                )}
                {drafts.length > 1 && (
                  <button
                    onClick={() => {
                      const n = drafts.length;
                      if (!confirm(`Confirm all ${n} AI drafts?\n\nThis marks every draft as confirmed. You can still edit or delete any individually afterwards.`)) return;
                      bulkConfirm(drafts, 'all');
                    }}
                    disabled={bulkBusy !== null || busy}
                    title="Confirm every remaining AI draft at once"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-mono uppercase tracking-[0.06em] text-ink-2 border border-line rounded-md hover:bg-softer transition disabled:opacity-50"
                  >
                    {bulkBusy === 'all' ? (
                      <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2.5} />
                    ) : (
                      <Zap className="w-3 h-3" strokeWidth={2.5} />
                    )}
                    Confirm all {drafts.length}
                  </button>
                )}
              </div>

              {bulkProgress && (
                <div className="basis-full">
                  <div className="h-1 bg-softer rounded-full overflow-hidden mt-1">
                    <div
                      className="h-full bg-ok transition-all"
                      style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-[10.5px] font-mono text-muted mt-1">
                    Confirming {bulkProgress.done} of {bulkProgress.total}…
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Progress */}
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-muted">
              Review {index + 1} of {drafts.length}
            </span>
            <div className="flex-1 h-1 bg-softer rounded-full overflow-hidden">
              <div
                className="h-full bg-ocean transition-all"
                style={{ width: `${((index + 1) / drafts.length) * 100}%` }}
              />
            </div>
            <button
              onClick={prev}
              disabled={index === 0}
              className="inline-flex items-center justify-center w-7 h-7 text-muted hover:text-ink disabled:opacity-40 hover:bg-softer rounded transition"
              title="Previous (←)"
            >
              <ArrowLeft className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
            <button
              onClick={next}
              disabled={index >= drafts.length - 1}
              className="inline-flex items-center justify-center w-7 h-7 text-muted hover:text-ink disabled:opacity-40 hover:bg-softer rounded transition"
              title="Next (→)"
            >
              <ArrowFwd className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          </div>

          {/* Card */}
          <div className="bg-raised border border-line rounded-xl overflow-hidden">
            <div className="bg-warn-soft/40 px-5 py-2.5 flex items-center gap-2 border-b border-line">
              <Sparkles className="w-3.5 h-3.5 text-warn" strokeWidth={2.5} />
              <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-warn">
                AI suggestion — not yet confirmed
              </span>
              {isStrongMatch(r) && (
                <span
                  className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.08em] text-ok bg-ok-soft border border-line px-2 py-0.5 rounded"
                  title="Column names match between the two tables — this is a sure thing."
                >
                  <ShieldCheck className="w-3 h-3" strokeWidth={2.5} />
                  Strong match
                </span>
              )}
            </div>

            <div className="px-6 py-5">
              {/* Headline */}
              <p className="text-[12.5px] text-muted mb-1">Suggested relationship</p>
              <div className="flex items-center gap-2 flex-wrap font-display text-[20px] tracking-[-0.01em] text-ink mb-4">
                <span>{fromTable?.display_name ?? r.from_table}</span>
                <span className="text-muted-2">·</span>
                <span className="font-mono text-[15px] text-ink-2">{r.from_column ?? '(any column)'}</span>
                <ArrowRight className="w-4 h-4 text-muted-2 mx-1" strokeWidth={2} />
                <span>{toTable?.display_name ?? r.to_table}</span>
                <span className="text-muted-2">·</span>
                <span className="font-mono text-[15px] text-ink-2">{r.to_column ?? '(any column)'}</span>
              </div>

              {/* Type */}
              <div className="flex items-center gap-2 mb-5">
                <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-muted">Type</span>
                <span className="text-[12px] font-mono uppercase tracking-[0.06em] text-ink bg-softer border border-line px-2 py-0.5 rounded">
                  {prettyType(r.relationship_type)}
                </span>
              </div>

              {/* Both column descriptions */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                <ColumnInfo
                  side="From"
                  table={fromTable}
                  col={fromCol}
                />
                <ColumnInfo
                  side="To"
                  table={toTable}
                  col={toCol}
                />
              </div>

              {/* Reasoning hint */}
              {r.description && (
                <div className="text-[12.5px] text-ink-2 italic border-l-2 border-ocean-soft pl-3 py-1 mb-5">
                  {r.description.replace(/â†’|→/g, '→')}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => doConfirm(r)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 text-[12.5px] font-mono uppercase tracking-[0.06em] text-white bg-ok rounded-md hover:opacity-90 transition disabled:opacity-50"
                >
                  <Check className="w-4 h-4" strokeWidth={2.5} />
                  Confirm
                  <kbd className="ml-1 px-1 py-0.5 text-[10px] bg-white/20 rounded border border-white/30">Y</kbd>
                </button>
                <button
                  onClick={() => doReject(r)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 text-[12.5px] font-mono uppercase tracking-[0.06em] text-warn border border-line rounded-md hover:bg-warn-soft transition disabled:opacity-50"
                >
                  <X className="w-4 h-4" strokeWidth={2.5} />
                  Reject
                  <kbd className="ml-1 px-1 py-0.5 text-[10px] bg-softer rounded border border-line">N</kbd>
                </button>
                <button
                  onClick={() => setEditing(r)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 text-[12.5px] font-mono uppercase tracking-[0.06em] text-ink-2 border border-line rounded-md hover:bg-softer transition disabled:opacity-50"
                >
                  <Pencil className="w-4 h-4" strokeWidth={2} />
                  Edit
                  <kbd className="ml-1 px-1 py-0.5 text-[10px] bg-softer rounded border border-line">E</kbd>
                </button>
                <span className="ml-auto text-[11px] font-mono text-muted-2">
                  ← prev · → next
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {editing && (
        <EditRelationshipDialog
          relationship={editing}
          tables={tables}
          columnsByTable={columnsByTable}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
          onDeleted={() => { setEditing(null); onChanged(); }}
        />
      )}
    </>
  );
}

function ColumnInfo({
  side, table, col,
}: {
  side: 'From' | 'To';
  table?: SourceTable;
  col?: SourceColumn;
}) {
  return (
    <div className="bg-softer border border-line rounded-md p-3.5">
      <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 mb-1">{side}</div>
      <div className="font-mono text-[12.5px] text-ink mb-1.5">
        {table?.table_name ?? '?'}<span className="text-muted-2">.</span>{col?.column_name ?? '?'}
      </div>
      {col?.data_type && (
        <div className="text-[11px] font-mono text-muted mb-2">{col.data_type}</div>
      )}
      {col?.description && (
        <p className="text-[12.5px] text-ink-2 italic leading-relaxed">{col.description}</p>
      )}
      {!col && (
        <p className="text-[12px] text-muted italic">No specific column — relationship spans the whole table.</p>
      )}
    </div>
  );
}

/**
 * "Strong match" heuristic for AI drafts that look like sure things.
 *
 * The backend doesn't expose AI confidence today, so this is a client-side
 * approximation. It's deliberately strict — false positives here would
 * cause the "Confirm all strong matches" button to confirm bad relationships
 * silently, which we want to avoid.
 *
 * A draft is strong if:
 *  • from_column equals to_column (case-insensitive), OR
 *  • from_column equals to_table_singular + 'ID' (e.g. "InvoiceID" → "Invoice"+"ID")
 * AND in either case the column name contains "id" so we know it's a key.
 */
function isStrongMatch(r: RelationshipRow): boolean {
  const fc = (r.from_column ?? '').toLowerCase();
  const tc = (r.to_column   ?? '').toLowerCase();
  const tt = (r.to_table    ?? '').toLowerCase();
  if (!fc || !tc) return false;
  // Must look like a key column.
  const looksLikeKey = fc.includes('id');
  if (!looksLikeKey) return false;
  // (a) exact column name match
  if (fc === tc) return true;
  // (b) from_column equals to_table-without-trailing-s + "id" (e.g. "Items" → "ItemID"/"Item")
  const stem = tt.endsWith('s') ? tt.slice(0, -1) : tt;
  if (fc === stem || fc === stem + 'id' || fc === stem + '_id') return true;
  return false;
}

function prettyType(t: string): string {
  switch (t) {
    case 'many_to_one':  return 'Many → One';
    case 'one_to_many':  return 'One → Many';
    case 'one_to_one':   return 'One → One';
    case 'many_to_many': return 'Many ↔ Many';
    default:             return t;
  }
}
