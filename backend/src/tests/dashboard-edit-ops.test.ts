import { describe, it, expect } from 'vitest';
import {
  applyEditOps,
  injectWherePredicate,
  stripFilterPredicate,
  selectFilterPredicate,
  dateFilterPredicate,
  canSwapType,
  pendingSqlEdits,
  realRefusals,
  type DashboardEditOp,
} from '../services/dashboardEditOps';
import type { DashboardSpec, FilterSpec, WidgetSpec } from '../shared/contract';

const widget = (id: string, over: Partial<WidgetSpec> = {}): WidgetSpec => ({
  id,
  type: 'bar_chart',
  title: `Widget ${id}`,
  sql: `SELECT label, SUM(v) AS value FROM fact_sales WHERE d BETWEEN '{{dr_from}}' AND '{{dr_to}}' GROUP BY label ORDER BY value DESC LIMIT 10`,
  ...over,
});

const drFilter: FilterSpec = { id: 'dr', type: 'date_range', label: 'Date', table: 'fact_sales', column: 'd' };

const spec = (widgets: WidgetSpec[], over: Partial<DashboardSpec> = {}): DashboardSpec => ({
  title: 'T',
  description: 'D',
  filters: [drFilter],
  widgets,
  ...over,
});

// ─── injectWherePredicate ────────────────────────────────────────────────────

describe('injectWherePredicate', () => {
  it('adds AND before GROUP BY when a WHERE exists', () => {
    const out = injectWherePredicate(
      `SELECT a, SUM(b) AS value FROM t WHERE x = 1 GROUP BY a`,
      `c = 'y'`,
    );
    expect(out).toBe(`SELECT a, SUM(b) AS value FROM t WHERE x = 1 AND c = 'y' GROUP BY a`);
  });

  it('adds a WHERE before ORDER BY when none exists', () => {
    const out = injectWherePredicate(`SELECT a FROM t ORDER BY a`, `c = 'y'`);
    expect(out).toBe(`SELECT a FROM t WHERE c = 'y' ORDER BY a`);
  });

  it('appends when there are no post-aggregation clauses, minding a semicolon', () => {
    expect(injectWherePredicate(`SELECT a FROM t;`, `c = 1`)).toBe(`SELECT a FROM t WHERE c = 1;`);
  });

  it('refuses CTEs, set operators, and FROM-less statements — never guesses', () => {
    expect(injectWherePredicate(`WITH x AS (SELECT 1) SELECT * FROM x`, `c = 1`)).toBeNull();
    expect(injectWherePredicate(`SELECT a FROM t UNION SELECT a FROM u`, `c = 1`)).toBeNull();
    expect(injectWherePredicate(`SELECT 1 AS value`, `c = 1`)).toBeNull();
  });
});

// ─── predicates ─────────────────────────────────────────────────────────────

describe('filter predicates', () => {
  it('select predicate takes the shape the generation prompt produces', () => {
    expect(selectFilterPredicate('customer', 'customer_name'))
      .toBe(`('{{customer}}' = 'all' OR customer_name = '{{customer}}')`);
  });

  it('date predicate uses _from/_to placeholders', () => {
    expect(dateFilterPredicate('dr', 'invoice_date'))
      .toBe(`invoice_date BETWEEN '{{dr_from}}' AND '{{dr_to}}'`);
  });

  it('refuses SQL-injection-shaped identifiers outright — never a stripped lookalike', () => {
    expect(selectFilterPredicate('x', "name'; DROP TABLE t; --")).toBeNull();
    expect(selectFilterPredicate("id'--", 'name')).toBeNull();
  });
});

// ─── stripFilterPredicate ────────────────────────────────────────────────────

