import { describe, it, expect } from 'vitest';
import { buildSpecDigest, buildEditPlanUser } from '../ai/prompts/dashboardEditPlanPrompt';
import type { DashboardSpec } from '../shared/contract';

const spec: DashboardSpec = {
  title: 'Product performance',
  description: 'Margin by item',
  filters: [
    { id: 'invoice_date', type: 'date_range', label: 'Invoice date', table: 'fact_sales', column: 'invoice_date' },
    { id: 'item_group', type: 'select', label: 'Item group', table: 'dim_item_group', column: 'group_name' },
  ],
  widgets: [
    {
      id: 'w1', type: 'kpi_card', title: 'Total revenue',
      sql: `SELECT SUM(amount) AS value FROM fact_sales WHERE invoice_date BETWEEN '{{invoice_date_from}}' AND '{{invoice_date_to}}'`,
    },
    {
      id: 'w2', type: 'bar_chart', title: 'Margin by group',
      sql: `SELECT g AS label, SUM(m) AS value FROM fact_sales WHERE ('{{item_group}}' = 'all' OR g = '{{item_group}}') GROUP BY g`,
    },
  ],
};

describe('buildSpecDigest', () => {
  it('carries structure but NEVER the SQL — that is the whole token economy', () => {
    const digest = JSON.stringify(buildSpecDigest(spec));
    expect(digest).not.toContain('SELECT');
    expect(digest).not.toContain('SUM(');
    expect(digest).toContain('"w1"');
    expect(digest).toContain('Total revenue');
  });

  it('reports which filters each widget is actually wired to', () => {
    const digest = buildSpecDigest(spec);
    expect(digest.widgets[0].filters).toEqual(['invoice_date']);
    expect(digest.widgets[1].filters).toEqual(['item_group']);
  });

  it('reports the column contract per widget so the planner can judge type swaps', () => {
    const digest = buildSpecDigest(spec);
    expect(digest.widgets[0].returns).toEqual(['value']);
    expect(digest.widgets[1].returns).toEqual(['label', 'value']);
  });
});

describe('buildEditPlanUser', () => {
  it('embeds the digest, not the spec', () => {
    const user = buildEditPlanUser('add a customer filter', spec, 'SCHEMA', 'RELS');
    expect(user).toContain('add a customer filter');
    expect(user).toContain('SCHEMA');
    expect(user).not.toContain('SELECT SUM(amount)');
  });
});
