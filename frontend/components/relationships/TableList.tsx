'use client';

import { useMemo } from 'react';
import { Search } from 'lucide-react';
import type { GraphSource, GraphTable } from './types';

/**
 * The way into the graph.
 *
 * A node-link diagram is a poor instrument for orientation — nobody reads a
 * 36-node picture to find a table. It is an excellent instrument for one
 * question: "what does THIS connect to?". So finding a table is a list problem,
 * and the canvas is reserved for the answer.
 *
 * Sorted by how connected a table is, because the hubs are what someone
 * exploring is almost always looking for, and an alphabetical list buries them.
 */
export function TableList({
  tables, sources, colorFor, anchorId, search, onSearch, onPick,
}: {
  tables: GraphTable[];
  sources: GraphSource[];
  colorFor: (connectionId: number) => string;
  anchorId: number | null;
  search: string;
  onSearch: (v: string) => void;
  onPick: (tableId: number) => void;
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
          .sort((a, b) =>
            b.relationshipCount - a.relationshipCount ||
            (a.displayName || a.tableName).localeCompare(b.displayName || b.tableName)),
      }))
      .filter((g) => g.tables.length > 0);
  }, [tables, sources, search]);

  const total = grouped.reduce((n, g) => n + g.tables.length, 0);

  return (
    <aside className="flex h-full w-[268px] flex-col border-r border-line bg-surface">
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
              const active = t.id === anchorId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onPick(t.id)}
                  className={`flex w-full items-center gap-2 px-3 py-[7px] text-left transition-colors ${
                    active ? 'bg-oceanSofter' : 'hover:bg-soft'
                  }`}
                >
                  <span
                    className="h-full w-[3px] shrink-0 self-stretch rounded-full"
                    style={{ background: active ? colorFor(g.source.id) : 'transparent' }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                    {t.displayName || t.tableName}
                  </span>
                  <span className="shrink-0 tabular-nums text-[11px] text-muted2">
                    {t.relationshipCount}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
