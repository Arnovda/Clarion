/**
 * Node geometry and handle identity.
 *
 * LIFTED, NOT RE-DERIVED, from components/semantic/RelationshipCanvas.tsx. The
 * canvas itself is a clean sheet, but these numbers and the handle-ID scheme are
 * solved geometry: an edge has to terminate exactly on the centre of a column
 * row, and the alignment only holds while the header height, row height and the
 * handle's absolute offsets agree. Re-deriving them is a day of pixel-nudging
 * for no gain.
 *
 * The one rule that is easy to break: **handles must be siblings of the visual
 * box, not children of it.** The box clips its content (`overflow: hidden`) to
 * keep rounded corners, and a handle inside it is clipped away at exactly the
 * moment it matters — the node edge.
 */

/** Height of the table header block. */
export const HEADER_H = 58;
/** Height of one column row. */
export const ROW_H = 30;
/** Fixed node width — a variable width makes lane packing unpredictable. */
export const NODE_W = 248;

/** Horizontal gap between lanes. */
export const LANE_GAP = 96;
/** Padding inside a lane, left and right of its nodes. */
export const LANE_PAD = 28;
/** Vertical gap between stacked nodes in a lane. */
export const NODE_GAP_Y = 34;
/** Horizontal gap between wrapped columns inside one lane. */
export const NODE_GAP_X = 40;
/** Top offset for the first node, leaving room for the lane header. */
export const LANE_HEADER_H = 64;

/** Handle ids. `table` is the whole-node handle used when a node is collapsed. */
export const handleLeft = (id: number | 'table') => `L_${id}`;
export const handleRight = (id: number | 'table') => `R_${id}`;

/** Recover a column id from a handle id; null for the whole-node handle. */
export function parseHandle(h: string | null | undefined): number | null {
  if (!h) return null;
  const m = h.match(/^[LR]_(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Rendered height of a node, which depends on whether its columns are shown. */
export function nodeHeight(expanded: boolean, columnCount: number): number {
  return expanded ? HEADER_H + columnCount * ROW_H : HEADER_H;
}

/**
 * Vertical centre of a column row, relative to the node's top edge. This is the
 * expression the handle offset and the row offset must both use — if they are
 * computed separately they will drift.
 */
export function rowCentreY(index: number): number {
  return HEADER_H + index * ROW_H + ROW_H / 2;
}
