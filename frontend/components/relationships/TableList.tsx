'use client';

import { useMemo, useState } from 'react';
import {
  Search, ChevronRight, ChevronDown, Loader2, ListChecks, Flag,
  BookText, UserCheck, Wrench, SearchCheck,
} from 'lucide-react';
import type {
  GraphSource, GraphTable, Provenance, EdgeKind, Measurement, SemanticSource,
} from './types';
import { originOf, TIER_STYLE, type Bucket } from './provenance';
import { shortFinding, OUTCOME, type Outcome } from './MeasurePanel';

/** One of a table's relationships, as it reads in the list. */
export interface TableListLink {
  id: number;
  /** Which way the relationship runs relative to this table: child or parent. */
  direction: 'out' | 'in';
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
  /** Which system this came from — named when it is the system's own documentation. */
  sourceName?: string;
  /** Which detection channel produced it; null for links written before migration 79. */
  semanticSource: SemanticSource | null;
}

/** A per-table check in flight. */
export interface CheckProgress {
  /** null when the sweep covers several tables at once. */
  tableId: number | null;
  done: number;
  total: number;
}

/**
 * WHERE this link came from — as a mark you can actually tell apart.
 *
 * It was a 6px dot with three states, and the middle one was wrong. Solid teal
 * meant a person, solid GREY meant "declared" — and "declared" silently covered
 * both the vendor's own documentation and a catalogue a Clarion engineer wrote
 * by hand. Two very different claims, one grey dot, and grey was the quietest
 * colour on screen carrying the most trustworthy fact the catalog holds.
 *
 * Migration 79 split them apart, so the mark can too. Four shapes, by how the
 * link was established rather than by how much anyone likes it:
 *
 *   book        the source system documents it, or the database enforces it
 *   wrench      a person wrote it — Clarion's connector, or your own team
 *   magnifier   Clarion found it by measuring your data
 *   open ring   Clarion proposed it and nobody has decided
 */
export function ProvenanceMark({ provenance, semanticSource, sourceName }: {
  provenance: Provenance;
  semanticSource: SemanticSource | null;
  sourceName?: string;
}) {
  const o = originOf(provenance, semanticSource);
  const title = sourceName && semanticSource === 'vendor_docs'
    ? `${o.label} — ${sourceName} documents this in its own data model`
    : `${o.label}${o.confirmed ? ' · confirmed by your team' : ''} — ${o.hint}`;

  // A person's confirmation is drawn ON TOP of the channel, not instead of it,
  // so a link somebody ticked still shows where it came from.
  if (o.confirmed) {
    return (
      <span className="flex shrink-0 text-ocean" title={title} aria-label={title}>
        <UserCheck size={11} />
      </span>
    );
  }
  if (o.tier === 'documented') {
    return (
      <span className="flex shrink-0" style={{ color: TIER_STYLE.documented.fg }} title={title} aria-label={title}>
        <BookText size={11} />
      </span>
    );
  }
  if (o.tier === 'written') {
    return (
      <span className="flex shrink-0" style={{ color: TIER_STYLE.written.fg }} title={title} aria-label={title}>
        <Wrench size={11} />
      </span>
    );
  }
  if (o.tier === 'found') {
    return (
      <span className="flex shrink-0 text-muted2" title={title} aria-label={title}>
        <SearchCheck size={11} />
      </span>
    );
  }
  return (
    <span
      className="mx-[2px] h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ border: '1.5px solid #b8823a' }}
      title={title}
      aria-label={title}
    />
  );
}

/**
 * A table's links, gathered under a HEADING THAT ANSWERS THE MODE'S QUESTION.
 *
 * They used to group under the field they leave from, which is the right answer
 * to "what does this column point at?" and the wrong one to "what is waiting on
 * me?". On `GL classifications` it produced two headings of thirteen rows each,
 * every row saying the same thing — because all twenty-six fail for one reason.
 *
 * The two modes ask different questions, so they group differently:
 *
 *   • **To review** groups by CAUSE. Twenty-six rows become four headings, and
 *     the shape of the problem is the heading rather than something you infer
 *     from reading every row.
 *   • **Confirmed** groups by ORIGIN. Nothing there needs deciding, so the
 *     useful split is who stands behind it — the vendor, Clarion, or your team.
 */
