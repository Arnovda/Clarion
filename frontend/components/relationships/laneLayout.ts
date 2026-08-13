/**
 * Source lanes.
 *
 * The layout answers the question "where does this table come from?" without a
 * legend: each source gets its own vertical band, so **a cross-source edge is
 * the only kind that crosses a boundary**. The thing the user came to see is the
 * thing that visually pops, which no amount of edge styling achieves on a
 * force-directed hairball.
 *
 * Deliberately not dagre. Dagre optimises for hierarchy and would interleave
 * tables from different sources wherever that shortened an edge — destroying the
 * one property this layout exists to provide.
 *
 * A lane WRAPS into columns rather than growing into one tall strip. The first
 * version stacked every table in a single column, which for a tenant with one
 * source and 36 tables produced a 3,300px ribbon one node wide: `fitView` then
 * zoomed out far enough to fit it and nothing was legible. A lane is a block,
 * not a strip.
 */

import {
  NODE_W, LANE_GAP, LANE_PAD, NODE_GAP_Y, NODE_GAP_X, LANE_HEADER_H, nodeHeight,
} from './geometry';
import type { GraphSource, GraphTable } from './types';

export interface Lane {
  connectionId: number;
  name: string;
  connectorType: string;
  x: number;
  width: number;
  height: number;
  /** Index into the lane palette — stable per source across renders. */
  colorIndex: number;
}

export interface LayoutResult {
  lanes: Lane[];
  positions: Map<number, { x: number; y: number }>;
}

/**
 * Lane tint palette. Exact Online and Odoo keep the hues the rest of the product
 * already associates with them (`REGISTRY_COLORS` on /sources); anything else
 * takes the next colour in a stable rotation so a third source never collides
 * with the first two.
 */
const LANE_COLORS = ['#c2703d', '#6b4e8c', '#2d6e78', '#3f7a5c', '#a06a1c', '#8c5a3c'];
const PINNED: Record<string, number> = { exactonline: 0, odoo: 1 };

export function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length];
}

/**
 * Assign a stable colour index per source.
 *
 * Pinned connectors keep their established hue. Everything else is assigned in
 * source order, skipping indices already taken, so a tenant's lanes do not
 * change colour when they connect an unrelated new source.
 */
export function assignColors(sources: readonly GraphSource[]): Map<number, number> {
  const out = new Map<number, number>();
  const taken = new Set<number>();

  for (const s of sources) {
    const pinned = PINNED[s.connectorType];
    if (pinned !== undefined && !taken.has(pinned)) {
      out.set(s.id, pinned);
      taken.add(pinned);
    }
  }
  let next = 0;
  for (const s of sources) {
    if (out.has(s.id)) continue;
    while (taken.has(next)) next += 1;
    out.set(s.id, next);
    taken.add(next);
    next += 1;
  }
  return out;
}

/**
 * Lay tables out in per-source lanes.
 *
 * Within a lane, tables are ordered by how connected they are. The most
 * connected table is the one a reviewer most likely wants — it is the hub the
 * rest of the source hangs off — and putting it at the top means the useful part
 * of a lane is visible without scrolling.
 */

/**
 * Rows per column before a lane wraps.
 *
 * Chosen so a lane stays close to screen-shaped: taller than this and `fitView`
 * has to zoom out past the point where a table name is readable, which is the
 * failure the first version shipped with.
 */
const MAX_ROWS_PER_COLUMN = 7;

/**
 * Place one source's tables into a wrapped grid and return the block's size.
 * Column widths are uniform, so a lane's width is just how many columns it needed.
 */
function packLane(
  tables: readonly GraphTable[],
  laneX: number,
  positions: Map<number, { x: number; y: number }>,
  columnCountByTable: Map<number, number>,
  expanded: ReadonlySet<number>,
): { width: number; height: number } {
  const columns = Math.max(1, Math.ceil(tables.length / MAX_ROWS_PER_COLUMN));
  const perColumn = Math.ceil(tables.length / columns);

  let tallest = 0;
  for (let c = 0; c < columns; c += 1) {
    const slice = tables.slice(c * perColumn, (c + 1) * perColumn);
    let y = LANE_HEADER_H;
    for (const t of slice) {
      positions.set(t.id, { x: laneX + LANE_PAD + c * (NODE_W + NODE_GAP_X), y });
      y += nodeHeight(expanded.has(t.id), columnCountByTable.get(t.id) ?? 0) + NODE_GAP_Y;
    }
    tallest = Math.max(tallest, y);
  }

  const width = LANE_PAD * 2 + columns * NODE_W + (columns - 1) * NODE_GAP_X;
  return { width, height: tallest };
}

export function laneLayout(
  sources: readonly GraphSource[],
  tables: readonly GraphTable[],
  columnCountByTable: Map<number, number>,
  expanded: ReadonlySet<number>,
): LayoutResult {
  const colors = assignColors(sources);
  const positions = new Map<number, { x: number; y: number }>();
  const lanes: Lane[] = [];

  // Only lay out sources that actually have visible tables — an empty lane is
  // chrome that teaches the user nothing.
  const bySource = new Map<number, GraphTable[]>();
  for (const t of tables) {
    if (!bySource.has(t.connectionId)) bySource.set(t.connectionId, []);
    bySource.get(t.connectionId)!.push(t);
  }

  let x = 0;

  for (const source of sources) {
    const laneTables = bySource.get(source.id);
    if (!laneTables || laneTables.length === 0) continue;

    laneTables.sort((a, b) =>
      b.relationshipCount - a.relationshipCount ||
      a.tableName.localeCompare(b.tableName));

    const { width, height } = packLane(laneTables, x, positions, columnCountByTable, expanded);

    lanes.push({
      connectionId: source.id,
      name: source.name,
      connectorType: source.connectorType,
      x,
      width,
      height,
      colorIndex: colors.get(source.id) ?? 0,
    });

    x += width + LANE_GAP;
  }

  // Tables whose source is missing from `sources` would otherwise be invisible
  // with no explanation. Park them in a trailing lane rather than dropping them.
  const placed = new Set(lanes.map((l) => l.connectionId));
  const orphans = tables.filter((t) => !placed.has(t.connectionId));
  if (orphans.length) {
    const { width, height } = packLane(orphans, x, positions, columnCountByTable, expanded);
    lanes.push({
      connectionId: -1,
      name: 'Unassigned',
      connectorType: '',
      x,
      width,
      height,
      colorIndex: LANE_COLORS.length - 1,
    });
  }

  return { lanes, positions };
}
