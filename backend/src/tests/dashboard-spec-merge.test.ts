import { describe, it, expect } from 'vitest';
import {
  hasRemoveIntent,
  restoreDroppedWidgets,
  preserveSpecCarryover,
  diffSpecChanges,
} from '../services/dashboardSpecMerge';
import type { DashboardSpec, WidgetSpec } from '../shared/contract';

const widget = (id: string, over: Partial<WidgetSpec> = {}): WidgetSpec => ({
  id,
  type: 'kpi_card',
  title: `Widget ${id}`,
  sql: `SELECT 1 AS value -- ${id}`,
  ...over,
});

const spec = (widgets: WidgetSpec[], over: Partial<DashboardSpec> = {}): DashboardSpec => ({
  title: 'T',
  description: 'D',
  filters: [],
  widgets,
  ...over,
});

describe('hasRemoveIntent', () => {
  it('fires on English and Dutch remove verbs', () => {
    expect(hasRemoveIntent('remove the pie chart')).toBe(true);
    expect(hasRemoveIntent('verwijder de tabel')).toBe(true);
    expect(hasRemoveIntent('die grafiek weghalen graag')).toBe(true);
    expect(hasRemoveIntent('haal die grafiek weg')).toBe(true);
  });

  it('does NOT fire on unrelated Dutch words containing "weg"', () => {
    // The old \bweg\b guard was disabled by any sentence containing the bare
    // word — including compounds and unrelated uses.
    expect(hasRemoveIntent('toon de omzet onderweg naar de klant')).toBe(false);
    expect(hasRemoveIntent('wegens de vakantie graag per week tonen')).toBe(false);
    expect(hasRemoveIntent('maak er een lijn van')).toBe(false);
  });
});

describe('restoreDroppedWidgets', () => {
  it('restores silently dropped widgets in original order', () => {
    const prev = [widget('a'), widget('b'), widget('c')];
    const refined = [widget('a'), widget('c')];
    const { widgets, restored } = restoreDroppedWidgets(prev, refined, 'make widget a a line chart');
    expect(restored.map((w) => w.id)).toEqual(['b']);
    expect(widgets.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not restore when the user asked to remove', () => {
    const prev = [widget('a'), widget('b')];
    const refined = [widget('a')];
    const { widgets, restored } = restoreDroppedWidgets(prev, refined, 'remove widget b');
    expect(restored).toEqual([]);
    expect(widgets.map((w) => w.id)).toEqual(['a']);
  });

  it('treats a same-title widget under a new id as kept, not dropped', () => {
    const prev = [widget('a', { title: 'Revenue trend' })];
    const refined = [widget('a2', { title: 'Revenue trend' })];
    const { restored } = restoreDroppedWidgets(prev, refined, 'change to a line chart');
    expect(restored).toEqual([]);
  });
});

describe('preserveSpecCarryover', () => {
  it('copies the user layout onto widgets the model returned without one', () => {
    const layout = { x: 3, y: 0, w: 6, h: 4 };
    const prev = spec([widget('a', { layout }), widget('b')]);
    const next = spec([widget('a'), widget('b')]);
    const out = preserveSpecCarryover(prev, next);
    expect(out.widgets[0].layout).toEqual(layout);
    expect(out.widgets[1].layout).toBeUndefined();
  });

  it('the PREVIOUS layout beats anything the model returned — echoed or invented', () => {
    // A layout in the model's output is indistinguishable from one it made up,
    // and an invented layout renders as a silently mangled dashboard (KPI
    // cards squashed to a sliver). The user's arrangement is the only
    // authority; the model's copy is discarded either way.
    const userArranged = { x: 9, y: 9, w: 3, h: 1 };
    const prev = spec([widget('a', { layout: userArranged })]);
    const next = spec([widget('a', { layout: { x: 0, y: 2, w: 12, h: 3 } }), widget('new')]);
    const out = preserveSpecCarryover(prev, next);
    expect(out.widgets[0].layout).toEqual(userArranged);
    expect(out.widgets[1].layout).toBeUndefined();
  });

  it('drops a layout the model invented for a widget the user never arranged', () => {
    const prev = spec([widget('a')]); // no layout: flow placement
    const next = spec([widget('a', { layout: { x: 0, y: 0, w: 2, h: 1 } })]);
    const out = preserveSpecCarryover(prev, next);
    expect(out.widgets[0].layout).toBeUndefined();
  });

  it('inherits productIds and dataLayer, and drops stale insights', () => {
    const prev = spec([widget('a')], {
      productIds: [4, 7],
      dataLayer: 'product',
      insights: { items: ['old observation'], generatedAt: '2026-08-01T00:00:00Z' },
    });
    const next = spec([widget('a')], {
      insights: { items: ['model-echoed observation'], generatedAt: '2026-08-01T00:00:00Z' },
    });
    const out = preserveSpecCarryover(prev, next);
    expect(out.productIds).toEqual([4, 7]);
    expect(out.dataLayer).toBe('product');
    expect(out.insights).toBeUndefined();
  });
});

describe('diffSpecChanges', () => {
  it('reports added, modified and removed widgets by title', () => {
    const prev = spec([
      widget('a', { title: 'Kept' }),
      widget('b', { title: 'Rewritten' }),
      widget('c', { title: 'Gone' }),
    ]);
    const next = spec([
      widget('a', { title: 'Kept' }),
      widget('b', { title: 'Rewritten', sql: 'SELECT 2 AS value' }),
      widget('d', { title: 'Brand new' }),
    ]);
    const changes = diffSpecChanges(prev, next);
    expect(changes.added).toEqual(['Brand new']);
    expect(changes.modified).toEqual(['Rewritten']);
    expect(changes.removed).toEqual(['Gone']);
    expect(changes.filtersChanged).toBe(false);
  });

  it('flags filter changes and reports nothing on an identical spec', () => {
    const base = spec([widget('a')], {
      filters: [{ id: 'f', type: 'select', label: 'L', table: 't', column: 'c' }],
    });
    const same = diffSpecChanges(base, base);
    expect(same.added).toEqual([]);
    expect(same.modified).toEqual([]);
    expect(same.removed).toEqual([]);
    expect(same.filtersChanged).toBe(false);

    const withNewFilter = spec([widget('a')], {
      filters: [
        { id: 'f', type: 'select', label: 'L', table: 't', column: 'c' },
        { id: 'date', type: 'date_range', label: 'Date', table: 't', column: 'd' },
      ],
    });
    expect(diffSpecChanges(base, withNewFilter).filtersChanged).toBe(true);
  });
});