export interface LinkGroup {
  key: string;
  label: string;
  tone: Outcome | null;
  links: TableListLink[];
}

function group(links: readonly TableListLink[], bucket: Bucket): LinkGroup[] {
  const out = new Map<string, LinkGroup>();
  for (const l of links) {
    let key: string; let label: string; let tone: Outcome | null;
    if (bucket === 'review') {
      const f = shortFinding(l.measured, l.otherLabel);
      key = f ? f.group : 'not checked';
      label = f ? f.group : 'not checked';
      tone = f ? f.tone : 'unknown';
    } else {
      const o = originOf(l.provenance, l.semanticSource);
      key = o.label;
      label = o.label;
      tone = null;
    }
    const g = out.get(key);
    if (g) g.links.push(l);
    else out.set(key, { key, label, tone, links: [l] });
  }
  const rank: Record<Outcome, number> = { broken: 0, partial: 1, unknown: 2, holds: 3 };
  return [...out.values()].sort((a, b) =>
    (a.tone && b.tone ? rank[a.tone] - rank[b.tone] : 0) || b.links.length - a.links.length);
}

/**
 * How a table's links came out, as one line — counted by CAUSE, not by severity.
 *
 * It used to count the four outcomes, so a table whose every link fails the same
 * way read "26 partly match". That is a severity histogram; it says how bad
 * things are and nothing about what is wrong. Counted by cause the same table
 * reads **"26 not unique · 1 holds"**, which is the actual finding: one column
 * on this table repeats itself, and every link pointing at it fails for that one
 * reason. Same twenty-six rows, a fact instead of a temperature.
 *
 * Matches are excluded: they are verified by match RATE, not by containment, so
 * this check never runs on them and counting them would leave a number nobody
 * can bring down to zero.
 */
