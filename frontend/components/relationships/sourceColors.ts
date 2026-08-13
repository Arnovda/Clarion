/**
 * One colour per source system.
 *
 * Replaces the lane layout. Lanes existed so that a cross-source edge was the
 * only kind crossing a boundary — a genuine property, but it only pays off in a
 * view that draws the whole graph, and drawing the whole graph is the thing that
 * made this canvas unreadable. A focused view has one table in the middle and its
 * neighbours around it; there are no bands to cross, so the colour has to carry
 * the answer to "where does this come from?" on its own.
 *
 * It does that from a single 5px spine on each node. Earlier the same hue washed
 * the header, the border and every row rule at once, which with a single source
 * read as "everything is beige" rather than as identity.
 */

import type { GraphSource } from './types';

/**
 * Exact Online and Odoo keep the hues the rest of the product already associates
 * with them (`REGISTRY_COLORS` on /sources); anything else takes the next colour
 * in a stable rotation so a third source never collides with the first two.
 */
const SOURCE_COLORS = ['#c2703d', '#6b4e8c', '#2d6e78', '#3f7a5c', '#a06a1c', '#8c5a3c'];
const PINNED: Record<string, number> = { exactonline: 0, odoo: 1 };

export function sourceColor(index: number): string {
  return SOURCE_COLORS[index % SOURCE_COLORS.length];
}

/**
 * Assign a stable colour index per source.
 *
 * Pinned connectors keep their established hue. Everything else is assigned in
 * source order, skipping indices already taken, so a tenant's sources do not
 * change colour when they connect an unrelated new one.
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
