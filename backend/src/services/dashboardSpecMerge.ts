/**
 * Pure spec-merge helpers for the dashboard refine path.
 *
 * A refinement is a FULL-SPEC regeneration: the model returns a complete
 * replacement DashboardSpec. That makes three deterministic guards necessary,
 * and they live here (not inline in AIService / the route) so they are
 * unit-testable without an AI call or a database:
 *
 *  - restoreDroppedWidgets: the model sometimes silently drops widgets it was
 *    told to keep. Unless the user's request contains an explicit
 *    remove-intent, every missing widget is restored in its original order.
 *  - preserveSpecCarryover: app-managed spec fields the model has no business
 *    changing (user-arranged `layout`, `productIds`, `dataLayer`) are copied
 *    from the previous spec; stale `insights` are dropped (they describe the
 *    pre-refine dashboard, and the AI summary only regenerates on an explicit
 *    user trigger).
 *  - diffSpecChanges: what actually changed, by widget title, so the frontend
 *    can say "Changed 'Revenue trend' · added 'Orders by region'" instead of a
 *    bare "Dashboard updated".
 */

import type { DashboardSpec, WidgetSpec } from '../shared/contract';

// Explicit remove-intent. Word-bounded; the Dutch separable verb "weghalen"
// is matched as the infinitive OR the split form ("haal die grafiek weg") —
// a bare \bweg\b would also fire on unrelated words in sentences like
// "verplaats de grafiek onderweg" and silently disable the restore net.
const REMOVE_INTENT_RE =
  /\b(remove|delete|drop|get rid of|hide|verwijder|verberg|weghalen)\b|\bhaal\b[^.!?]*\bweg\b/i;

export function hasRemoveIntent(refinement: string): boolean {
  return REMOVE_INTENT_RE.test(refinement);
}

/**
 * Restore widgets the model silently dropped. Match by id first, then by
 * lowercased title (the model sometimes regenerates a widget under a new id).
 * Skipped entirely when the refinement expresses remove-intent — then a
 * missing widget is presumed deliberate.
 */
export function restoreDroppedWidgets(
  prevWidgets: WidgetSpec[],
  refinedWidgets: WidgetSpec[],
  refinement: string,
): { widgets: WidgetSpec[]; restored: WidgetSpec[] } {
  if (hasRemoveIntent(refinement)) return { widgets: refinedWidgets, restored: [] };

  const refinedIds = new Set(refinedWidgets.map((w) => w.id));
  const refinedTitles = new Set(refinedWidgets.map((w) => w.title.toLowerCase().trim()));
  const missing = prevWidgets.filter(
    (w) => !refinedIds.has(w.id) && !refinedTitles.has(w.title.toLowerCase().trim()),
  );
  if (missing.length === 0) return { widgets: refinedWidgets, restored: [] };

  const originalOrder = new Map(prevWidgets.map((w, i) => [w.id, i]));
  const merged = [...refinedWidgets, ...missing];
  merged.sort((a, b) => (originalOrder.get(a.id) ?? 999) - (originalOrder.get(b.id) ?? 999));
  return { widgets: merged, restored: missing };
}

/**
 * Carry app-managed fields across a full-spec regeneration.
 *
 * - `layout` (user-arranged placement) is copied onto every widget the model
 *   kept but returned without one. Prompt rules ask the model to echo layout
 *   verbatim, but the guarantee lives here, deterministically. New widgets
 *   stay layout-less on purpose — the renderer places them below the arranged
 *   ones.
 * - `productIds` / `dataLayer` are context, not content: the model never sets
 *   them, so they are inherited from the previous spec when absent.
 * - `insights` are dropped: they describe the previous dashboard, and the
 *   summary regenerates only on an explicit user trigger (never per-open).
 */
export function preserveSpecCarryover(prev: DashboardSpec, next: DashboardSpec): DashboardSpec {
  const prevById = new Map(prev.widgets.map((w) => [w.id, w]));
  const widgets = next.widgets.map((w) => {
    const before = prevById.get(w.id);
    if (before?.layout && !w.layout) return { ...w, layout: before.layout };
    return w;
  });
  const out: DashboardSpec = { ...next, widgets };
  if (out.productIds === undefined && prev.productIds !== undefined) out.productIds = prev.productIds;
  if (out.dataLayer === undefined && prev.dataLayer !== undefined) out.dataLayer = prev.dataLayer;
  delete out.insights;
  return out;
}

export interface SpecChanges {
  /** Titles of widgets that exist now but did not before. */
  added: string[];
  /** Titles of widgets whose sql, type or title changed. */
  modified: string[];
  /** Titles of widgets that existed before and are gone now. */
  removed: string[];
  /** True when the filter list changed (ids or columns). */
  filtersChanged: boolean;
}

/** Widget-title level diff between two specs, for the "what changed" reply. */
export function diffSpecChanges(prev: DashboardSpec, next: DashboardSpec): SpecChanges {
  const prevById = new Map(prev.widgets.map((w) => [w.id, w]));
  const nextIds = new Set(next.widgets.map((w) => w.id));

  const added: string[] = [];
  const modified: string[] = [];
  for (const w of next.widgets) {
    const before = prevById.get(w.id);
    if (!before) added.push(w.title);
    else if (before.sql !== w.sql || before.type !== w.type || before.title !== w.title) {
      modified.push(w.title);
    }
  }
  const removed = prev.widgets.filter((w) => !nextIds.has(w.id)).map((w) => w.title);

  const filterKey = (s: DashboardSpec) =>
    JSON.stringify(s.filters.map((f) => [f.id, f.type, f.table, f.column]));
  return { added, modified, removed, filtersChanged: filterKey(prev) !== filterKey(next) };
}
