'use client';

import { useMemo } from 'react';
import { Search, ChevronRight, ChevronDown, Loader2, ListChecks, Flag } from 'lucide-react';
import type { GraphSource, GraphTable, Provenance, EdgeKind, Measurement } from './types';
import { outcomeOf, OUTCOME, type Outcome } from './MeasurePanel';

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
  /** Last measurement, if this link has ever been checked. */
  measured: Measurement | null;
  flagged: boolean;
  /** How many targets this link's source column points at, including itself. */
  siblingTargets: number;
}

/** A per-table check in flight. */
export interface CheckProgress {
  /** null when the sweep covers several tables at once. */
  tableId: number | null;
  done: number;
  total: number;
}

/**
 * How a table's links came out, as one line.
 *
 * Counting is the point: after a sweep the question is "how many need me?",
 * and three numbers answer it before any row is read.
 */
function summarise(links: readonly TableListLink[]) {
  const by: Record<Outcome, number> = { holds: 0, partial: 0, none: 0, unknown: 0 };
  for (const l of links) by[outcomeOf(l.measured)] += 1;
  return by;
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
  linksFor, check, search, onSearch, onPickTable, onPickLink, onCheckTable,
  flaggedByTable, needsAttention, onlyAttention, onToggleAttention, onCheckMany,
}: {
  tables: GraphTable[];
  sources: GraphSource[];
  colorFor: (connectionId: number) => string;
  /** How many of a table's relationships nobody has decided on yet. */
  pendingByTable: Map<number, number>;
  /** How many of a table's relationships someone has marked as a problem. */
  flaggedByTable: Map<number, number>;
  selectedTableId: number | null;
  selectedEdgeId: number | null;
  linksFor: (tableId: number) => TableListLink[];
  /** The per-table check currently running, if any. */
  check: CheckProgress | null;
  /** Tables carrying something unresolved — drives the filter. */
  needsAttention: ReadonlySet<number>;
  onlyAttention: boolean;
  onToggleAttention: () => void;
  search: string;
  onSearch: (v: string) => void;
  onPickTable: (tableId: number) => void;
  onPickLink: (relationshipId: number) => void;
  onCheckTable: (tableId: number) => void;
  onCheckMany: (tableIds: number[]) => void;
}) {
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (t: GraphTable) =>
      !q || `${t.tableName} ${t.displayName ?? ''}`.toLowerCase().includes(q);

    return sources
      .map((s) => ({
        source: s,
        tables: tables
          .filter((t) => t.connectionId === s.id && match(t)
            && (!onlyAttention || needsAttention.has(t.id)))
          // Where the work is, first. Then the hubs, which is what someone
          // exploring is almost always after; alphabetical buries both.
          .sort((a, b) =>
            (pendingByTable.get(b.id) ?? 0) - (pendingByTable.get(a.id) ?? 0) ||
            b.relationshipCount - a.relationshipCount ||
            (a.displayName || a.tableName).localeCompare(b.displayName || b.tableName)),
      }))
      .filter((g) => g.tables.length > 0);
  }, [tables, sources, search, pendingByTable, onlyAttention, needsAttention]);

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

      {/* One row, two controls: what to look at, and how to find out. Checking
          a table at a time is fine once you know where the problem is; finding
          that out over thirty-six tables is not something to do by hand. */}
      <div className="flex items-center gap-1.5 border-b border-line/70 px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleAttention}
          className={`rounded-md px-2 py-[3px] text-[11.5px] transition-colors ${
            onlyAttention ? 'bg-ocean text-white' : 'text-ink2 hover:bg-soft'
          }`}
        >
          Needs attention
          <span className={`ml-1 tabular-nums ${onlyAttention ? 'text-white/75' : 'text-muted2'}`}>
            {needsAttention.size}
          </span>
        </button>
        <button
          type="button"
          disabled={!!check || total === 0}
          onClick={() => onCheckMany(grouped.flatMap((g) => g.tables.map((t) => t.id)))}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[11.5px] text-ocean hover:bg-oceanSofter disabled:opacity-40"
          title="Check every link on every table shown"
        >
          {check?.tableId === null
            ? <Loader2 size={11} className="animate-spin" />
            : <ListChecks size={11} />}
          {check?.tableId === null ? `Checking ${check.done + 1}/${check.total}` : 'Check all shown'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {total === 0 && (
          <p className="px-4 py-6 text-[12.5px] text-muted">
            {onlyAttention ? 'Nothing needs your attention here.' : 'No table matches that.'}
          </p>
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
                    {/* A raised flag outranks everything else on the row: it is
                        the one thing on this table that a person has already
                        said is wrong. */}
                    {(flaggedByTable.get(t.id) ?? 0) > 0 && (
                      <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] font-medium tabular-nums text-err">
                        <Flag size={9} />
                        {flaggedByTable.get(t.id)}
                      </span>
                    )}
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

                  {open && (() => {
                    const links = linksFor(t.id);
                    const by = summarise(links);
                    const checkable = links.filter((l) => l.kind !== 'match').length;
                    const running = check?.tableId === t.id ? check : null;
                    const everChecked = links.some((l) => l.measured);

                    return (
                      <div className="pb-1 pl-[26px] pr-2">
                        {links.length === 0 && (
                          <p className="py-1.5 text-[11.5px] leading-relaxed text-muted">
                            Nothing connects to this table yet. Open it on the canvas and drag
                            from one of its fields to draw a link.
                          </p>
                        )}

                        {/* One line, three states: offer the run, show its
                            progress, then show what it found. Anything more
                            here competes with the rows it is describing. */}
                        {checkable > 0 && (
                          <div className="flex min-h-[24px] items-center gap-1.5 py-1 text-[11px]">
                            {running ? (
                              <span className="flex items-center gap-1.5 text-muted">
                                <Loader2 size={11} className="animate-spin" />
                                Checking {running.done + 1} of {running.total}…
                              </span>
                            ) : everChecked ? (
                              <>
                                {(['none', 'partial', 'holds', 'unknown'] as const)
                                  .filter((k) => by[k] > 0)
                                  .map((k) => (
                                    <span key={k} className="tabular-nums" style={{ color: OUTCOME[k].color }}>
                                      {by[k]} {OUTCOME[k].label}
                                    </span>
                                  ))
                                  .flatMap((el, i) => (i === 0 ? [el] : [
                                    <span key={`s${i}`} className="text-muted2">·</span>, el,
                                  ]))}
                                <button
                                  type="button"
                                  onClick={() => onCheckTable(t.id)}
                                  className="ml-auto shrink-0 rounded px-1 text-ocean hover:bg-oceanSofter"
                                >
                                  Check again
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onCheckTable(t.id)}
                                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-[3px] text-ink2 hover:bg-soft"
                              >
                                <ListChecks size={11} />
                                Check {checkable} link{checkable === 1 ? '' : 's'} against your data
                              </button>
                            )}
                          </div>
                        )}

                        {links.map((l) => {
                          const active = l.id === selectedEdgeId;
                          const outcome = outcomeOf(l.measured);
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
                              {l.siblingTargets > 1 && (
                                <span
                                  className="shrink-0 rounded bg-soft px-1 text-[9.5px] text-muted"
                                  title={`${l.ownLabel} points at ${l.siblingTargets} different targets — usually only one of them is real`}
                                >
                                  {l.siblingTargets} targets
                                </span>
                              )}
                              {l.flagged && <Flag size={10} className="shrink-0 text-err" />}
                              {l.isCrossSource && (
                                <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-ocean">
                                  {l.kind === 'match' ? 'match' : 'cross'}
                                </span>
                              )}
                              {/* The measured overlap, right-aligned so a column
                                  of them scans as one list of numbers. */}
                              {l.measured && outcome !== 'unknown' && (
                                <span
                                  className="w-[34px] shrink-0 text-right text-[11px] font-medium tabular-nums"
                                  style={{ color: OUTCOME[outcome].color }}
                                >
                                  {Math.round((l.measured.containment?.ratio ?? 0) * 100)}%
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
