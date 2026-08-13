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
/** Height of the "N more fields" row at the bottom of a node. */
export const FOOTER_H = 26;
/** Fixed node width — a variable width makes the ring geometry unpredictable. */
export const NODE_W = 248;

/** Handle ids. `table` is the whole-node handle, used when no column is shown. */
export const handleLeft = (id: number | 'table') => `L_${id}`;
export const handleRight = (id: number | 'table') => `R_${id}`;

/** Recover a column id from a handle id; null for the whole-node handle. */
export function parseHandle(h: string | null | undefined): number | null {
  if (!h) return null;
  const m = h.match(/^[LR]_(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Rendered height of a node.
 *
 * The layout and the node component must agree on this exactly, or edges
 * terminate off their rows and the ring stops being centred — so both call this,
 * neither computes it.
 */
export function nodeHeight(shownColumns: number, hasFooter: boolean): number {
  return HEADER_H + shownColumns * ROW_H + (hasFooter ? FOOTER_H : 0);
}

/**
 * Vertical centre of a column row, relative to the node's top edge. This is the
 * expression the handle offset and the row offset must both use — if they are
 * computed separately they will drift.
 */
export function rowCentreY(index: number): number {
  return HEADER_H + index * ROW_H + ROW_H / 2;
}
