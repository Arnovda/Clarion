// ─── refineCarryover.ts ───────────────────────────────────────────────────────
// What survives a dashboard refinement, on the CLIENT side.
//
// A refinement returns a rebuilt spec. The server already protects the fields
// the model has no business changing (layout, productIds, dataLayer — see
// backend/src/services/dashboardSpecMerge.ts). These two helpers protect the
// things that never reach the server at all, because they are live view state:
// the filter values the user has selected, and the rows already on screen.
//
// Both were being discarded wholesale on every edit, and the first one was the
// reason a refinement could turn a working dashboard into a screen of €0,00.

import type { DashboardSpec, FilterSpec, WidgetSpec } from '../types';
import type { WidgetData } from '../types';
import { buildDefaultFilters } from './format';

/**
 * Merge the filter values a user is CURRENTLY looking at onto the defaults of
 * a refined spec.
 *
 * The naive follow-up to a refine — `buildDefaultFilters(newSpec.filters)` —
 * silently discarded the window the user had chosen. Concretely: a dashboard
 * opened on 01/01/2024 snapped back to the last-12-months default the moment
 * the user asked for an unrelated change, so every widget re-queried a window
 * with no data in it and the whole dashboard read €0,00 / "no data available".
 * The user asked to slice by customer; they got an empty screen, and nothing
 * on it said the date range was the cause.
 *
 * The rule: a filter that SURVIVED the refinement keeps whatever value the
 * user had on screen. Only genuinely NEW filters take a default — that is the
 * one case where there is no user choice to preserve. A filter whose column or
 * type changed counts as new, because the old value answers a different
 * question (a customer name is not a valid value for an item-group filter).
 *
 * `defaultValue` on a select filter is deliberately not allowed to override a
 * live value either: the model sets it when the user asked to focus on one
 * value, and if THIS refinement is that request then the filter is new anyway.
 */
export function carryFilterValues(
  prevFilters: FilterSpec[],
  nextFilters: FilterSpec[],
  liveValues: Record<string, string>,
): Record<string, string> {
  const defaults = buildDefaultFilters(nextFilters);
  const prevById = new Map(prevFilters.map((f) => [f.id, f]));

  for (const f of nextFilters) {
    const before = prevById.get(f.id);
    // New filter, or one repointed at a different column/type: take the default.
    if (!before || before.type !== f.type || before.column !== f.column) continue;

    if (f.type === 'date_range') {
      const from = liveValues[`${f.id}_from`];
      const to = liveValues[`${f.id}_to`];
      if (from) defaults[`${f.id}_from`] = from;
      if (to) defaults[`${f.id}_to`] = to;
    } else {
      const v = liveValues[f.id];
      if (v) defaults[f.id] = v;
    }
  }

  return defaults;
}

/**
 * True when moving from filter values `prev` to `next` can change the result
 * of a widget whose SQL did NOT change.
 *
 * A key that is NEW in `next` cannot: an unchanged SQL statement never
 * mentions its placeholder (only widgets that gained the predicate do, and the
 * SQL diff drops those from the cache anyway). What does invalidate everything
 * is an EXISTING key whose value moved, or a key that disappeared — either way
 * a placeholder an unchanged widget may reference now resolves differently.
 */
function filterValuesDiffer(
  prev: Record<string, string>,
  next: Record<string, string>,
): boolean {
  for (const k of Object.keys(prev)) if (prev[k] !== (next[k] ?? undefined)) return true;
  return false;
}

/**
 * Drop from the widget-row cache exactly the widgets whose results a
 * refinement can have changed — mutates `cache` in place.
 *
 * A widget whose SQL came back byte-identical, under filter values that also
 * did not move, still holds correct rows: keeping them means it renders its
 * real numbers with a revalidating pulse instead of collapsing to a skeleton.
 * Wiping the whole cache (the previous behaviour) meant an edit to one card
 * blanked all twelve, which is most of why a small refinement felt like a
 * rebuild.
 *
 * Conservative in the direction that matters: any change to the filter VALUES
 * invalidates everything, because every widget's SQL is resolved against them.
 */
export function dropChangedFromCache(
  cache: Record<string, WidgetData>,
  prevWidgets: WidgetSpec[],
  nextWidgets: WidgetSpec[],
  prevFilterValues: Record<string, string>,
  nextFilterValues: Record<string, string>,
): void {
  if (filterValuesDiffer(prevFilterValues, nextFilterValues)) {
    for (const k of Object.keys(cache)) delete cache[k];
    return;
  }
  const prevById = new Map(prevWidgets.map((w) => [w.id, w]));
  for (const w of nextWidgets) {
    const before = prevById.get(w.id);
    if (!before || before.sql !== w.sql || before.type !== w.type) delete cache[w.id];
  }
  // Rows of widgets the refinement removed are dead weight.
  const nextIds = new Set(nextWidgets.map((w) => w.id));
  for (const id of Object.keys(cache)) if (!nextIds.has(id)) delete cache[id];
}

/** Convenience wrapper: both carryovers for one refined spec. */
export function applyRefineCarryover(
  prevSpec: DashboardSpec,
  nextSpec: DashboardSpec,
  liveValues: Record<string, string>,
  cache: Record<string, WidgetData>,
): Record<string, string> {
  const nextValues = carryFilterValues(prevSpec.filters, nextSpec.filters, liveValues);
  dropChangedFromCache(cache, prevSpec.widgets, nextSpec.widgets, liveValues, nextValues);
  return nextValues;
}