describe('stripFilterPredicate', () => {
  it('removes a select-filter conjunct and keeps the rest of the WHERE', () => {
    const sql = `SELECT a FROM t WHERE ('{{cust}}' = 'all' OR c = '{{cust}}') AND d > 5 GROUP BY a`;
    expect(stripFilterPredicate(sql, 'cust')).toBe(`SELECT a FROM t WHERE d > 5 GROUP BY a`);
  });

  it('removes the WHERE entirely when the filter was its only conjunct', () => {
    const sql = `SELECT a FROM t WHERE ('{{cust}}' = 'all' OR c = '{{cust}}') GROUP BY a`;
    expect(stripFilterPredicate(sql, 'cust')).toBe(`SELECT a FROM t GROUP BY a`);
  });

  it('removes a date-range pair', () => {
    const sql = `SELECT a FROM t WHERE d BETWEEN '{{dr_from}}' AND '{{dr_to}}' AND x = 1 ORDER BY a`;
    expect(stripFilterPredicate(sql, 'dr')).toBe(`SELECT a FROM t WHERE x = 1 ORDER BY a`);
  });

  it('is a no-op when the placeholder is absent', () => {
    expect(stripFilterPredicate(`SELECT a FROM t`, 'cust')).toBe(`SELECT a FROM t`);
  });

  it('returns null rather than leave a dangling placeholder (top-level OR)', () => {
    // The filter placeholder is inside an OR the splitter cannot untangle.
    const sql = `SELECT a FROM t WHERE x = 1 OR c = '{{cust}}'`;
    expect(stripFilterPredicate(sql, 'cust')).toBeNull();
  });
});

// ─── type swap groups ────────────────────────────────────────────────────────

describe('canSwapType', () => {
  it('allows swaps within the label/value family', () => {
    expect(canSwapType('bar_chart', 'line_chart')).toBe(true);
    expect(canSwapType('pie_chart', 'top_list')).toBe(true);
  });

  it('refuses swaps that change the column contract', () => {
    expect(canSwapType('bar_chart', 'stacked_bar_chart')).toBe(false);
    expect(canSwapType('kpi_card', 'bar_chart')).toBe(false);
    expect(canSwapType('bar_chart', 'data_table')).toBe(false);
  });
});

// ─── applyEditOps ────────────────────────────────────────────────────────────

