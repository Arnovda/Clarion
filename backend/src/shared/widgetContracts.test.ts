/**
 * Widget column-contract validator tests.
 *
 * Pure-function tests — no DB, no DuckDB, no network. Proves the /generate
 * validation pass catches the "mis-aliased SELECT renders an empty chart"
 * class deterministically, and that correct specs pass untouched.
 */
import { describe, it, expect } from 'vitest';
import { REQUIRED_WIDGET_COLUMNS, validateWidgetColumns } from './widgetContracts';

const row = (cols: string[]): Record<string, unknown> =>
  Object.fromEntries(cols.map((c, i) => [c, i]));

describe('validateWidgetColumns', () => {
  it('passes a correct kpi_card result', () => {
    expect(validateWidgetColumns('kpi_card', [row(['value', 'delta', 'delta_label'])])).toBeNull();
  });

  it('flags a kpi_card missing "value"', () => {
    const issue = validateWidgetColumns('kpi_card', [row(['total', 'delta'])]);
    expect(issue).toContain('value');
    expect(issue).toContain('kpi_card');
  });

  it('passes bar/line/pie/top_list/treemap/radar with label+value', () => {
    for (const type of ['bar_chart', 'vertical_bar_chart', 'line_chart', 'pie_chart', 'top_list', 'treemap_chart', 'radar_chart']) {
      expect(validateWidgetColumns(type, [row(['label', 'value'])])).toBeNull();
    }
  });

  it('flags a bar_chart whose SQL forgot to alias to label/value', () => {
    const issue = validateWidgetColumns('bar_chart', [row(['customer_name', 'revenue'])]);
    expect(issue).toContain('label');
    expect(issue).toContain('value');
    // Tells the repair model what came back so it can fix the aliases
    expect(issue).toContain('customer_name');
  });

  it('flags stacked_bar_chart missing "series"', () => {
    const issue = validateWidgetColumns('stacked_bar_chart', [row(['label', 'value'])]);
    expect(issue).toContain('series');
    // Only the truly missing column is reported as missing
    expect(issue).toContain('missing required column(s) for stacked_bar_chart: series.');
  });

  it('flags pivot_table missing row_label/col_label', () => {
    const issue = validateWidgetColumns('pivot_table', [row(['label', 'value'])]);
    expect(issue).toContain('row_label');
    expect(issue).toContain('col_label');
  });

  it('passes combo_chart without the optional "line" column', () => {
    expect(validateWidgetColumns('combo_chart', [row(['label', 'value'])])).toBeNull();
    expect(validateWidgetColumns('combo_chart', [row(['label', 'value', 'line'])])).toBeNull();
  });

  it('is case-insensitive on returned column names', () => {
    expect(validateWidgetColumns('bar_chart', [row(['Label', 'VALUE'])])).toBeNull();
  });

  it('never flags data_table (any named columns are valid)', () => {
    expect(validateWidgetColumns('data_table', [row(['anything', 'goes'])])).toBeNull();
  });

  it('returns null for unknown types and empty samples (nothing to check)', () => {
    expect(validateWidgetColumns('sparkline_future_type', [row(['x'])])).toBeNull();
    expect(validateWidgetColumns('kpi_card', [])).toBeNull();
  });

  it('has a contract entry for every widget type in the shared contract', () => {
    // 12 widget types today — if the contract enum grows, this map must too.
    expect(Object.keys(REQUIRED_WIDGET_COLUMNS).sort()).toEqual([
      'bar_chart', 'combo_chart', 'data_table', 'kpi_card', 'line_chart',
      'pie_chart', 'pivot_table', 'radar_chart', 'stacked_bar_chart',
      'top_list', 'treemap_chart', 'vertical_bar_chart',
    ]);
  });
});
