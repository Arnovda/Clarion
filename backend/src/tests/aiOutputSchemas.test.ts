/**
 * Proves the AI-output guard rejects malformed model responses before they
 * can be persisted (star schema / dashboard spec / schema draft), while
 * accepting well-formed ones (including harmless extra fields).
 */
import { describe, it, expect } from 'vitest';
import {
  dashboardSpecSchema,
  schemaDraftSchema,
  starSchemaDesignSchema,
} from '../ai/outputSchemas';

describe('dashboardSpecSchema', () => {
  const good = {
    title: 'Sales', description: 'x',
    filters: [{ id: 'f1', type: 'select', label: 'Region', table: 't', column: 'c' }],
    widgets: [{ id: 'w1', type: 'bar_chart', title: 'By month', sql: 'SELECT 1' }],
  };

  it('accepts a well-formed spec (with extra fields)', () => {
    expect(dashboardSpecSchema.safeParse({ ...good, widgets: [{ ...good.widgets[0], featured: true }] }).success).toBe(true);
  });
  it('rejects an unknown widget type', () => {
    const bad = { ...good, widgets: [{ id: 'w', type: 'sankey', title: 't', sql: 'SELECT 1' }] };
    expect(dashboardSpecSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects a widget with empty SQL', () => {
    const bad = { ...good, widgets: [{ id: 'w', type: 'bar_chart', title: 't', sql: '' }] };
    expect(dashboardSpecSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects zero widgets', () => {
    expect(dashboardSpecSchema.safeParse({ ...good, widgets: [] }).success).toBe(false);
  });
  it('rejects a missing widgets array entirely', () => {
    expect(dashboardSpecSchema.safeParse({ title: 'x', description: 'y', filters: [] }).success).toBe(false);
  });
});

describe('starSchemaDesignSchema', () => {
  const good = {
    star_schema: {
      name: 'Sales',
      tables: [{
        table_name: 'fact_sales', display_name: 'Sales', table_role: 'fact',
        columns: [{ column_name: 'amount', data_type: 'DECIMAL', display_name: 'Amount', column_role: 'measure' }],
      }],
      relationships: [],
    },
    proposed_kpis: [],
  };

  it('accepts a well-formed design', () => {
    expect(starSchemaDesignSchema.safeParse(good).success).toBe(true);
  });
  it('rejects an invalid column_role', () => {
    const bad = structuredClone(good);
    bad.star_schema.tables[0].columns[0].column_role = 'nonsense';
    expect(starSchemaDesignSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects a table with no columns', () => {
    const bad = structuredClone(good);
    bad.star_schema.tables[0].columns = [];
    expect(starSchemaDesignSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects a missing star_schema', () => {
    expect(starSchemaDesignSchema.safeParse({ proposed_kpis: [] }).success).toBe(false);
  });
});

describe('schemaDraftSchema', () => {
  const good = {
    tables: [{ table_name: 't', display_name: 'T', description: 'd', suggested_relationships: [] }],
    columns: [{ table_name: 't', column_name: 'c', display_name: 'C', description: 'd', is_dimension: true, is_measure: false }],
  };
  it('accepts a well-formed draft', () => {
    expect(schemaDraftSchema.safeParse(good).success).toBe(true);
  });
  it('rejects a column with a non-boolean is_measure', () => {
    const bad = structuredClone(good);
    (bad.columns[0] as Record<string, unknown>).is_measure = 'yes';
    expect(schemaDraftSchema.safeParse(bad).success).toBe(false);
  });
  it('defaults suggested_relationships when omitted', () => {
    const parsed = schemaDraftSchema.safeParse({
      tables: [{ table_name: 't', display_name: 'T', description: 'd' }],
      columns: good.columns,
    });
    expect(parsed.success).toBe(true);
  });
});
