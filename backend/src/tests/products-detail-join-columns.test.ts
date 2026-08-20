/**
 * GET /api/products/:id — the `join_columns` list.
 *
 * The is_technical firewall keeps keys (FKs, surrogate keys, `_row_hash`)
 * out of the curatorial `columns` lists. That is right everywhere except
 * the schema diagram, whose whole subject IS the keys: with the endpoints
 * filtered, the join surface rendered empty and edges landed on card edges
 * (owner screenshot, 2026-08-20). The payload now ships relationship-
 * endpoint columns separately as `join_columns` — these tests pin that the
 * diagram gets its keys AND that the firewall's real target (underscore-
 * prefixed storage columns) can never ride along, even when a pathological
 * relationship row references one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let productId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'joincols-admin@test.com', companyName: 'JoinColsCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;

  const db = getTestDb();
  const insId = (row: unknown) => Number((row as { id?: number }).id ?? row);

  const [conn] = await db('connections')
    .insert({ tenant_id: tenantId, name: 'EO', type: 'duckdb', config: JSON.stringify({}) })
    .returning('id');

  const [product] = await db('data_products')
    .insert({ tenant_id: tenantId, connection_id: insId(conn), name: 'Inventory', status: 'approved', kind: 'analytics' })
    .returning('id');
  productId = insId(product);

  const [schema] = await db('star_schemas')
    .insert({ tenant_id: tenantId, data_product_id: productId, name: 'Inventory star' })
    .returning('id');
  const schemaId = insId(schema);

  const [fact] = await db('product_tables')
    .insert({ tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fact_inventory_snapshot', table_role: 'fact' })
    .returning('id');
  const factId = insId(fact);
  const [dim] = await db('product_tables')
    .insert({ tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_item', table_role: 'dimension' })
    .returning('id');
  const dimId = insId(dim);

  await db('product_columns').insert([
    // The join columns — technical, so the firewalled `columns` list drops
    // them. Exactly what `join_columns` exists to carry.
    { tenant_id: tenantId, product_table_id: factId, column_name: 'item_key', data_type: 'INTEGER', column_role: 'foreign_key', is_technical: true },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'item_key', data_type: 'INTEGER', column_role: 'surrogate_key', is_technical: true },
    // Business columns — stay in `columns`, never duplicated into join_columns.
    { tenant_id: tenantId, product_table_id: factId, column_name: 'quantity_on_hand', data_type: 'DOUBLE', column_role: 'measure', is_technical: false },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'item_code', data_type: 'VARCHAR', column_role: 'natural_key', is_technical: false },
    // The firewall's real target. A relationship row below references it —
    // it must STILL never reach the payload.
    { tenant_id: tenantId, product_table_id: factId, column_name: '_row_hash', data_type: 'VARCHAR', column_role: 'attribute', is_technical: true },
  ]);

  await db('product_relationships').insert([
    { tenant_id: tenantId, star_schema_id: schemaId, from_table_id: factId, from_column_name: 'item_key', to_table_id: dimId, to_column_name: 'item_key', relationship_type: 'fact_to_dim' },
    // Endpoint on a business column: already shipped in `columns`, so
    // join_columns must not repeat it.
    { tenant_id: tenantId, star_schema_id: schemaId, from_table_id: dimId, from_column_name: 'item_code', to_table_id: factId, to_column_name: 'quantity_on_hand', relationship_type: 'dim_to_dim' },
    // Pathological: names the storage column. The exclusion is by name, on
    // purpose — the firewall must hold even against bad relationship data.
    { tenant_id: tenantId, star_schema_id: schemaId, from_table_id: factId, from_column_name: '_row_hash', to_table_id: dimId, to_column_name: 'item_key', relationship_type: 'fact_to_dim' },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

interface DetailTable {
  table_name: string;
  columns: Array<{ column_name: string }>;
  join_columns: Array<{ column_name: string; column_role: string | null }>;
}

async function fetchDetail() {
  const res = await (await request())
    .get(`/api/products/${productId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  const tables = (res.body.data.star_schemas as Array<{ tables: DetailTable[] }>).flatMap((s) => s.tables);
  return { body: res.body, tables };
}

describe('GET /api/products/:id join_columns', () => {
  it('ships technical relationship endpoints as join_columns while columns stays firewalled', async () => {
    const { tables } = await fetchDetail();
    const fact = tables.find((t) => t.table_name === 'fact_inventory_snapshot')!;
    const dim = tables.find((t) => t.table_name === 'dim_item')!;

    expect(fact.columns.map((c) => c.column_name)).toEqual(['quantity_on_hand']);
    expect(fact.join_columns.map((c) => c.column_name)).toEqual(['item_key']);
    expect(dim.join_columns.map((c) => c.column_name)).toEqual(['item_key']);
  });

  it('does not duplicate business endpoints already shipped in columns', async () => {
    const { tables } = await fetchDetail();
    const dim = tables.find((t) => t.table_name === 'dim_item')!;
    expect(dim.columns.map((c) => c.column_name)).toContain('item_code');
    expect(dim.join_columns.map((c) => c.column_name)).not.toContain('item_code');
  });

  it('never lets _row_hash into a column list, even as a relationship endpoint', async () => {
    const { tables } = await fetchDetail();
    // The pathological relationship row necessarily echoes the name in the
    // relationships array (it always has); what the firewall guards is the
    // COLUMN lists — no card, picker or AI surface may receive the storage
    // column as a column.
    const allColumnLists = JSON.stringify(tables.flatMap((t) => [...t.columns, ...t.join_columns]));
    expect(allColumnLists).not.toContain('_row_hash');
  });
});
