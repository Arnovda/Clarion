/**
 * Readability gate — pure-function tests. No DB, no DuckDB, no model.
 *
 * Every rule in services/widgetReadability.ts is pinned in BOTH directions:
 * the shape that is unreadable fires, the shape that is fine does not. The
 * thresholds are read from READABILITY_LIMITS rather than retyped, so a
 * renderer-driven change to a limit moves the tests with it.
 */
import { describe, it, expect } from 'vitest';
import {
  READABILITY_LIMITS as L,
  profileRows,
  assessReadability,
  applyReadabilityFixes,
  readabilityIssueText,
  readabilityNoteText,
  isPeriodLabel,
} from '../services/widgetReadability';
import type { WidgetSpec } from '../shared/contract';

const widget = (over: Partial<WidgetSpec>): WidgetSpec => ({
  id: 'w1', type: 'bar_chart', title: 'Revenue by customer', sql: 'SELECT 1', ...over,
});

const labelValue = (n: number, label: (i: number) => unknown = (i) => `Customer ${i}`, value: (i: number) => unknown = (i) => 1000 - i) =>
  Array.from({ length: n }, (_, i) => ({ label: label(i), value: value(i) }));

const months = (n: number) => labelValue(n, (i) => `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, (i) => 100 + i);

const codes = (w: WidgetSpec, rows: Record<string, unknown>[]) => assessReadability(w, profileRows(rows)).map((f) => f.code);

describe('profileRows', () => {
  it('counts distinct values, lengths, numeric shape, years and timestamps per column', () => {
    const p = profileRows([
      { label: 'A', value: 2025, when: new Date('2025-01-01T00:00:00Z') },
      { label: 'A', value: -3.5, when: '2025-02-01T00:00:00.000Z' },
      { label: 'Bravo', value: null, when: null },
    ]);
    expect(p.rowCount).toBe(3);
    const label = p.columns.find((c) => c.key === 'label')!;
    expect(label.distinct).toBe(2);
    expect(label.maxLen).toBe(5);
    expect(label.longest).toBe('Bravo');
    const value = p.columns.find((c) => c.key === 'value')!;
    expect(value.nonNull).toBe(2);
    expect(value.numeric).toBe(2);
    expect(value.integer).toBe(1);
    expect(value.yearLike).toBe(1);
    expect(value.negative).toBe(1);
    expect(value.min).toBe(-3.5);
    expect(value.max).toBe(2025);
    const when = p.columns.find((c) => c.key === 'when')!;
    expect(when.isoTimestamp).toBe(2); // a Date instance AND an ISO string both count
  });

  it('tracks whether values are in order — a ranking must be', () => {
    expect(profileRows(labelValue(5)).columns[1].monotonic).toBe('desc');
    expect(profileRows(labelValue(5, undefined, (i) => i)).columns[1].monotonic).toBe('asc');
    expect(profileRows(labelValue(5, undefined, (i) => [3, 9, 1, 7, 2][i])).columns[1].monotonic).toBe('none');
    expect(profileRows(labelValue(3, undefined, () => 4)).columns[1].monotonic).toBe('flat');
  });

  it('counts distinct (label, series) pairs so duplicates are visible', () => {
    const p = profileRows([
      { label: '2025-01', series: 'A', value: 1 },
      { label: '2025-01', series: 'A', value: 2 },
      { label: '2025-01', series: 'B', value: 3 },
    ]);
    expect(p.labelSeriesPairs).toBe(2);
    expect(p.scanned).toBe(3);
  });

  it('keeps the true row count while bounding the scan', () => {
    const p = profileRows(labelValue(L.PROFILE_MAX_ROWS + 5));
    expect(p.rowCount).toBe(L.PROFILE_MAX_ROWS + 5);
    expect(p.scanned).toBe(L.PROFILE_MAX_ROWS);
  });

  it('is empty-safe', () => {
    expect(profileRows([])).toMatchObject({ rowCount: 0, scanned: 0, columns: [] });
  });
});

describe('isPeriodLabel', () => {
  it('recognises the period shapes the prompts emit, in English and Dutch', () => {
    for (const s of ['2025', '2025-01', '2025-01-31', '01/2025', '31-01-2025', '2025-Q1', 'Q1 2025', 'H1 2025', '2025-W12', 'Week 3', 'Jan 2025', 'jan-25', 'mrt', 'oktober 2025', '2025 Jan', '2025-01-01T00:00:00.000Z']) {
      expect(isPeriodLabel(s), s).toBe(true);
    }
  });
  it('does not mistake names for periods', () => {
    for (const s of ['Terrie sprl', 'Van Damme BVBA', 'North', 'Q-Park', 'May Ltd', '']) {
      expect(isPeriodLabel(s), s).toBe(false);
    }
  });
});

describe('assessReadability — pie', () => {
  it('a pie with more slices than the prompt allows becomes a horizontal bar (the old inline rule, now here)', () => {
    const f = assessReadability(widget({ type: 'pie_chart' }), profileRows(labelValue(L.PIE_MAX_SLICES + 1)));
    expect(f.map((x) => x.code)).toEqual(['pie_too_many_slices']);
    expect(f[0].fix).toEqual({ kind: 'set_type', type: 'bar_chart' });
  });
  it('a pie within the limit passes', () => {
    expect(codes(widget({ type: 'pie_chart' }), labelValue(L.PIE_MAX_SLICES))).toEqual([]);
  });
  it('a pie cannot show negative values', () => {
    expect(codes(widget({ type: 'pie_chart' }), labelValue(3, undefined, (i) => [5, -2, 3][i]))).toEqual(['pie_negative']);
  });
  it('a pie where one slice is the whole pie is not a pie', () => {
    expect(codes(widget({ type: 'pie_chart' }), labelValue(3, undefined, (i) => [9800, 1, 1][i]))).toEqual(['pie_dominant']);
    expect(codes(widget({ type: 'pie_chart' }), labelValue(3, undefined, (i) => [60, 30, 10][i]))).toEqual([]);
  });
});

describe('assessReadability — bars and lines', () => {
  it('too many horizontal bars → top-N + Other, with the SQL pattern in the instruction', () => {
    const f = assessReadability(widget({ type: 'bar_chart' }), profileRows(labelValue(L.BAR_MAX_CATEGORIES + 1)));
    expect(f.map((x) => x.code)).toEqual(['too_many_categories']);
    expect(f[0].fix.kind).toBe('sql');
    expect((f[0].fix as { instruction: string }).instruction).toContain("'Other'");
    expect((f[0].fix as { instruction: string }).instruction).toContain('ROW_NUMBER()');
    expect(codes(widget({ type: 'bar_chart' }), labelValue(L.BAR_MAX_CATEGORIES))).toEqual([]);
  });

  it('names on a vertical bar axis → horizontal bar (no model needed)', () => {
    const f = assessReadability(widget({ type: 'vertical_bar_chart' }), profileRows(labelValue(L.VBAR_MAX_CATEGORICAL + 1)));
    expect(f.map((x) => x.code)).toEqual(['categorical_on_vertical']);
    expect(f[0].fix).toEqual({ kind: 'set_type', type: 'bar_chart' });
    // long names trip it even with few bars
    expect(codes(widget({ type: 'vertical_bar_chart' }), labelValue(4, (i) => `Van Damme Bouwmaterialen ${i}`))).toEqual(['categorical_on_vertical']);
    // short names, few bars: fine
    expect(codes(widget({ type: 'vertical_bar_chart' }), labelValue(4, (i) => ['North', 'South', 'East', 'West'][i]))).toEqual([]);
  });

  it('months on a vertical bar are fine up to three years, then a line', () => {
    expect(codes(widget({ type: 'vertical_bar_chart' }), months(L.VBAR_MAX_PERIODS))).toEqual([]);
    const f = assessReadability(widget({ type: 'vertical_bar_chart' }), profileRows(months(L.VBAR_MAX_PERIODS + 1)));
    expect(f.map((x) => x.code)).toEqual(['too_many_periods']);
    expect(f[0].fix).toEqual({ kind: 'set_type', type: 'line_chart' });
  });

  it('a combo chart with the same overflow gets a SQL fix, because a line would lose its overlay', () => {
    const f = assessReadability(widget({ type: 'combo_chart' }), profileRows(months(L.VBAR_MAX_PERIODS + 1)));
    expect(f[0].code).toBe('too_many_periods');
    expect(f[0].fix.kind).toBe('sql');
  });

  it('a line with a series column is the interleaved zigzag — becomes a stacked bar when the series fit the palette', () => {
    const rows = [];
    for (const m of ['2025-01', '2025-02', '2025-03']) for (const s of ['A', 'B', 'C']) rows.push({ label: m, series: s, value: 10 });
    const f = assessReadability(widget({ type: 'line_chart' }), profileRows(rows));
    expect(f.map((x) => x.code)).toEqual(['series_on_line']);
    expect(f[0].fix).toEqual({ kind: 'set_type', type: 'stacked_bar_chart' });
  });

  it('a line with more series than colours needs SQL', () => {
    const rows = [];
    for (const m of ['2025-01', '2025-02']) for (let s = 0; s < L.STACKED_MAX_SERIES + 1; s++) rows.push({ label: m, series: `S${s}`, value: 1 });
    const f = assessReadability(widget({ type: 'line_chart' }), profileRows(rows));
    expect(f[0].code).toBe('series_on_line');
    expect(f[0].fix.kind).toBe('sql');
  });

  it('a one-point line, and a line over names', () => {
    expect(codes(widget({ type: 'line_chart' }), months(1))).toEqual(['single_point']);
    expect(codes(widget({ type: 'line_chart' }), months(2))).toEqual([]);
    const f = assessReadability(widget({ type: 'line_chart' }), profileRows(labelValue(5)));
    expect(f.map((x) => x.code)).toEqual(['categorical_on_line']);
    expect(f[0].fix).toEqual({ kind: 'set_type', type: 'bar_chart' });
  });

  it('a line over plain years or week numbers is a time axis, not names', () => {
    expect(codes(widget({ type: 'line_chart' }), labelValue(5, (i) => 2021 + i))).toEqual([]);
    expect(codes(widget({ type: 'line_chart' }), labelValue(5, (i) => `W${i + 1}`))).toEqual([]);
  });

  it('a top list that is not ordered is not a ranking', () => {
    expect(codes(widget({ type: 'top_list' }), labelValue(5, undefined, (i) => [3, 9, 1, 7, 2][i]))).toEqual(['unsorted_ranking']);
    expect(codes(widget({ type: 'top_list' }), labelValue(5))).toEqual([]);
    expect(codes(widget({ type: 'top_list' }), labelValue(5, undefined, (i) => i))).toEqual([]); // bottom-N is a ranking too
  });
});

describe('assessReadability — the defects any chart can have', () => {
  it('duplicate labels are a missing GROUP BY column', () => {
    const rows = [...labelValue(4), { label: 'Customer 1', value: 5 }];
    const f = assessReadability(widget({ type: 'bar_chart' }), profileRows(rows));
    expect(f.map((x) => x.code)).toEqual(['duplicate_labels']);
    expect(f[0].fix.kind).toBe('sql');
  });

  it('raw timestamps on the axis → strftime in SQL', () => {
    const rows = labelValue(6, (i) => new Date(Date.UTC(2025, i, 1)), (i) => i);
    const f = assessReadability(widget({ type: 'line_chart', title: 'Monthly orders' }), profileRows(rows));
    expect(f.map((x) => x.code)).toContain('raw_timestamps');
    const fix = f.find((x) => x.code === 'raw_timestamps')!.fix as { instruction: string };
    expect(fix.instruction).toContain('strftime');
  });

  it('labels longer than the limit want a shorter identifying column', () => {
    const rows = labelValue(3, (i) => `Some very long descriptive label that is really a sentence number ${i}`);
    expect(codes(widget({ type: 'bar_chart' }), rows)).toEqual(['long_labels']);
  });

  it('a chart whose values are all NULL has nothing to draw', () => {
    expect(codes(widget({ type: 'bar_chart' }), labelValue(3, undefined, () => null))).toEqual(['all_null']);
  });

  it('zero rows is the validity pass\'s finding, not this one\'s', () => {
    expect(assessReadability(widget({ type: 'bar_chart' }), profileRows([]))).toEqual([]);
  });

  it('a widget missing its contract columns is left to the contract check', () => {
    expect(codes(widget({ type: 'bar_chart' }), [{ customer: 'A', revenue: 1 }])).toEqual([]);
  });
});

describe('assessReadability — format inference (the "€450,00 orders" class)', () => {
  it('a count with no format and values ≥ 100 would render as euros → format number', () => {
    const f = assessReadability(widget({ type: 'vertical_bar_chart', title: 'Orders per month' }), profileRows(months(12).map((r, i) => ({ ...r, value: 120 + i }))));
    expect(f.map((x) => x.code)).toEqual(['count_as_currency']);
    expect(f[0].fix).toEqual({ kind: 'set_format', format: 'number' });
  });
  it('… but not when the title is about money, when a format is set, or when values are decimals', () => {
    expect(codes(widget({ type: 'vertical_bar_chart', title: 'Order value per month' }), months(12).map((r) => ({ ...r, value: 1200 })))).toEqual([]);
    expect(codes(widget({ type: 'vertical_bar_chart', title: 'Orders per month', format: 'number' }), months(12).map((r) => ({ ...r, value: 1200 })))).toEqual([]);
    expect(codes(widget({ type: 'vertical_bar_chart', title: 'Orders per month' }), months(12).map((r) => ({ ...r, value: 1200.5 })))).toEqual([]);
    // small counts never hit the € heuristic, so nothing to fix
    expect(codes(widget({ type: 'vertical_bar_chart', title: 'Orders per month' }), months(12).map((r) => ({ ...r, value: 12 })))).toEqual([]);
  });
  it('a rate with no format → percentage', () => {
    const f = assessReadability(widget({ type: 'kpi_card', title: 'Gross margin %' }), profileRows([{ value: 43.2 }]));
    expect(f.map((x) => x.code)).toEqual(['rate_as_currency']);
    expect(f[0].fix).toEqual({ kind: 'set_format', format: 'percentage' });
  });
});

describe('assessReadability — KPI, stacked, table, pivot, small types', () => {
  it('a KPI whose query returns many rows shows only the first', () => {
    const f = assessReadability(widget({ type: 'kpi_card', title: 'Total revenue' }), profileRows(labelValue(12)));
    expect(f.map((x) => x.code)).toEqual(['kpi_many_rows']);
    expect(codes(widget({ type: 'kpi_card', title: 'Total revenue' }), [{ value: 1 }])).toEqual([]);
    expect(codes(widget({ type: 'kpi_card', title: 'Total revenue' }), [{ value: null }])).toEqual(['all_null']);
  });

  it('a stacked bar with more series than colours, and with duplicate pairs', () => {
    const rows = [];
    for (const m of ['2025-01', '2025-02']) for (let s = 0; s < L.STACKED_MAX_SERIES + 1; s++) rows.push({ label: m, series: `S${s}`, value: 1 });
    expect(codes(widget({ type: 'stacked_bar_chart' }), rows)).toEqual(['too_many_series']);
    const fine = [];
    for (const m of ['2025-01', '2025-02']) for (let s = 0; s < L.STACKED_MAX_SERIES; s++) fine.push({ label: m, series: `S${s}`, value: 1 });
    expect(codes(widget({ type: 'stacked_bar_chart' }), fine)).toEqual([]);
    expect(codes(widget({ type: 'stacked_bar_chart' }), [...fine, { label: '2025-01', series: 'S0', value: 9 }])).toEqual(['duplicate_labels']);
  });

  it('a data table with too many columns, and one with raw timestamps', () => {
    const wide = [Object.fromEntries(Array.from({ length: L.DATA_TABLE_MAX_COLS + 1 }, (_, i) => [`c${i}`, i]))];
    expect(codes(widget({ type: 'data_table' }), wide)).toEqual(['too_many_columns']);
    expect(codes(widget({ type: 'data_table' }), [{ invoice: 'A', invoice_date: '2025-01-01T00:00:00.000Z', amount: 1 }])).toEqual(['raw_timestamps']);
    expect(codes(widget({ type: 'data_table' }), [{ invoice: 'A', invoice_date: '2025-01-01', amount: 1 }])).toEqual([]);
  });

  it('a pivot with too many columns across', () => {
    const rows = [];
    for (let c = 0; c < L.PIVOT_MAX_COLS + 1; c++) rows.push({ row_label: 'r', col_label: `c${c}`, value: 1 });
    expect(codes(widget({ type: 'pivot_table' }), rows)).toEqual(['too_many_columns']);
  });

  it('radar, scatter, bullet, treemap limits', () => {
    expect(codes(widget({ type: 'radar_chart' }), labelValue(L.RADAR_MIN_AXES - 1))).toEqual(['too_few_axes']);
    expect(codes(widget({ type: 'radar_chart' }), labelValue(L.RADAR_MAX_AXES + 1))).toEqual(['too_many_axes']);
    expect(codes(widget({ type: 'radar_chart' }), labelValue(5))).toEqual([]);
    expect(codes(widget({ type: 'scatter_chart' }), Array.from({ length: L.SCATTER_MAX_POINTS + 1 }, (_, i) => ({ label: `p${i}`, x: i, y: i })))).toEqual(['too_many_points']);
    expect(codes(widget({ type: 'bullet_chart' }), Array.from({ length: L.BULLET_MAX_ROWS + 1 }, (_, i) => ({ label: `u${i}`, value: i, target: 10 })))).toEqual(['rows_dropped']);
    expect(codes(widget({ type: 'treemap_chart' }), labelValue(L.TREEMAP_MAX_TILES + 1))).toEqual(['too_many_categories']);
    expect(codes(widget({ type: 'treemap_chart' }), labelValue(3, undefined, (i) => [5, -1, 2][i]))).toEqual(['negative_area']);
  });
});

describe('applyReadabilityFixes', () => {
  it('a 12-slice pie becomes a horizontal bar with no model call, and nothing remains', () => {
    const out = applyReadabilityFixes(widget({ type: 'pie_chart' }), profileRows(labelValue(12)));
    expect(out.widget.type).toBe('bar_chart');
    expect(out.applied.map((f) => f.code)).toEqual(['pie_too_many_slices']);
    expect(out.remaining).toEqual([]);
  });

  it('a 40-slice pie becomes a bar AND still needs top-N — the re-assessment after the swap is the point', () => {
    const out = applyReadabilityFixes(widget({ type: 'pie_chart' }), profileRows(labelValue(40)));
    expect(out.widget.type).toBe('bar_chart');
    expect(out.remaining.map((f) => f.code)).toEqual(['too_many_categories']);
  });

  it('a count on a vertical bar with names gets BOTH the format and the swap', () => {
    const rows = labelValue(10, undefined, (i) => 500 - i);
    const out = applyReadabilityFixes(widget({ type: 'vertical_bar_chart', title: 'Orders per customer' }), profileRows(rows));
    expect(out.widget.type).toBe('bar_chart');
    expect(out.widget.format).toBe('number');
    expect(out.remaining).toEqual([]);
  });

  it('a series-column line becomes a stacked bar and the stacked rules then apply', () => {
    const rows = [];
    for (const m of ['2025-01', '2025-02']) for (const s of ['A', 'B']) rows.push({ label: m, series: s, value: 1 });
    const out = applyReadabilityFixes(widget({ type: 'line_chart' }), profileRows(rows));
    expect(out.widget.type).toBe('stacked_bar_chart');
    expect(out.remaining).toEqual([]);
  });

  it('never swaps to a type the data does not satisfy, and never revisits a type', () => {
    // A radar with 2 rows wants a bar — but the rows lack "value", so the swap is refused and stays a finding.
    const out = applyReadabilityFixes(widget({ type: 'radar_chart' }), profileRows([{ label: 'a', score: 1 }, { label: 'b', score: 2 }]));
    expect(out.widget.type).toBe('radar_chart');
    expect(out.applied).toEqual([]);
  });

  it('leaves a healthy widget byte-identical', () => {
    const w = widget({ type: 'bar_chart', format: 'currency' });
    const out = applyReadabilityFixes(w, profileRows(labelValue(8)));
    expect(out.widget).toBe(w);
    expect(out.applied).toEqual([]);
    expect(out.remaining).toEqual([]);
  });
});

describe('the two sentences', () => {
  it('the model gets the rewrite; the card gets only the plain message', () => {
    const f = assessReadability(widget({ type: 'bar_chart' }), profileRows(labelValue(30)));
    expect(readabilityIssueText(f)).toContain('Fix:');
    expect(readabilityIssueText(f)).toContain('ROW_NUMBER()');
    expect(readabilityNoteText(f)).not.toContain('ROW_NUMBER()');
    expect(readabilityNoteText(f)).toContain('30 bars');
    expect(readabilityIssueText([])).toBeUndefined();
    expect(readabilityNoteText([])).toBeUndefined();
  });
});
