import { describe, expect, it } from 'vitest';
import { canRemoveWidget, removeWidget, restoreWidget } from '@/app/dashboards/utils/arrange';
import type { DashboardSpec, WidgetSpec } from '@/app/dashboards/types';

const w = (id: string, layout?: WidgetSpec['layout']): WidgetSpec =>
  ({ id, type: 'bar_chart', title: `Card ${id}`, sql: `SELECT 1 AS "${id}"`, ...(layout ? { layout } : {}) }) as WidgetSpec;

const spec = (widgets: WidgetSpec[]): DashboardSpec =>
  ({ title: 'T', description: '', filters: [], widgets }) as unknown as DashboardSpec;

describe('removing a card in Arrange mode', () => {
  it('removes exactly the card asked for and keeps the order of the rest', () => {
    const s = spec([w('a'), w('b'), w('c')]);
    const out = removeWidget(s, 'b');
    expect(out?.spec.widgets.map((x) => x.id)).toEqual(['a', 'c']);
    expect(out?.removed.widget.id).toBe('b');
    expect(out?.removed.index).toBe(1);
    // The input spec is not mutated.
    expect(s.widgets.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('never removes the last card', () => {
    const s = spec([w('only')]);
    expect(canRemoveWidget(s)).toBe(false);
    expect(removeWidget(s, 'only')).toBeNull();
    expect(canRemoveWidget(null)).toBe(false);
  });

  it('does nothing for a card that is not on the dashboard', () => {
    expect(removeWidget(spec([w('a'), w('b')]), 'zzz')).toBeNull();
  });
});

describe('Undo puts the card back where it was', () => {
  it('restores the list position and the grid placement', () => {
    const s = spec([w('a', { x: 0, y: 0, w: 6, h: 4 }), w('b', { x: 6, y: 0, w: 6, h: 4 }), w('c', { x: 0, y: 4, w: 12, h: 4 })]);
    const out = removeWidget(s, 'b')!;
    const back = restoreWidget(out.spec, out.removed);
    expect(back.widgets.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(back.widgets[1].layout).toEqual({ x: 6, y: 0, w: 6, h: 4 });
  });

  it('undoes the compaction the removal caused in the other cards', () => {
    const s = spec([w('a', { x: 0, y: 0, w: 12, h: 4 }), w('b', { x: 0, y: 4, w: 12, h: 4 })]);
    const out = removeWidget(s, 'a')!;
    // The grid compacts upward once 'a' is gone and persists the move.
    const compacted = spec(out.spec.widgets.map((x) => ({ ...x, layout: { x: 0, y: 0, w: 12, h: 4 } })));
    const back = restoreWidget(compacted, out.removed);
    expect(back.widgets.map((x) => [x.id, x.layout?.y])).toEqual([['a', 0], ['b', 4]]);
  });

  it('keeps every other change made in the meantime — only placements are restored', () => {
    const s = spec([w('a', { x: 0, y: 0, w: 6, h: 4 }), w('b', { x: 6, y: 0, w: 6, h: 4 })]);
    const out = removeWidget(s, 'a')!;
    const edited = spec(out.spec.widgets.map((x) => ({ ...x, sql: 'SELECT 2 AS edited' })));
    const back = restoreWidget(edited, out.removed);
    expect(back.widgets.find((x) => x.id === 'b')?.sql).toBe('SELECT 2 AS edited');
  });

  it('clears a placement the card did not have before, and leaves cards added since alone', () => {
    const s = spec([w('a'), w('b')]);
    const out = removeWidget(s, 'a')!;
    const later = spec([
      { ...out.spec.widgets[0], layout: { x: 0, y: 0, w: 12, h: 3 } },
      w('new', { x: 0, y: 3, w: 6, h: 3 }),
    ]);
    const back = restoreWidget(later, out.removed);
    expect(back.widgets.map((x) => x.id)).toEqual(['a', 'b', 'new']);
    expect(back.widgets.find((x) => x.id === 'b')?.layout).toBeUndefined();
    expect(back.widgets.find((x) => x.id === 'new')?.layout).toEqual({ x: 0, y: 3, w: 6, h: 3 });
  });

  it('is a no-op when the card is already back', () => {
    const s = spec([w('a'), w('b')]);
    const out = removeWidget(s, 'b')!;
    const once = restoreWidget(out.spec, out.removed);
    expect(restoreWidget(once, out.removed)).toBe(once);
  });

  it('clamps the position when the list has shrunk since', () => {
    const s = spec([w('a'), w('b'), w('c')]);
    const out = removeWidget(s, 'c')!;
    const shrunk = spec([out.spec.widgets[0]]);
    expect(restoreWidget(shrunk, out.removed).widgets.map((x) => x.id)).toEqual(['a', 'c']);
  });
});