describe('applyEditOps', () => {
  it('add_filter wires the predicate into every widget and registers the filter', () => {
    const s = spec([widget('w1'), widget('w2')]);
    const op: DashboardEditOp = {
      op: 'add_filter',
      filter: { id: 'customer', type: 'select', label: 'Customer', table: 'dim_customer', column: 'customer_name' },
    };
    const { spec: out, applied } = applyEditOps(s, [op]);
    expect(out.filters.map((f) => f.id)).toEqual(['dr', 'customer']);
    for (const w of out.widgets) {
      expect(w.sql).toContain(`('{{customer}}' = 'all' OR customer_name = '{{customer}}')`);
      // Injected into the WHERE, not past the GROUP BY.
      expect(w.sql.indexOf('{{customer}}')).toBeLessThan(w.sql.indexOf('GROUP BY'));
    }
    expect(applied[0].changedWidgetIds).toEqual(['w1', 'w2']);
    expect(realRefusals(applied)).toEqual([]);
  });

  it('add_filter reports widgets whose shape it could not wire, and wires the rest', () => {
    const cte = widget('w2', { sql: `WITH x AS (SELECT 1) SELECT label, 1 AS value FROM x` });
    const s = spec([widget('w1'), cte]);
    const { spec: out, applied } = applyEditOps(s, [{
      op: 'add_filter',
      filter: { id: 'customer', type: 'select', label: 'Customer', table: 'dim_customer', column: 'customer_name' },
    }]);
    expect(out.widgets[0].sql).toContain('{{customer}}');
    expect(out.widgets[1].sql).not.toContain('{{customer}}');
    expect(realRefusals(applied)[0]).toContain('Widget w2');
  });

  it('add_filter refuses a duplicate id and an unsafe column', () => {
    const s = spec([widget('w1')]);
    const dup = applyEditOps(s, [{ op: 'add_filter', filter: { ...drFilter } }]);
    expect(realRefusals(dup.applied)).toHaveLength(1);
    const unsafe = applyEditOps(s, [{
      op: 'add_filter',
      filter: { id: 'x', type: 'select', label: 'X', table: 't', column: "c'; DROP TABLE t;--" },
    }]);
    expect(realRefusals(unsafe.applied)).toHaveLength(1);
    expect(unsafe.spec.filters).toHaveLength(1);
  });

  it('remove_filter strips the predicate from every widget or refuses atomically', () => {
    const s = spec([widget('w1')], {
      filters: [drFilter, { id: 'cust', type: 'select', label: 'Customer', table: 'd', column: 'c' }],
    });
    s.widgets[0].sql = `SELECT label, SUM(v) AS value FROM f WHERE ('{{cust}}' = 'all' OR c = '{{cust}}') AND d BETWEEN '{{dr_from}}' AND '{{dr_to}}' GROUP BY label`;
    const { spec: out, applied } = applyEditOps(s, [{ op: 'remove_filter', filterId: 'cust' }]);
    expect(out.filters.map((f) => f.id)).toEqual(['dr']);
    expect(out.widgets[0].sql).not.toContain('{{cust}}');
    expect(out.widgets[0].sql).toContain('{{dr_from}}');
    expect(realRefusals(applied)).toEqual([]);
  });

  it('set_widget_type applies within a contract group and hands over otherwise', () => {
    const s = spec([widget('w1')]);
    const ok = applyEditOps(s, [{ op: 'set_widget_type', widgetId: 'w1', widgetType: 'line_chart' }]);
    expect(ok.spec.widgets[0].type).toBe('line_chart');

    const cross = applyEditOps(s, [{ op: 'set_widget_type', widgetId: 'w1', widgetType: 'stacked_bar_chart' }]);
    expect(cross.spec.widgets[0].type).toBe('bar_chart'); // unchanged
    const pending = pendingSqlEdits(cross.applied);
    expect(pending).toHaveLength(1);
    expect(pending[0].widgetId).toBe('w1');
    // A handover is not a user-facing refusal.
    expect(realRefusals(cross.applied)).toEqual([]);
  });

  it('set_widget_limit rewrites a trailing LIMIT and hands over when there is none', () => {
    const s = spec([widget('w1'), widget('w2', { sql: `SELECT label, 1 AS value FROM t GROUP BY label` })]);
    const { spec: out, applied } = applyEditOps(s, [
      { op: 'set_widget_limit', widgetId: 'w1', limit: 25 },
      { op: 'set_widget_limit', widgetId: 'w2', limit: 25 },
    ]);
    expect(out.widgets[0].sql).toMatch(/LIMIT 25$/);
    expect(pendingSqlEdits(applied)).toHaveLength(1);
  });

  it('remove/retitle widget, retitle dashboard, sql_edit passthrough', () => {
    const s = spec([widget('w1'), widget('w2')]);
    const ops: DashboardEditOp[] = [
      { op: 'remove_widget', widgetId: 'w2' },
      { op: 'retitle_widget', widgetId: 'w1', title: 'Revenue by region' },
      { op: 'retitle_dashboard', title: 'New title' },
      { op: 'sql_edit', widgetId: 'w1', instruction: 'group by month' },
    ];
    const { spec: out, applied } = applyEditOps(s, ops);
    expect(out.widgets.map((w) => w.id)).toEqual(['w1']);
    expect(out.widgets[0].title).toBe('Revenue by region');
    expect(out.title).toBe('New title');
    expect(pendingSqlEdits(applied)).toEqual([{ widgetId: 'w1', instruction: 'group by month' }]);
  });

  it('never mutates the input spec', () => {
    const s = spec([widget('w1')]);
    const frozen = JSON.stringify(s);
    applyEditOps(s, [
      { op: 'add_filter', filter: { id: 'g', type: 'select', label: 'G', table: 't', column: 'g' } },
      { op: 'retitle_widget', widgetId: 'w1', title: 'X' },
    ]);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('unknown widget ids refuse instead of throwing', () => {
    const s = spec([widget('w1')]);
    const { applied } = applyEditOps(s, [
      { op: 'remove_widget', widgetId: 'nope' },
      { op: 'retitle_widget', widgetId: 'nope', title: 'X' },
      { op: 'set_widget_format', widgetId: 'nope', format: 'currency' },
    ]);
    expect(realRefusals(applied)).toHaveLength(3);
  });
});
