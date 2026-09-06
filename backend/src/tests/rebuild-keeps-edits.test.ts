/**
 * A bus-matrix rebuild carries human edits across (2026-09-06 evaluation,
 * defect 4). `buildBusMatrix` retires and re-creates every same-named
 * product, so ids change and — before this — `question_text`,
 * `plain_summary`, `hidden` and any KPI a person had authored were gone
 * after "Rebuild". The profiler preserved curation on the source layer; the
 * builder did not. This drives the real builder twice against Postgres
 * (no AI, no warehouse: the builder only persists the design).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { buildBusMatrix, snapshotProductEdits } from '../services/busMatrixBuilder';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

let tenantId: number;
let connectionId: number;

const matrix = (): BusMatrixOutput => ({
  rationale: 'test',
  dim_date_range: { start: '2024-01-01', end: '2024-12-31' },
  conformed_dimensions: [{
    table_name: 'dim_customer', display_name: 'Customer', description: 'One row per customer',
    transformation_sql: 'SELECT id AS customer_key, name AS customer_name FROM customers',
    source_tables: ['customers'],
    columns: [
      { column_name: 'customer_key', data_type: 'INTEGER', display_name: 'Customer key', description: 'Key', column_role: 'surrogate_key', transformation_expression: 'id' },
      { column_name: 'customer_name', data_type: 'VARCHAR', display_name: 'Customer', description: 'Name', column_role: 'attribute', transformation_expression: 'name' },
    ],
  }],
  fact_tables: [{
    table_name: 'fact_sales', display_name: 'Sales', description: 'One row per invoice line', grain: 'One row per invoice line',
    fact_table_type: 'transaction',
    transformation_sql: 'SELECT s.customer_id AS customer_key, s.amount FROM sales s',
    source_tables: ['sales'], dimensions_used: ['dim_customer', 'dim_date'],
    columns: [
      { column_name: 'customer_key', data_type: 'INTEGER', display_name: 'Customer key', description: 'FK', column_role: 'foreign_key', transformation_expression: 's.customer_id', fk_target_table: 'dim_customer', fk_target_column: 'customer_key' },
      { column_name: 'amount', data_type: 'DECIMAL', display_name: 'Amount', description: 'Line amount', column_role: 'measure', transformation_expression: 's.amount', additivity: 'additive' },
    ],
  }],
  relationships: [{ from_table_name: 'fact_sales', from_column_name: 'customer_key', to_table_name: 'dim_customer', to_column_name: 'customer_key', relationship_type: 'fact_to_dim' }],
  data_products: [{ name: 'Sales', description: 'Sales analytics', build_order: 1, fact_tables: ['fact_sales'], owned_dimensions: ['dim_customer'] }],
  proposed_kpis: [{ name: 'Revenue', description: 'Total sales', formula_plain_text: 'sum of amount', formula_sql: 'SUM(amount)', additivity: 'additive', product_name: 'Sales' }],
} as unknown as BusMatrixOutput);

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'rebuild-admin@test.com', companyName: 'RebuildCo' });
  tenantId = admin.user.tenantId;
  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'ERP', type: 'duckdb', connector_type: 'odoo', config: JSON.stringify({}),
  }).returning('id');
  connectionId = Number((conn as { id?: number }).id ?? conn);
});

afterAll(async () => { await closeTestDb(); });

describe('buildBusMatrix — rebuild keeps human edits', () => {
  it('carries hidden, plain_summary, question_text and a user-authored KPI across a rebuild', async () => {
    const db = getTestDb();
    const first = await buildBusMatrix({ connectionId, tenantId, userEmail: 'a@b', busMatrix: matrix() });
    const firstId = first.products[0].id;

    // A person edits the product the way the UI lets them.
    await db('data_products').where({ id: firstId }).update({ hidden: true });
    const fact = await db('product_tables as pt').join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
      .where({ 'ss.data_product_id': firstId, 'pt.table_name': 'fact_sales' }).select('pt.id').first();
    await db('product_tables').where({ id: fact.id }).update({ plain_summary: 'Every invoice line, joined to its customer.' });
    await db('product_kpis').where({ data_product_id: firstId, name: 'Revenue' }).update({ question_text: 'How much did we sell?' });
    await db('product_kpis').insert({
      tenant_id: tenantId, data_product_id: firstId, name: 'Average line', description: 'Mine', formula_plain_text: 'avg amount',
      formula_sql: 'AVG(amount)', ai_draft: false, question_text: 'What is a typical line worth?',
    });

    const snap = await snapshotProductEdits(db, [{ id: firstId, name: 'Sales' }]);
    expect(snap.get('Sales')?.hidden).toBe(true);
    expect(snap.get('Sales')?.tableSummaries.get('fact_sales')).toContain('invoice line');
    expect(snap.get('Sales')?.kpiQuestions.get('Revenue')).toBe('How much did we sell?');
    expect([...snap.get('Sales')!.userKpis.keys()]).toEqual(['Average line']);

    // Rebuild: same design again → retire-and-replace.
    const second = await buildBusMatrix({ connectionId, tenantId, userEmail: 'a@b', busMatrix: matrix() });
    const secondId = second.products[0].id;
    expect(secondId).not.toBe(firstId);
    expect(await db('data_products').where({ id: firstId }).first()).toBeUndefined();

    const product = await db('data_products').where({ id: secondId }).first();
    expect(product.hidden).toBe(true);
    const newFact = await db('product_tables as pt').join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
      .where({ 'ss.data_product_id': secondId, 'pt.table_name': 'fact_sales' }).select('pt.plain_summary').first();
    expect(newFact.plain_summary).toBe('Every invoice line, joined to its customer.');
    const kpis = await db('product_kpis').where({ data_product_id: secondId }).orderBy('name');
    expect(kpis.map((k: { name: string }) => k.name)).toEqual(['Average line', 'Revenue']);
    expect(kpis.find((k: { name: string }) => k.name === 'Revenue').question_text).toBe('How much did we sell?');
    const mine = kpis.find((k: { name: string }) => k.name === 'Average line');
    expect(mine.ai_draft).toBe(false);
    expect(mine.formula_sql).toBe('AVG(amount)');
    expect(mine.question_text).toBe('What is a typical line worth?');
  });

  it('is a no-op on a first build (nothing to carry)', async () => {
    const snap = await snapshotProductEdits(getTestDb(), []);
    expect(snap.size).toBe(0);
  });
});
