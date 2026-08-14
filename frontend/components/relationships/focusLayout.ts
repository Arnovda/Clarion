/**
 * Focus layouts — one table at the centre, its neighbours around it.
 *
 * Explore answers exactly one question: *"I care about this table — what does it
 * connect to?"*. A grid of peers cannot answer that, because nothing in a grid
 * says which card the question is about. Putting the anchor in the middle and its
 * neighbours in a ring answers it before a single word is read.
 *
 * It also removes edge crossings by construction: every edge runs from the centre
 * outward, so no two can cross. That is worth more than any amount of routing
 * cleverness on a grid.
 */

import { NODE_W } from './geometry';

/** How many neighbours a ring can hold before text shrinks past readability. */
export const MAX_NEIGHBOURS = 12;

export interface Placement {
  positions: Map<number, { x: number; y: number }>;
}

/**
 * Anchor centred, neighbours on an ellipse around it.
 *
 * An ellipse rather than a circle because screens are wider than they are tall;
 * a circle wastes the horizontal space and forces a tighter vertical fit, which
 * is the axis where node height varies most.
 */
export function radialLayout(
  anchorId: number,
  neighbourIds: readonly number[],
  heightOf: (id: number) => number,
): Placement {
  const positions = new Map<number, { x: number; y: number }>();
  const n = neighbourIds.length;

  const anchorH = heightOf(anchorId);
  positions.set(anchorId, { x: -NODE_W / 2, y: -anchorH / 2 });
  if (n === 0) return { positions };

  const maxNeighbourH = Math.max(...neighbourIds.map(heightOf));

  // Three constraints, and the ring has to satisfy all of them:
  //   • clear the anchor horizontally and vertically,
  //   • leave room between adjacent neighbours,
  //   • stay compact enough that fitView does not shrink the text.
  const clearanceX = NODE_W + 150;
  const clearanceY = anchorH / 2 + maxNeighbourH / 2 + 70;
  const spacingR = (n * (NODE_W + 56)) / (2 * Math.PI);

  const rx = Math.max(clearanceX, spacingR * 1.25);
  const ry = Math.max(clearanceY, spacingR * 0.78);

  // Start at the top and go clockwise: the first neighbour lands where the eye
  // already is, rather than off to one side.
  for (let i = 0; i < n; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const cx = Math.cos(angle) * rx;
    const cy = Math.sin(angle) * ry;
    positions.set(neighbourIds[i], {
      x: cx - NODE_W / 2,
      y: cy - heightOf(neighbourIds[i]) / 2,
    });
  }

  return { positions };
}

/**
 * There is deliberately no pair layout any more.
 *
 * Selecting a relationship used to collapse the canvas to its two tables, side
 * by side. It threw away the context that makes the answer readable — a column
 * pointing at two different targets is only obvious when both targets are on
 * screen — and it made a click feel like navigation when it should feel like
 * pointing at something. Selecting now HIGHLIGHTS within the ring: the layout
 * does not move, the other lines fade, and the two joined fields light up.
 */

/**
 * Which neighbours make the ring when a hub has more than it can hold.
 *
 * Ranked by how many links they share with the anchor — "most strongly related"
 * is the ordering someone exploring actually means. The remainder is not hidden,
 * it is reachable from the table list, and the toolbar says how many were left
 * out rather than pretending the ring is the whole answer.
 */
export function rankNeighbours(
  anchorId: number,
  relationships: readonly { fromTableId: number; toTableId: number }[],
  candidates: readonly number[],
): number[] {
  const linkCount = new Map<number, number>();
  for (const r of relationships) {
    const other = r.fromTableId === anchorId ? r.toTableId
      : r.toTableId === anchorId ? r.fromTableId
      : null;
    if (other != null) linkCount.set(other, (linkCount.get(other) ?? 0) + 1);
  }
  return [...candidates].sort((a, b) => (linkCount.get(b) ?? 0) - (linkCount.get(a) ?? 0));
}
