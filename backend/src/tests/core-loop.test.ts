/**
 * THE CORE LOOP, end to end, on a real DuckDB (assessment 10-1): source
 * tables land as Parquet in a connection's warehouse → a product's
 * transformation SQL is run by `transformationRunner` and published through
 * the table catalog → the product layer answers a query through the same
 * route a dashboard uses. Until this file no backend test opened DuckDB, and
 * neither `SyncOrchestrator` nor `transformationRunner` had a test — the two
 * services P0-2 and P0-5 turned out to be broken in.
 *
 * Deliberately NOT mocked: DuckDB, the Parquet files, the catalog, the
 * product connector, the SQL guard and data policies (viewer sees a masked
 * column) all run for real. The sync worker process itself is out of scope —
 * the source Parquet is written the way the worker's writer writes it
 * (`<warehouse>/<Entity>/data.parquet`); the worker contract is pinned in
 * packages/connectors.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'duckdb-async';

// Plain Parquet output: the Delta path needs the Python sidecar, which CI and
// this sandbox do not have. Read at call time by the runner.
process.env.STORAGE_FORMAT = 'parquet';

import { request, registerUser, createUserWithToken } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { runProductTransformation } from '../services/transformationRunner';

const warehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-core-loop-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

let adminToken: string;
let viewerToken: string;
let tenantId: number;
let connectionId: number;
let productId: number;
let dimId: number;
let factId: number;

/** Write a source entity exactly where the sync worker's writer puts it. */
async function writeSourceTable(entity: string, selectSql: string) {
  const dir = path.join(warehouse, entity);
  fs.mkdirSync(dir, { recursive: true });
  const db = await Database.create(':memory:');
  try {
    const out = path.join(dir, 'data.parquet').replace(/'/g, "''");
    await db.exec(`COPY (${selectSql}) TO '${out}' (FORMAT PARQUET)`);
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@coreloop.test', companyName: 'CoreLoop BV' });
  adminToken = admin.token; tenantId = admin.user.tenantId;
  viewerToken = (await createUserWithToken({ tenantId, role: 'viewer', email: 'viewer@coreloop.test' })).token;

  // 1. "Synced" source tables — two entities, the shape Exact Online lands in.
  await writeSourceTable('Accounts', `
    SELECT * FROM (VALUES
      ('a1', 'Van Damme BVBA', 'BE', 'BE0123456789'),
      ('a2', 'Peeters NV',     'BE', 'BE0987654321'),
      ('a3', 'Nord GmbH',      'DE', 'DE123456789')
    ) AS t(ID, Name, Country, VATNumber)`);
  await writeSourceTable('SalesInvoices', `
    SELECT * FROM (VALUES
      ('i1', 'a1', DATE '2026-01-15', 100.0),
      ('i2', 'a1', DATE '2026-02-03', 250.0),
      ('i3', 'a2', DATE '2026-02-20',  80.0),
      ('i4', 'a3', DATE '2026-03-01', 999.5)
    ) AS t(InvoiceID, InvoiceTo, InvoiceDate, AmountDC)`);

  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Exact (core loop)', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts', 'SalesInvoices'], warehouse_path: warehouse, query_engine: 'duckdb',
    last_sync_status: 'succeeded', config: JSON.stringify({}),
  }).returning('id');
  connectionId = idOf(conn);

  // 2. A product with a dimension and a fact, as the bus-matrix builder persists them.
  const [product] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: 'Sales', description: 'core loop', status: 'approved', kind: 'analytics',
  }).returning('id');
  productId = idOf(product);
  const [schema] = await db('star_schemas').insert({
    tenant_id: tenantId, data_product_id: productId, name: 'Sales star', grain: 'one row per invoice',
  }).returning('id');
  const [dim] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'dim_account', table_role: 'dimension', dag_order: 0,
    transformation_sql: `SELECT ID AS account_key, Name AS account_name, Country AS country, VATNumber AS vat_number FROM Accounts`,
  }).returning('id');
  const [fact] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'fact_sales_invoices', table_role: 'fact', dag_order: 1,
    transformation_sql: `SELECT InvoiceID AS invoice_id, InvoiceTo AS account_key, InvoiceDate AS invoice_date, AmountDC AS amount FROM SalesInvoices`,
  }).returning('id');
  dimId = idOf(dim); factId = idOf(fact);

  // A viewer must never see VAT numbers on this tenant.
  await db('data_policies').insert({
    tenant_id: tenantId, name: 'Mask VAT for viewers', role: 'viewer', table_name: 'dim_account',
    column_name: 'vat_number', filter_expression: 'masked', policy_type: 'column_mask', is_active: true,
  });
});

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(warehouse, { recursive: true, force: true });
});

