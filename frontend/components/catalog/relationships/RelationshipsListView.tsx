'use client';

/**
 * <RelationshipsListView> — relationships grouped by table, sorted, filterable.
 *
 * One row per relationship. Each row shows from-column → to-table.to-column,
 * a type chip, an "AI draft" pill, and inline actions (Confirm / Edit / Delete).
 * Tables that have NO relationships are still listed (collapsed by default)
 * so users can find them and add new ones.
 */

import { useMemo, useState } from 'react';
import {
  ArrowRight, ChevronDown, ChevronRight, Check, Pencil, Trash2,
  Sparkles, Plus,
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
  search:         string;
  onChanged:      () => void;
  onAdd:          () => void;
}

export default function RelationshipsListView({
  tables, columnsByTable, relationships, search, onChanged, onAdd,
}: Props) {
  // Tables that initially have relationships are expanded; tables without are collapsed.
  const initialCollapsed = useMemo(() => {
    const set = new Set<number>();
    for (const t of tables) {
      const has = relationships.some(
        (r) => r.from_table_id === t.id || r.to_table_id === t.id,
      );
      if (!has) set.add(t.id);
    }
    return set;
  }, [tables, relationships]);
  const [collapsed, setCollapsed] = useState<Set<number>>(initialCollapsed);
  const [editing, setEditing] = useState<RelationshipRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Lookup of id → display_name so rows can show "Products" instead of "Items".
  const displayById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of tables) m.set(t.id, t.display_name);
    return m;
  }, [tables]);
  const displayFor = (id: number, fallback: string) => displayById.get(id) ?? fallback;

  // Group relationships by FROM table; show tables in display-name order.
  const grouped = useMemo(() => {
    const byTableId = new Map<number, RelationshipRow[]>();
    for (const t of tables) byTableId.set(t.id, []);
    for (const r of relationships) {
      const arr = byTableId.get(r.from_table_id);
      if (arr) arr.push(r);
    }
    // Sort each group by from_column then to_table for predictable order.
    byTableId.forEach((arr) => {
      arr.sort((a: RelationshipRow, b: RelationshipRow) => {
        const ka = `${a.from_column ?? ''}|${a.to_table}|${a.to_column ?? ''}`;
        const kb = `${b.from_column ?? ''}|${b.to_table}|${b.to_column ?? ''}`;
        return ka.localeCompare(kb);
      });
    });
    return tables
      .slice()
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .map((t) => ({ table: t, rels: byTableId.get(t.id) ?? [] }));
  }, [tables, relationships]);

  // Apply search across table names, column names, and descriptions.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return grouped;
    return grouped
      .map(({ table, rels }) => {
        const tableMatches =
          table.table_name.toLowerCase().includes(q) ||
          table.display_name.toLowerCase().includes(q);
        const matchedRels = rels.filter((r) =>
          (r.from_column ?? '').toLowerCase().includes(q) ||
          (r.to_table ?? '').toLowerCase().includes(q) ||
          (r.to_column ?? '').toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q),
        );
        if (tableMatches) return { table, rels };
        if (matchedRels.length) return { table, rels: matchedRels };
        return null;
      })
      .filter((x): x is { table: SourceTable; rels: RelationshipRow[] } => x !== null);
  }, [grouped, search]);

  function toggle(tableId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  async function confirmRel(r: RelationshipRow) {
    setBusyId(r.id);
    try {
      // Empty patch — server unconditionally sets aiDraft = false.
      await patchRelationship(r.id);
      await onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRel(r: RelationshipRow) {
    setBusyId(r.id);
    try {
      await deleteRelationship(r.id);
      await onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (filtered.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-3">
        <p className="text-[13.5px] text-ink-2">No matches.</p>
        <p className="text-[12px] text-muted max-w-md">
          Nothing matches your search. Clear it to see all tables.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <div className="space-y-3">
          {filtered.map(({ table, rels }) => {
            const isCollapsed = collapsed.has(table.id);
            const draftCount = rels.filter((r) => r.ai_draft).length;
            return (
              <section
                key={table.id}
                className="bg-raised border border-line rounded-lg overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggle(table.id)}
                  className="w-full flex items-center gap-2 px-4 py-3 hover:bg-softer text-left"
                >
                  {isCollapsed
                    ? <ChevronRight className="w-3.5 h-3.5 text-muted-2 flex-shrink-0" strokeWidth={2.5} />
                    : <ChevronDown  className="w-3.5 h-3.5 text-muted-2 flex-shrink-0" strokeWidth={2.5} />}
                  <span className="font-display text-[15px] text-ink tracking-[-0.01em]">
                    {table.display_name}
                  </span>
                  <span className="text-[11px] font-mono text-muted-2">
                    {table.table_name}
                  </span>
                  <span className="ml-auto text-[11px] font-mono uppercase tracking-[0.06em] text-muted">
                    {rels.length === 0
                      ? 'no relationships'
                      : `${rels.length} ${rels.length === 1 ? 'relationship' : 'relationships'}`}
                  </span>
                  {draftCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.06em] text-warn bg-warn-soft border border-line px-1.5 py-0.5 rounded">
                      <Sparkles className="w-2.5 h-2.5" strokeWidth={2.5} />
                      {draftCount} draft{draftCount === 1 ? '' : 's'}
                    </span>
                  )}
                </button>

                {!isCollapsed && (
                  <div className="border-t border-line">
                    {rels.length === 0 ? (
                      <div className="px-4 py-4 flex items-center justify-between gap-3">
                        <p className="text-[12px] text-muted">
                          This table has no relationships yet.
                        </p>
                        <button
                          onClick={onAdd}
                          className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-[0.06em] text-ocean hover:text-ocean-hover"
                        >
                          <Plus className="w-3 h-3" strokeWidth={2.5} />
                          Add one
                        </button>
                      </div>
                    ) : (
                      <ul>
                        {rels.map((r) => {
                          const toDisplay = displayFor(r.to_table_id, r.to_table);
                          // Strip the broken arrow encoding from descriptions written by older profiler runs.
                          const cleanDesc = (r.description ?? '')
                            .replace(/â†’|→/g, '→')
                            .trim();
                          // Hide the technical fallback "Table.Col → Table.Col" descriptions; they
                          // duplicate the row content and don't help comprehension.
                          const isTechDesc = /^[A-Za-z_][\w]*\.[A-Za-z_][\w]*\s*→\s*[A-Za-z_][\w]*\.[A-Za-z_][\w]*/.test(cleanDesc);
                          const showDesc = cleanDesc && !isTechDesc;

                          return (
                            <li
                              key={r.id}
                              className="px-4 py-2.5 border-b border-softer last:border-b-0 group"
                            >
                              <div className="flex items-center gap-3">
                                <span className="text-[12.5px] font-mono text-ink-2 truncate min-w-0 flex items-center gap-1.5 flex-1">
                                  <span className="truncate">{r.from_column ?? '(any)'}</span>
                                  <ArrowRight className="w-3 h-3 text-muted-2 flex-shrink-0" strokeWidth={2} />
                                  <span className="truncate text-ink">{toDisplay}</span>
                                  <span className="text-muted-2">.</span>
                                  <span className="truncate">{r.to_column ?? '(any)'}</span>
                                </span>

                                <span className={cn(
                                  'text-[10px] font-mono uppercase tracking-[0.06em] px-1.5 py-0.5 rounded border',
                                  relTypeStyle(r.relationship_type),
                                )}>
                                  {prettyType(r.relationship_type)}
                                </span>

                                {r.ai_draft && (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-[0.06em] text-warn bg-warn-soft border border-line px-1.5 py-0.5 rounded">
                                    <Sparkles className="w-2.5 h-2.5" strokeWidth={2.5} />
                                    AI draft
                                  </span>
                                )}

                                <div className="opacity-0 group-hover:opacity-100 transition flex items-center gap-1">
                                  {r.ai_draft && (
                                    <button
                                      onClick={() => confirmRel(r)}
                                      disabled={busyId === r.id}
                                      title="Confirm this relationship"
                                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono uppercase tracking-[0.06em] text-ok bg-ok-soft border border-line rounded hover:bg-ok hover:text-white transition disabled:opacity-50"
                                    >
                                      <Check className="w-3 h-3" strokeWidth={2.5} />
                                      Confirm
                                    </button>
                                  )}
                                  <button
                                    onClick={() => setEditing(r)}
                                    title="Edit"
                                    className="inline-flex items-center justify-center w-7 h-7 text-muted hover:text-ink hover:bg-softer rounded transition"
                                  >
                                    <Pencil className="w-3 h-3" strokeWidth={2} />
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (confirm(`Delete this relationship?\n\n${displayFor(r.from_table_id, r.from_table)}.${r.from_column ?? '?'} → ${toDisplay}.${r.to_column ?? '?'}`)) {
                                        deleteRel(r);
                                      }
                                    }}
                                    disabled={busyId === r.id}
                                    title="Delete"
                                    className="inline-flex items-center justify-center w-7 h-7 text-muted hover:text-warn hover:bg-warn-soft rounded transition disabled:opacity-50"
                                  >
                                    <Trash2 className="w-3 h-3" strokeWidth={2} />
                                  </button>
                                </div>
                              </div>

                              {/* Plain-language explanation — comes from the AI draft or whatever
                                  was entered in the description field. Helps users understand
                                  "many-to-one" intuitively without thinking in N/1.
                                  Long descriptions get clamped to 2 lines; click to toggle full. */}
                              {showDesc && (
                                <DescriptionLine text={cleanDesc} />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {editing && (
        <EditRelationshipDialog
          relationship={editing}
          tables={tables}
          columnsByTable={columnsByTable}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          onDeleted={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

// ─── Description with hover-to-expand ──────────────────────────────────────

function DescriptionLine({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Heuristic: if the description is short enough to fit on ~2 lines we don't
  // bother with the toggle. Threshold tuned for ~70-char-per-line at the
  // current font size.
  const needsClamp = text.length > 140;

  if (!needsClamp) {
    return (
      <p className="ml-0.5 mt-1 text-[11.5px] text-muted italic leading-relaxed">
        {text}
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
      title={expanded ? 'Click to collapse' : 'Click to read more'}
      className={cn(
        'ml-0.5 mt-1 text-[11.5px] text-muted italic leading-relaxed text-left w-full',
        !expanded && 'line-clamp-2',
        'hover:text-ink-2 transition cursor-pointer',
      )}
    >
      {text}
      {!expanded && <span className="ml-1 not-italic font-mono uppercase tracking-[0.06em] text-[10px] text-ocean">more</span>}
    </button>
  );
}

// ─── Type styling helpers ───────────────────────────────────────────────────

function prettyType(t: string): string {
  switch (t) {
    case 'many_to_one':  return 'N → 1';
    case 'one_to_many':  return '1 → N';
    case 'one_to_one':   return '1 → 1';
    case 'many_to_many': return 'N ↔ N';
    default:             return t;
  }
}

function relTypeStyle(t: string): string {
  switch (t) {
    case 'many_to_one':  return 'text-warn bg-warn-soft border-line';
    case 'one_to_many':  return 'text-ocean bg-ocean-softer border-ocean-soft';
    case 'one_to_one':   return 'text-ok bg-ok-soft border-line';
    case 'many_to_many': return 'text-ai bg-ai-softer border-ai-soft';
    default:             return 'text-muted bg-softer border-line';
  }
}
