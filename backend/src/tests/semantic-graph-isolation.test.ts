/**
 * Cross-tenant isolation for the Neo4j-backed semantic layer.
 *
 * Neo4j has no tenant scoping — every node and edge is matched by a globally
 * unique, enumerable `pgId` (see db/tenantOwnership.ts). Postgres is the
 * ownership oracle, and these tests exercise that oracle against the REAL
 * schema and REAL RLS rather than a mock.
 *
 * Two directions, and the second matters as much as the first:
 *   • tenant B must be refused (the leak that shipped before 2026-07-28);
 *   • tenant A must NOT be refused — a gate that 404s everything would "pass"
 *     any test that only checked B, while breaking the catalog for everyone.
 *
 * Route-level coverage is deliberately limited to the REFUSAL path. Refusals
 * are decided before any `graph.*` call, so they need no Neo4j; the success
 * path would reach the graph, and CI runs with NEO4J_URI="" (~39s of retries
 * per call). The allow direction is therefore asserted at the oracle instead,
 * which is where the decision is actually made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { owns, ownedIds } from '../db/tenantOwnership';
import { connectionIdForEntity } from '../db/semanticCacheScope';

let tenantA: { token: string; user: { id: number; tenantId: number; email: string } };
let tenantB: { token: string; user: { id: number; tenantId: number; email: string } };

/** Ids owned by tenant A — the things tenant B must never reach. */
const a: Record<string, number> = {};

beforeAll(async () => {
  await cleanTestDb();

  tenantA = await registerUser({
    companyName: 'Graph Tenant A',
    email: 'admin@graph-a.com',
    displayName: 'Admin A',
  });
  tenantB = await registerUser({
    companyName: 'Graph Tenant B',
    email: 'admin@graph-b.com',
    displayName: 'Admin B',
  });

  const db = getTestDb();
  const tid = tenantA.user.tenantId;

  const [conn] = await db('connections')
    .insert({ tenant_id: tid, name: 'A source', type: 'sqlite', config: JSON.stringify({ filepath: '/tmp/a.db' }) })
    .returning('id');
  a.connection = Number(conn.id ?? conn);

  const [table] = await db('source_tables')
    .insert({ tenant_id: tid, connection_id: a.connection, table_name: 'secret_customers' })
    .returning('id');
  a.table = Number(table.id ?? table);

  const [column] = await db('source_columns')
    .insert({ tenant_id: tid, table_id: a.table, column_name: 'secret_revenue' })
    .returning('id');
  a.column = Number(column.id ?? column);

  const [rel] = await db('table_relationships')
    .insert({ tenant_id: tid, from_table_id: a.table, to_table_id: a.table, relationship_type: 'many_to_one' })
    .returning('id');
  a.relationship = Number(rel.id ?? rel);

  const [kpi] = await db('kpi_definitions')
    .insert({ tenant_id: tid, connection_id: a.connection, name: 'Secret margin' })
    .returning('id');
  a.kpi = Number(kpi.id ?? kpi);

  const [product] = await db('data_products')
    .insert({ tenant_id: tid, connection_id: a.connection, name: 'Secret product' })
    .returning('id');
  a.product = Number(product.id ?? product);

  const [schema] = await db('star_schemas')
    .insert({ tenant_id: tid, data_product_id: a.product, name: 'Secret schema' })
    .returning('id');
  a.starSchema = Number(schema.id ?? schema);

  const [ptable] = await db('product_tables')
    .insert({ tenant_id: tid, star_schema_id: a.starSchema, table_name: 'fact_secret', table_role: 'fact' })
    .returning('id');
  a.productTable = Number(ptable.id ?? ptable);

  const [pcol] = await db('product_columns')
    .insert({ tenant_id: tid, product_table_id: a.productTable, column_name: 'secret_amount' })
    .returning('id');
  a.productColumn = Number(pcol.id ?? pcol);
});

afterAll(async () => {
  await closeTestDb();
});

describe('ownership oracle (real schema, real RLS)', () => {
  const db = () => getTestDb();

  it("allows the owning tenant — the gate must not refuse legitimate traffic", async () => {
    const tid = tenantA.user.tenantId;
    expect(await owns(db(), 'connections', a.connection, tid)).toBe(true);
    expect(await owns(db(), 'source_tables', a.table, tid)).toBe(true);
    expect(await owns(db(), 'source_columns', a.column, tid)).toBe(true);
    expect(await owns(db(), 'table_relationships', a.relationship, tid)).toBe(true);
    expect(await owns(db(), 'kpi_definitions', a.kpi, tid)).toBe(true);
    expect(await owns(db(), 'data_products', a.product, tid)).toBe(true);
    expect(await owns(db(), 'product_tables', a.productTable, tid)).toBe(true);
    expect(await owns(db(), 'product_columns', a.productColumn, tid)).toBe(true);
  });

  it('refuses another tenant for every entity type', async () => {
    const tid = tenantB.user.tenantId;
    expect(await owns(db(), 'connections', a.connection, tid)).toBe(false);
    expect(await owns(db(), 'source_tables', a.table, tid)).toBe(false);
    expect(await owns(db(), 'source_columns', a.column, tid)).toBe(false);
    expect(await owns(db(), 'table_relationships', a.relationship, tid)).toBe(false);
    expect(await owns(db(), 'kpi_definitions', a.kpi, tid)).toBe(false);
    expect(await owns(db(), 'data_products', a.product, tid)).toBe(false);
    expect(await owns(db(), 'product_tables', a.productTable, tid)).toBe(false);
    expect(await owns(db(), 'product_columns', a.productColumn, tid)).toBe(false);
  });

  it('narrows a mixed id list to the ids the caller owns', async () => {
    const mine = await ownedIds(db(), 'data_products', [a.product], tenantA.user.tenantId);
    expect([...mine]).toEqual([a.product]);
    const theirs = await ownedIds(db(), 'data_products', [a.product], tenantB.user.tenantId);
    expect([...theirs]).toEqual([]);
  });
});