const execute = async (token: string, sql: string) =>
  (await request()).post('/api/dashboards/execute').set('Authorization', `Bearer ${token}`)
    .send({ connectionId, sql, filterValues: {}, dataLayer: 'product' });

describe('core loop: Parquet → transformation → product query', () => {
  it('the product tables do not exist before the transformation ran', async () => {
    // With nothing materialised the route falls back to the SOURCE layer,
    // where `dim_account` is not a table — so this must not come back 200.
    // (A widget SQL failure is reported as HTTP 200 + ok:false by design —
    // the dashboard renders the message in the card.)
    const res = await execute(adminToken, 'SELECT COUNT(*) AS n FROM dim_account');
    expect(res.body.ok, JSON.stringify(res.body).slice(0, 400)).toBe(false);
  });

  it('runProductTransformation materialises the dimension and the fact in DAG order and publishes them', async () => {
    const db = getTestDb();
    const product = await db('data_products').where({ id: productId }).first();
    const tables = await db('product_tables').whereIn('id', [factId, dimId]);
    const results = await runProductTransformation(product, tables, tenantId);

    expect(results.map((r) => [r.table_name, r.status, r.row_count])).toEqual([
      ['dim_account', 'success', 3],
      ['fact_sales_invoices', 'success', 4],
    ]);
    for (const id of [dimId, factId]) {
      const row = await db('product_tables').where({ id }).first();
      expect(row.transformation_status).toBe('success');
      expect(row.delta_path).toBeTruthy();
      expect(fs.existsSync(path.join(row.delta_path, 'data.parquet'))).toBe(true);
    }
    // Columns were synced from what DuckDB actually produced.
    const cols = await db('product_columns').where({ product_table_id: factId }).pluck('column_name');
    expect(cols.sort()).toEqual(['account_key', 'amount', 'invoice_date', 'invoice_id']);
  });

  it('an admin can answer a business question that joins the fact to the dimension', async () => {
    const res = await execute(adminToken, `
      SELECT a.account_name, a.vat_number, SUM(f.amount) AS total
      FROM fact_sales_invoices f JOIN dim_account a ON a.account_key = f.account_key
      GROUP BY 1, 2 ORDER BY 1`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.data.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.account_name, Number(r.total)])).toEqual([
      ['Nord GmbH', 999.5], ['Peeters NV', 80], ['Van Damme BVBA', 350],
    ]);
    expect(rows[0].vat_number).toBe('DE123456789');
  });

  it('a viewer gets the same numbers with the VAT number masked — policies hold on the product layer', async () => {
    const res = await execute(viewerToken, `
      SELECT a.account_name, a.vat_number, SUM(f.amount) AS total
      FROM fact_sales_invoices f JOIN dim_account a ON a.account_key = f.account_key
      GROUP BY 1, 2 ORDER BY 1`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.data.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.vat_number === '***')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('DE123456789');
  });

  it('the guard still stands on the product layer: a quoted external read is refused', async () => {
    const res = await execute(adminToken, `SELECT * FROM "read_text"('/proc/self/environ')`);
    expect(res.status).toBe(400);
  });
});