function summarise(links: readonly TableListLink[]) {
  const by = new Map<string, { n: number; color: string; tone: Outcome }>();
  for (const l of links) {
    if (l.kind === 'match') continue;
    const f = shortFinding(l.measured, l.otherLabel);
    if (!f) continue;
    const cur = by.get(f.group);
    if (cur) cur.n += 1;
    else by.set(f.group, { n: 1, color: f.color, tone: f.tone });
  }
  const rank: Record<Outcome, number> = { broken: 0, partial: 1, unknown: 2, holds: 3 };
  return [...by.entries()]
    .sort(([, a], [, b]) => rank[a.tone] - rank[b.tone] || b.n - a.n);
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
  tables, sources, colorFor, selectedTableId, selectedEdgeId,
  linksFor, check, search, onSearch, onPickTable, onPickLink, onCheckTable,
  flaggedByTable, needsAttention, onlyAttention, onToggleAttention, onCheckMany,
  bucket,
}: {
  /** Which half of the toggle is showing. Decides how links are grouped. */
  bucket: Bucket;
  tables: GraphTable[];
  sources: GraphSource[];
  colorFor: (connectionId: number) => string;
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
  // Which cause/origin headings are open, keyed `tableId|groupKey` so opening
  // one on a table does not open the same-named one on the next.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (t: GraphTable) =>
      !q || `${t.tableName} ${t.displayName ?? ''}`.toLowerCase().includes(q);

    return sources
      .map((s) => ({
        source: s,
        tables: tables
          // The table you are working on is never filtered away. `needsAttention`
          // is derived per bucket, so with the filter on, flipping the toggle
          // could drop the selected table out of the list while the canvas still
          // showed it — the list and the canvas disagreeing about what you have
          // open. A filter may hide anything except the thing in your hand.
          .filter((t) => t.connectionId === s.id && match(t)
            && (!onlyAttention || needsAttention.has(t.id) || t.id === selectedTableId))
          // ORDER MUST NOT MOVE WHEN THE TOGGLE MOVES. It used to sort by how
          // much was pending, which is a per-BUCKET number — so flipping to
          // Confirmed (where nothing is pending) re-sorted the entire list and
          // the table you were reading jumped somewhere else. The list is how
          // you navigate; a list that rearranges itself under a control that is
          // not about navigation is disorienting for no gain.
          //
          // `relationshipCount` is the graph-wide total, so it is identical in
          // both halves. Hubs first is what someone scanning is after anyway,
          // and "where is the work?" is what the Needs attention filter is for.
          .sort((a, b) =>
            b.relationshipCount - a.relationshipCount ||
            (a.displayName || a.tableName).localeCompare(b.displayName || b.tableName)),
      }))
      .filter((g) => g.tables.length > 0);
  }, [tables, sources, search, onlyAttention, needsAttention, selectedTableId]);

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
              // How many links this table has IN THE HALF ON SCREEN. Showing the
              // graph-wide total under a toggle that filters would put a number
              // on the row that the rows below it contradict.
              const inBucket = linksFor(t.id).length;
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
                    <span
                      className="w-7 shrink-0 text-right tabular-nums text-[11px] text-muted2"
                      title={`${inBucket} of this table's links are ${bucket === 'confirmed' ? 'confirmed' : 'waiting on you'}`}
                    >
                      {inBucket}
                    </span>
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
                                <span className="min-w-0 flex-1 truncate">
                                  {by.map(([label, v], i) => (
                                    <span key={label}>
                                      {i > 0 && <span className="text-muted2"> · </span>}
                                      <span className="tabular-nums" style={{ color: v.color }}>
                                        {v.n} {label}
                                      </span>
                                    </span>
                                  ))}
                                </span>
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

                        {/* Collapsed by cause (or by origin, in Confirmed).
                            Twenty-six near-identical rows become four headings
                            you can read without opening anything. */}
                        {group(links, bucket).map((gr) => {
                          const open = openGroups.has(t.id + '|' + gr.key);
                          return (
                            <div key={gr.key} className="mt-1 first:mt-0">
                              <button
                                type="button"
                                onClick={() => toggleGroup(t.id + '|' + gr.key)}
                                className="flex w-full items-center gap-1.5 rounded-md py-[3px] pl-1 pr-1 text-left hover:bg-soft"
                              >
                                {open
                                  ? <ChevronDown size={11} className="shrink-0 text-muted2" />
                                  : <ChevronRight size={11} className="shrink-0 text-muted2" />}
                                {gr.tone && (
                                  <span
                                    className="w-3 shrink-0 text-center text-[11px] font-bold leading-none"
                                    style={{ color: OUTCOME[gr.tone].color }}
                                    aria-hidden
                                  >
                                    {OUTCOME[gr.tone].glyph}
                                  </span>
                                )}
                                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink2">
                                  {gr.label}
                                </span>
                                <span className="shrink-0 tabular-nums text-[11px] text-muted2">
                                  {gr.links.length}
                                </span>
                              </button>

                              {open && gr.links.map((l) => {
                                const active = l.id === selectedEdgeId;
                                const finding = shortFinding(l.measured, l.otherLabel);
                                return (
                                  <button
                                    key={l.id}
                                    type="button"
                                    onClick={() => onPickLink(l.id)}
                                    title={finding?.detail}
                                    className={`flex w-full items-center gap-1.5 rounded-md py-[3px] pl-5 pr-1 text-left ${
                                      active ? 'bg-raised shadow-[0_0_0_1px_rgba(22,78,99,0.22)]' : 'hover:bg-soft'
                                    }`}
                                  >
                                    <ProvenanceMark
                                      provenance={l.provenance}
                                      semanticSource={l.semanticSource}
                                      sourceName={l.sourceName}
                                    />
                                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink2">
                                      <span className="text-muted2">{l.ownLabel} </span>
                                      {l.direction === 'out' ? '\u2192' : '\u2190'} {l.otherLabel}
                                    </span>
                                    {l.flagged && <Flag size={10} className="shrink-0 text-err" />}
                                    {l.isCrossSource && (
                                      <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-ocean">
                                        {l.kind === 'match' ? 'match' : 'cross'}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
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