/**
 * These validate the JOIN CHAINS against the real schema. The mocked unit tests
 * assert the shape of the query; only this can catch a column that does not
 * exist (e.g. product_tables.star_schema_id being named something else), which
 * would silently degrade every invalidation to a global wipe.
 */
describe('cache scope resolution (real schema)', () => {
  const db = () => getTestDb();

  it('resolves every entity type back to its connection', async () => {
    expect(await connectionIdForEntity(db(), 'source_tables', a.table)).toBe(a.connection);
    expect(await connectionIdForEntity(db(), 'source_columns', a.column)).toBe(a.connection);
    expect(await connectionIdForEntity(db(), 'table_relationships', a.relationship)).toBe(a.connection);
    expect(await connectionIdForEntity(db(), 'kpi_definitions', a.kpi)).toBe(a.connection);
    expect(await connectionIdForEntity(db(), 'product_tables', a.productTable)).toBe(a.connection);
    expect(await connectionIdForEntity(db(), 'product_columns', a.productColumn)).toBe(a.connection);
  });

  it('returns null for a row that no longer exists, so the caller wipes globally', async () => {
    expect(await connectionIdForEntity(db(), 'source_tables', 99_999_999)).toBeNull();
  });
});

describe('semantic routes refuse another tenant', () => {
  it('does not leak a column catalog via ?tableId (the pre-2026-07-28 leak)', async () => {
    const res = await (await request())
      .get(`/api/semantic/columns?tableId=${a.table}`)
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(res.status).toBe(404);
  });

  it('does not leak tables, relationships or kpis via ?connectionId', async () => {
    const agent = await request();
    for (const path of [
      `/api/semantic/tables?connectionId=${a.connection}`,
      `/api/semantic/relationships?connectionId=${a.connection}`,
      `/api/semantic/kpis?connectionId=${a.connection}`,
      `/api/semantic/domains?connectionId=${a.connection}`,
    ]) {
      const res = await agent.get(path).set('Authorization', `Bearer ${tenantB.token}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('does not leak product tables or columns', async () => {
    const agent = await request();
    const tables = await agent
      .get(`/api/semantic/product-tables?dataProductId=${a.product}`)
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(tables.status).toBe(404);

    const cols = await agent
      .get(`/api/semantic/product-columns?tablePgId=${a.productTable}`)
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(cols.status).toBe(404);
  });

  it('refuses writes before they reach the graph', async () => {
    const agent = await request();
    const patchTable = await agent
      .patch(`/api/semantic/tables/${a.table}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .send({ description: 'tampered by another tenant' });
    expect(patchTable.status).toBe(404);

    const patchColumn = await agent
      .patch(`/api/semantic/columns/${a.column}`)
      .set('Authorization', `Bearer ${tenantB.token}`)
      .send({ description: 'tampered by another tenant' });
    expect(patchColumn.status).toBe(404);

    const del = await agent
      .delete(`/api/semantic/relationships/${a.relationship}`)
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect(del.status).toBe(404);
  });

  it('leaves the row untouched after a refused write', async () => {
    // The refusal must happen BEFORE the graph write, and the Postgres mirror
    // must be unchanged — otherwise the two stores diverge silently.
    const row = await getTestDb()('source_tables').where({ id: a.table }).first();
    expect(row.description ?? null).toBeNull();
    const rel = await getTestDb()('table_relationships').where({ id: a.relationship }).first();
    expect(rel).toBeTruthy();
  });

  it('does not leak another tenants products via the unparameterised product tree', async () => {
    const res = await (await request())
      .get('/api/semantic/product-tree')
      .set('Authorization', `Bearer ${tenantB.token}`);
    // The graph is unavailable in CI, so this may fail for that reason — what
    // must never happen is a 200 that contains tenant A's product.
    if (res.status === 200) {
      const ids = (res.body?.data ?? []).map((p: { productId: number }) => Number(p.productId));
      expect(ids).not.toContain(a.product);
    }
  });
});
