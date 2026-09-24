/**
 * The owner's own shape: Reference owns dim_account (ROW_NUMBER key); Sales
 * uses a COPY of it and holds its keys in a fact. Rebuilding Reference on its
 * own — by hand, by the subject's Rebuild, by a schedule or a pipeline — would
 * renumber the lookup while Sales keeps the old numbers. Every one of those
 * doors must refuse; running both subjects together must not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { unstableKeyRefusalForProducts, loadKeyGraph, summariseKeyHealth } from '../services/keyHealth';
import { tenantQuery } from '../services/tenantQuery';

const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);
let token: string;
let tenantId: number;
let connectionId: number;
let reference: number;
let sales: number;
let dimId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@crosskeys.test', companyName: 'Cross Keys BV' });
  token = admin.token; tenantId = admin.user.tenantId;
  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Exact', type: 'duckdb', connector_type: 'exactonline', warehouse_path: '/tmp/none', query_engine: 'duckdb', config: '{}',
  }).returning('id');
  connectionId = idOf(conn);
  const product = async (name: string) => {
    const [p] = await db('data_products').insert({ tenant_id: tenantId, connection_id: connectionId, name, description: name, status: 'approved', kind: 'analytics' }).returning('id');
    const [s] = await db('star_schemas').insert({ tenant_id: tenantId, data_product_id: idOf(p), name, grain: 'g' }).returning('id');
    return { p: idOf(p), s: idOf(s) };
  };
  const ref = await product('Reference');
  const sal = await product('Sales');
  reference = ref.p; sales = sal.p;
  const [dim] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: ref.s, table_name: 'dim_account', table_role: 'dimension',
    transformation_sql: 'SELECT ROW_NUMBER() OVER (ORDER BY a.ID) AS account_key, a.ID AS account_id FROM Accounts a',
  }).returning('id');
  dimId = idOf(dim);
  const [copy] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: sal.s, table_name: 'dim_account', table_role: 'dimension', is_shared_dimension: true, source_product_table_id: dimId,
  }).returning('id');
  const [fact] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: sal.s, table_name: 'fact_sales', table_role: 'fact',
    transformation_sql: 'SELECT d.account_key AS account_key, i.Amount AS amount FROM SalesInvoices i LEFT JOIN dim_account d ON d.account_id = i.InvoiceTo',
  }).returning('id');
  await db('product_columns').insert([
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_key', column_role: 'surrogate_key' },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_id', column_role: 'natural_key' },
    { tenant_id: tenantId, product_table_id: idOf(fact), column_name: 'account_key', column_role: 'foreign_key', fk_target_table: 'dim_account', fk_target_column: 'account_key' },
  ]);
  // The join is recorded in SALES, against Sales' COPY — as the builder does.
  await db('product_relationships').insert({
    tenant_id: tenantId, star_schema_id: sal.s, from_table_id: idOf(fact), from_column_name: 'account_key',
    to_table_id: idOf(copy), to_column_name: 'account_key', relationship_type: 'fact_to_dim',
  });
});

afterAll(async () => { await closeTestDb(); });

describe('a renumbering lookup shared across subjects', () => {
  it('resolves the copy to its original: one lookup, one dependent fact', async () => {
    const graph = await tenantQuery(tenantId, (db) => loadKeyGraph(db, tenantId, connectionId));
    expect(graph.tables.map((t) => t.table_name).sort()).toEqual(['dim_account', 'fact_sales']);
    expect(graph.joins).toHaveLength(1);
    expect(graph.joins[0].to_table_id).toBe(dimId);
    expect(summariseKeyHealth(graph).unstable.map((t) => t.table_name)).toEqual(['dim_account']);
  });

  it('refuses Reference alone (schedule / pipeline door), allows both together', async () => {
    expect(await unstableKeyRefusalForProducts(tenantId, [reference])).toMatch(/fact_sales \(Sales\)/);
    expect(await unstableKeyRefusalForProducts(tenantId, [sales])).toBeNull();
    expect(await unstableKeyRefusalForProducts(tenantId, [reference, sales])).toBeNull();
  });

  it('refuses the subject Rebuild of Reference and a lone table rebuild of the lookup', async () => {
    const r = await (await request()).post(`/api/products/${reference}/refresh-start`).set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('unstable_keys');
    const t = await (await request()).post(`/api/products/tables/${dimId}/run`).set('Authorization', `Bearer ${token}`);
    expect(t.status).toBe(409);
  });

  it('refuses adding a subject until the keys are upgraded', async () => {
    await getTestDb()('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'Quotations', is_active: true });
    const r = await (await request()).post('/api/products/bus-matrix/extend-start').set('Authorization', `Bearer ${token}`)
      .send({ connectionId, name: 'Quotes', entities: ['Quotations'] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('upgrade_keys_first');
    expect(r.body.error).not.toMatch(/fact_|dim_/);
  });
});
