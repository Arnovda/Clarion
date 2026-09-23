/**
 * Removing a card in Arrange mode — and putting it back.
 *
 * Pure, so the rules that matter are pinned by test rather than by clicking:
 *
 *   • A dashboard never loses its last card. An empty dashboard is a dead page
 *     with nothing to rearrange; deleting the dashboard is the honest act.
 *   • Undo puts the card back exactly where it was — same position in the
 *     list (the flow layout and the email report follow list order) and the
 *     same place on the grid.
 *
 * The second rule needs more than the removed card's own placement. The
 * grid compacts upward the moment a card leaves, so its neighbours move into
 * the gap and those moves are persisted like any other arrangement. Putting
 * the card back at its old coordinates would land it on top of them and the
 * compactor would push it somewhere else. So a removal remembers every
 * other card's placement as it was, and Undo restores those too.
 *
 * Only placements are restored, never anything else: if a card's query was
 * changed between the removal and the Undo (a refine, a fix), that change is
 * kept. The page withdraws the Undo as soon as the user moves or resizes a
 * card themselves, because from then on "as it was" is no longer what they
 * would expect.
 */
import type { DashboardSpec, WidgetSpec } from '../types';

type Placement = NonNullable<WidgetSpec['layout']>;

export interface RemovedWidget {
  widget: WidgetSpec;
  /** Position in spec.widgets before the removal. */
  index: number;
  /** Every other card's placement just before the removal; null = had none. */
  placementsBefore: Record<string, Placement | null>;
}

/** Whether a card may be removed from this dashboard at all. */
export function canRemoveWidget(spec: Pick<DashboardSpec, 'widgets'> | null | undefined): boolean {
  return !!spec && spec.widgets.length > 1;
}

/**
 * Remove one card. Returns null when the card is not on the dashboard or
 * when it is the last one — both mean "nothing to do", never a half-applied
 * change.
 */
export function removeWidget(
  spec: DashboardSpec,
  widgetId: string,
): { spec: DashboardSpec; removed: RemovedWidget } | null {
  if (!canRemoveWidget(spec)) return null;
  const index = spec.widgets.findIndex((w) => w.id === widgetId);
  if (index < 0) return null;

  const placementsBefore: Record<string, Placement | null> = {};
  for (const w of spec.widgets) {
    if (w.id !== widgetId) placementsBefore[w.id] = w.layout ? { ...w.layout } : null;
  }
  return {
    spec: { ...spec, widgets: spec.widgets.filter((w) => w.id !== widgetId) },
    removed: { widget: spec.widgets[index], index, placementsBefore },
  };
}

/**
 * Put a removed card back. A no-op when it is already there (a double Undo
 * must not duplicate it). Cards added since the removal keep their own
 * placement; they were not part of the picture Undo restores.
 */
export function restoreWidget(spec: DashboardSpec, removed: RemovedWidget): DashboardSpec {
  if (spec.widgets.some((w) => w.id === removed.widget.id)) return spec;

  const widgets = spec.widgets.map((w) => {
    if (!(w.id in removed.placementsBefore)) return w;
    const before = removed.placementsBefore[w.id];
    if (before) return { ...w, layout: { ...before } };
    if (!w.layout) return w;
    const next = { ...w };
    delete next.layout;
    return next;
  });

  const at = Math.min(Math.max(removed.index, 0), widgets.length);
  return { ...spec, widgets: [...widgets.slice(0, at), removed.widget, ...widgets.slice(at)] };
}
