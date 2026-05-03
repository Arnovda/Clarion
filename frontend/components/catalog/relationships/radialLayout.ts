/**
 * Radial hub-and-spoke layout for "focus on a table" mode.
 *
 * The focused table sits centred at the origin and every neighbour is
 * placed on a circle around it. Neighbours are distributed evenly across
 * the FULL circle (not just the left/right halves) so the bounding box of
 * the cluster is roughly symmetric around the origin — which means
 * `fitView` on the canvas side ends up centring the viewport on (or very
 * close to) the focused table, regardless of how many neighbours there are
 * or which FK direction they have.
 *
 * Outgoing-FK neighbours are placed first starting at the right (3 o'clock)
 * and incoming-FK neighbours fill in from the left (9 o'clock), so the
 * directional reading "outgoing on the right, incoming on the left" still
 * holds when both directions exist. When only one direction exists the
 * neighbours wrap around the full circle anyway, which keeps the focused
 * table visually at the centre.
 *
 * The radius is the smallest value that:
 *   • keeps any neighbour box ≥ MIN_GAP px from the focused box
 *   • keeps two adjacent neighbours along the chord ≥ NODE_W + 30 px apart
 * so the cluster reads as a tight unit, not a sprawling diagram.
 */

import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import type { RelationshipRow } from './useSchema';
import { HEADER_H, NODE_W, ROW_H } from '@/components/semantic/RelationshipCanvas';

const MIN_GAP = 60;

function tableHeight(t: SourceTable, columnsByTable: Record<number, SourceColumn[]>): number {
  return HEADER_H + (columnsByTable[t.id]?.length ?? 0) * ROW_H;
}

export function computeRadialLayout(
  focusedId: number,
  visibleTables: SourceTable[],
  columnsByTable: Record<number, SourceColumn[]>,
  relationships: RelationshipRow[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  const focused = visibleTables.find((t) => t.id === focusedId);
  if (!focused) return positions;

  const focusH = tableHeight(focused, columnsByTable);
  // Focused: top-left at (-NODE_W/2, -focusH/2) → centre at (0, 0).
  positions.set(String(focusedId), { x: -NODE_W / 2, y: -focusH / 2 });

  // Bucket neighbours by FK direction. A table that has both incoming and
  // outgoing FKs against the focused goes to "outgoing".
  const outgoingIds = new Set<number>();
  const incomingIds = new Set<number>();
  for (const r of relationships) {
    if (r.from_table_id === focusedId) outgoingIds.add(r.to_table_id);
    if (r.to_table_id   === focusedId) incomingIds.add(r.from_table_id);
  }

  const outgoing: SourceTable[] = [];
  const incoming: SourceTable[] = [];
  for (const t of visibleTables) {
    if (t.id === focusedId) continue;
    if (outgoingIds.has(t.id))      outgoing.push(t);
    else if (incomingIds.has(t.id)) incoming.push(t);
    else                            outgoing.push(t);
  }

  outgoing.sort((a, b) => a.display_name.localeCompare(b.display_name));
  incoming.sort((a, b) => a.display_name.localeCompare(b.display_name));

  // Order neighbours around the circle: outgoing fill the right half going
  // clockwise from 3 o'clock; incoming fill the left half going clockwise
  // from 9 o'clock. With both populated the picture reads "outputs right /
  // inputs left". With only one direction populated the neighbours wrap
  // round the full circle, keeping the focused table at the geometric
  // centre of the bbox.
  const ordered: SourceTable[] = [];
  const N = outgoing.length + incoming.length;
  if (N === 0) return positions;

  if (incoming.length === 0) {
    ordered.push(...outgoing);
  } else if (outgoing.length === 0) {
    ordered.push(...incoming);
  } else {
    // Half each. Outgoing on right half (angles -π/2 → +π/2), incoming
    // on left half (angles +π/2 → +3π/2). placeOnCircle below assigns
    // angles by index in `ordered`, so build the array in that order.
    ordered.push(...outgoing, ...incoming);
  }

  // Pick a radius that keeps boxes from colliding.
  const maxNeighbourH = Math.max(
    HEADER_H + ROW_H,
    ...incoming.map((t) => tableHeight(t, columnsByTable)),
    ...outgoing.map((t) => tableHeight(t, columnsByTable)),
  );
  const clearance = Math.max(
    NODE_W + MIN_GAP,
    (focusH + maxNeighbourH) / 2 + MIN_GAP,
  );
  const chordSpacing = NODE_W + 30;
  // For N nodes on a full circle, adjacent nodes are 2π/N rad apart, so
  // chord = 2R·sin(π/N). Solve for R given chord ≥ chordSpacing.
  const chordR = N > 1
    ? chordSpacing / (2 * Math.sin(Math.PI / N))
    : 0;
  const radius = Math.max(clearance, chordR);

  // Distribute `ordered` evenly around the full circle. Index i lands at
  // angle (i / N) * 2π, with i=0 on the right (3 o'clock). Outgoing → right
  // half, incoming → left half (when both populated).
  //
  // Mixed case: outgoing.length goes into the right half, incoming.length
  // into the left half. We assign angles independently per half so each
  // half is evenly spread (unrelated to the other side's count).
  const place = (
    arr: SourceTable[],
    halfStart: number,
    halfEnd:   number,
  ) => {
    const n = arr.length;
    if (n === 0) return;
    if (n === 1) {
      const angle = (halfStart + halfEnd) / 2;
      const t = arr[0];
      positions.set(String(t.id), {
        x: Math.cos(angle) * radius - NODE_W / 2,
        y: Math.sin(angle) * radius - tableHeight(t, columnsByTable) / 2,
      });
      return;
    }
    // Spread n nodes across [halfStart, halfEnd] inclusive of both ends.
    const step = (halfEnd - halfStart) / (n - 1);
    for (let i = 0; i < n; i++) {
      const t = arr[i];
      const angle = halfStart + i * step;
      positions.set(String(t.id), {
        x: Math.cos(angle) * radius - NODE_W / 2,
        y: Math.sin(angle) * radius - tableHeight(t, columnsByTable) / 2,
      });
    }
  };

  if (incoming.length === 0) {
    // All outgoing — distribute around full circle so bbox stays centred.
    place(outgoing, -Math.PI, Math.PI - (2 * Math.PI) / N);
  } else if (outgoing.length === 0) {
    place(incoming, -Math.PI, Math.PI - (2 * Math.PI) / N);
  } else {
    // Outgoing on right half (-π/2 to +π/2), incoming on left half
    // (+π/2 to +3π/2). Each half spread evenly across its 180° arc.
    place(outgoing, -Math.PI / 2, Math.PI / 2);
    place(incoming, Math.PI / 2,  (3 * Math.PI) / 2);
  }

  return positions;
}
