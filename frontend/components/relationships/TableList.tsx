'use client';

import { useMemo } from 'react';
import { Search, ChevronRight, ChevronDown } from 'lucide-react';
import type { GraphSource, GraphTable, Provenance, EdgeKind } from './types';

/** One of a table's relationships, as it reads in the list. */
export interface TableListLink {
  id: number;
  /** The column on this table. */
  ownLabel: string;
  /** The other end, table and column. */
  otherLabel: string;
  provenance: Provenance;
  kind: EdgeKind;
  isCrossSource: boolean;
}

/**
 * The way into the graph, and the way to work through it.
 *
 * A node-link diagram is a poor instrument for orientation — nobody reads a
 * 36-node picture to find a table — and an excellent one for one question:
 * "what does THIS connect to?". So finding is a list problem and the canvas is
 * reserved for the answer.
 *
 * It is also the **work list**. Expanding a table shows its relationships, and
 * clicking one opens it for checking or editing. Without that the only way to
 * reach a relationship was to step through a global queue in whatever order it
 * came back in, which is fine for a first pass and useless for "I want to go
 * over the bank entries".
 */
export function TableList({
  tables, sources, colorFor, pendingByTable, selectedTableId, selectedEdgeId,
  linksFor, search, onSearch, onPickTable, onPickLink,
}: {
  tables: GraphTable[];
  sources: GraphSource[];
  colorFor: (connectionId: number) => string;
  /** How many of a table's relationships nobody has decided on yet. */
  pendingByTable: Map<number, number>;
  selectedTableId: number | null;
  selectedEdgeId: number | null;
  linksFor: (tableId: number) => TableListLink[];
  search: string;
  onSearch: (v: string) => void;
  onPickTable: (tableId: number) => void;
  onPickLink: (relationshipId: number) => void;
}) {
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (t: GraphTable) =>
      !q || `${t.tableName} ${t.displayName ?? ''}`.toLowerCase().includes(q);

    return sources
      .map((s) => ({
        source: s,
        tables: tables
          .filter((t) => t.connectionId === s.id && match(t))
          // Where the work is, first. Then the hubs, which is what someone
          // exploring is almost always after; alphabetical buries both.
          .sort((a, b) =>
            (pendingByTable.get(b.id) ?? 0) - (pendingByTable.get(a.id) ?? 0) ||
            b.relationshipCount - a.relationshipCount ||
            (a.displayName || a.tableName).localeCompare(b.displayName || b.tableName)),
      }))
      .filter((g) => g.tables.length > 0);
  }, [tables, sources, search, pendingByTable]);

  const total = grouped.reduce((n, g) => n + g.tables.length, 0);

  return (
    <aside className="flex h-full w-[286px] flex-col border-r border-line bg-surface">
      <div className="border-b border-line/70 px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-muted2" />
          <input
            id="rel-search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Find a table…"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted2"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {total === 0 && (
          <p className="px-4 py-6 text-[12.5px] text-muted">No table matches that.</p>
        )}

        {grouped.map((g) => (
          <div key={g.source.id} className="mb-1">
            {/* Only label the group when there is more than one source — a lone
                heading above every row is chrome that teaches nothing. */}
            {grouped.length > 1 && (
              <div
                className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em]"
                style={{ color: colorFor(g.source.id) }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorFor(g.source.id) }} />
                {g.source.name}
              </div>
            )}

            {g.tables.map((t) => {
              const open = t.id === selectedTableId;
              const pending = pendingByTable.get(t.id) ?? 0;
              const colour = colorFor(g.source.id);
              return (
                <div key={t.id}>
                  <button
                    type="button"
                    onClick={() => onPickTable(t.id)}
                    className={`flex w-full items-center gap-1.5 py-[7px] pl-2 pr-3 text-left transition-colors ${
                      open ? 'bg-oceanSofter' : 'hover:bg-soft'
                    }`}
                  >
                    <span
                      className="w-[3px] shrink-0 self-stretch rounded-full"
                      style={{ background: open ? colour : 'transparent' }}
                    />
                    {open
                      ? <ChevronDown size={12} className="shrink-0 text-muted2" />
                      : <ChevronRight size={12} className="shrink-0 text-muted2" />}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                      {t.displayName || t.tableName}
                    </span>
                    {/* Pending is the number that decides what to do next, so it
                        is the one that gets the colour. */}
                    {pending > 0 ? (
                      <span className="shrink-0 rounded-full bg-warnSoft px-1.5 text-[10.5px] font-medium tabular-nums text-ink2">
                        {pending}
                      </span>
                    ) : (
                      <span className="shrink-0 tabular-nums text-[11px] text-muted2">
                        {t.relationshipCount}
                      </span>
                    )}
                  </button>

                  {open && (
                    <div className="pb-1 pl-[26px] pr-2">
                      {linksFor(t.id).length === 0 && (
                        <p className="py-1.5 text-[11.5px] leading-relaxed text-muted">
                          Nothing connects to this table yet. Open it on the canvas and drag
                          from one of its fields to draw a link.
                        </p>
                      )}
                      {linksFor(t.id).map((l) => {
                        const active = l.id === selectedEdgeId;
                        return (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => onPickLink(l.id)}
                            className={`flex w-full items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-left ${
                              active ? 'bg-raised shadow-[0_0_0_1px_rgba(22,78,99,0.22)]' : 'hover:bg-soft'
                            }`}
                          >
                            {/* Same vocabulary as the canvas: solid = a person
                                decided this, hollow = still a suggestion. */}
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full"
                              style={l.provenance === 'ai'
                                ? { border: '1.5px solid #b8823a' }
                                : { background: l.provenance === 'human' ? '#1f6f83' : '#9aa3ad' }}
                            />
                            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink2">
                              {l.ownLabel}
                              <span className="text-muted2"> → </span>
                              {l.otherLabel}
                            </span>
                            {l.isCrossSource && (
                              <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-ocean">
                                {l.kind === 'match' ? 'match' : 'cross'}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
