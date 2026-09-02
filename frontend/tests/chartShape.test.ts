import { describe, it, expect } from 'vitest';
import { resolveChartShape, MAX_SERIES } from '../app/query/chartShape';

/** The production answer: cumulative purchase cost per supplier, one row per (month, supplier). */
function cumulativeRows(suppliers: string[], months = 64) {
  const rows: Record<string, unknown>[] = [];
  for (let m = 0; m < months; m++) {
    const ym = `${2020 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
    for (const s of suppliers) rows.push({ month: ym, supplier_name: s, cumulative_cost: (m + 1) * 100 });
  }
  return rows;
}

describe('resolveChartShape', () => {
  it('turns "cumulative per supplier" into one line per supplier over months — even when the hint put the supplier on x', () => {
    const rows = cumulativeRows(['Terrie sprl', 'Ciconoco Sa', 'Telecom Nv']);
    expect(rows).toHaveLength(192);
    const s = resolveChartShape(rows, { type: 'line', xKey: 'supplier_name', yKey: 'cumulative_cost' });
    expect(s.type).toBe('line');
    expect(s.xKey).toBe('month');
    expect(s.seriesKey).toBe('supplier_name');
    expect(s.groups).toEqual(['Terrie sprl', 'Ciconoco Sa', 'Telecom Nv']);
    expect(s.data).toHaveLength(64);                 // one row per month, not 192
    expect(s.data[0]).toMatchObject({ month: '2020-01', 'Terrie sprl': 100, 'Ciconoco Sa': 100, 'Telecom Nv': 100 });
    expect(s.data[63].month).toBe('2025-04');       // sorted by period
  });

  it('detects the series column itself when the hint omits groupBy', () => {
    const rows = cumulativeRows(['A', 'B']);
    const s = resolveChartShape(rows, { type: 'line', xKey: 'month', yKey: 'cumulative_cost' });
    expect(s.seriesKey).toBe('supplier_name');
    expect(s.groups).toEqual(['A', 'B']);
    expect(s.data).toHaveLength(64);
  });

  it('honours an explicit groupBy', () => {
    const rows = cumulativeRows(['A', 'B']);
    const s = resolveChartShape(rows, { type: 'line', xKey: 'month', yKey: 'cumulative_cost', groupBy: 'supplier_name' });
    expect(s.seriesKey).toBe('supplier_name');
    expect(s.xKey).toBe('month');
  });

  it('never cycles the palette: a hinted groupBy wider than the slots → no series chart', () => {
    // Detection already refuses a wide category; the hint path is the one that
    // can reach the cap — the model names groupBy directly. That is the case
    // the cap exists for, so that is what this test drives.
    const many = Array.from({ length: MAX_SERIES + 1 }, (_, i) => `Supplier ${i}`);
    const s = resolveChartShape(cumulativeRows(many, 6), { type: 'line', xKey: 'month', yKey: 'cumulative_cost', groupBy: 'supplier_name' });
    expect(s.seriesKey).toBeUndefined();
    expect(s.groups).toEqual([]);
    expect(s.data).toHaveLength(6 * many.length);   // untouched long rows
  });

  it('leaves a plain single-series ranking exactly as before', () => {
    const rows = [
      { customer_name: 'Acme', total_revenue: 900 },
      { customer_name: 'Beta', total_revenue: 400 },
    ];
    const s = resolveChartShape(rows, { type: 'bar', xKey: 'customer_name', yKey: 'total_revenue' });
    expect(s.type).toBe('bar');
    expect(s.seriesKey).toBeUndefined();
    expect(s.data).toBe(rows);
  });

  it('a category × category breakdown stays a stacked bar, not a line', () => {
    const rows = [
      { region: 'North', status: 'open', order_count: 3 },
      { region: 'North', status: 'closed', order_count: 5 },
      { region: 'South', status: 'open', order_count: 2 },
      { region: 'South', status: 'closed', order_count: 7 },
    ];
    const s = resolveChartShape(rows);
    expect(s.type).toBe('stacked_bar');
    expect(s.xKey).toBe('region');
    expect(s.seriesKey).toBe('status');
    expect(s.data).toHaveLength(2);
  });

  it('two candidate category columns is ambiguous → no series is guessed', () => {
    const rows = [
      { month: '2024-01', region: 'N', status: 'open', order_count: 1 },
      { month: '2024-01', region: 'S', status: 'closed', order_count: 2 },
      { month: '2024-02', region: 'N', status: 'closed', order_count: 3 },
    ];
    const s = resolveChartShape(rows, { type: 'line', xKey: 'month', yKey: 'order_count' });
    expect(s.seriesKey).toBeUndefined();
  });

  it('a long single-series time series still charts (time on x is readable at any length)', () => {
    const rows = Array.from({ length: 90 }, (_, i) => ({ date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, revenue: i }));
    const s = resolveChartShape(rows);
    expect(s.type).toBe('line');
  });
});
