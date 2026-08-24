/**
 * Managed grids — /api/grids + the pure derivation/coercion layer.
 *
 * What this guards, beyond "the route returns 200":
 *  1. **Identifier safety** — user-chosen names become warehouse identifiers
 *     (view name, parquet columns). The derivation must be total and its
 *     output must satisfy the strict patterns, whatever the input.
 *  2. **Tenant isolation** — grids are enumerable by id; the other tenant
 *     gets 404 (never 403 — a 403 confirms the id exists).
 *  3. **Role gate** — analyst allowed, viewer refused on every route.
 *  4. **Spreadsheet-shaped values** — `1.234,56` and `21/08/2026` are what a
 *     Belgian Excel produces; refusing them would make paste useless.
 *  5. **Save is truth-first** — rows commit even when warehouse
 *     materialisation fails (the route records the error instead of 500ing).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import {
  deriveGridSlug,
  deriveColumnKey,
  normalizeColumns,
  coerceRow,
  parseFlexibleNumber,
  parseFlexibleDate,
  isValidGridSlug,
  isValidColumnKey,
  GridValidationError,
} from '../services/managedGrids';
import { gridViewName, gridBasePath } from '../services/warehouse';

// ─── Pure derivation layer ──────────────────────────────────────────────────

describe('grid identifier derivation', () => {
  it('derives safe slugs from arbitrary names', () => {
    expect(deriveGridSlug('Budget 2026')).toBe('budget_2026');
    expect(deriveGridSlug('  Omzet / regio!  ')).toBe('omzet_regio');
    expect(deriveGridSlug('2026 targets')).toBe('g_2026_targets');
    expect(deriveGridSlug('***')).toBe('table');
    for (const name of ['Budget 2026', "a'; DROP TABLE--", '€€€', 'x'.repeat(200)]) {
      const slug = deriveGridSlug(name);
      expect(isValidGridSlug(slug)).toBe(true);
    }
  });

  it('derives unique, safe column keys', () => {
    const taken = new Set<string>();
    const k1 = deriveColumnKey('GL account', taken); taken.add(k1);
    const k2 = deriveColumnKey('GL Account', taken); taken.add(k2);
    expect(k1).toBe('gl_account');
    expect(k2).toBe('gl_account_2');
    expect(isValidColumnKey(deriveColumnKey('1st month', new Set()))).toBe(true);
    expect(isValidColumnKey(deriveColumnKey('!!!', new Set()))).toBe(true);
  });

  it('normalizeColumns keeps supplied keys and refuses duplicates', () => {
    const cols = normalizeColumns([
      { key: 'amount', name: 'Renamed amount', type: 'number' },
      { name: 'Period', type: 'date' },
    ]);
    expect(cols[0]).toEqual({ key: 'amount', name: 'Renamed amount', type: 'number' });
    expect(cols[1].key).toBe('period');
    expect(() => normalizeColumns([
      { key: 'a', name: 'A', type: 'text' },
      { key: 'a', name: 'B', type: 'text' },
    ])).toThrow(GridValidationError);
    expect(() => normalizeColumns([])).toThrow(GridValidationError);
  });

  it('gridViewName + gridBasePath follow the naming contract', () => {
    expect(gridViewName('budget_2026')).toBe('grid_budget_2026');
    const p = gridBasePath(42, 7, 3).replace(/\\/g, '/');
    expect(p).toContain('tenant_42');
    expect(p).toContain('grids/grid_7_v3');
  });
});

describe('spreadsheet-shaped value parsing', () => {
  it('parses eu and en number formats', () => {
    expect(parseFlexibleNumber('1.234,56')).toBe(1234.56);
    expect(parseFlexibleNumber('1,234.56')).toBe(1234.56);
    expect(parseFlexibleNumber('12,5')).toBe(12.5);
    expect(parseFlexibleNumber('1,234,567')).toBe(1234567);
    expect(parseFlexibleNumber('€ 120 000')).toBe(120000);
    expect(parseFlexibleNumber('-3.5')).toBe(-3.5);
    expect(parseFlexibleNumber('abc')).toBeNull();
    expect(parseFlexibleNumber('')).toBeNull();
  });

  it('parses iso and day-first dates', () => {
    expect(parseFlexibleDate('2026-08-21')).toBe('2026-08-21');
    expect(parseFlexibleDate('21/08/2026')).toBe('2026-08-21');
    expect(parseFlexibleDate('1.9.2026')).toBe('2026-09-01');
    expect(parseFlexibleDate('2026/08/21')).toBe('2026-08-21');
    expect(parseFlexibleDate('21/13/2026')).toBeNull();
    expect(parseFlexibleDate('not a date')).toBeNull();
  });

  it('coerceRow validates per type, drops undeclared keys, and names the failure', () => {
    const cols = normalizeColumns([
      { name: 'Category', type: 'text' },
      { name: 'Amount', type: 'number' },
      { name: 'Period', type: 'date' },
      { name: 'Active', type: 'boolean' },
    ]);
    const clean = coerceRow(
      { category: 'Rent', amount: '1.234,56', period: '21/08/2026', active: 'yes', stale_key: 'x' },
      cols, 0,
    );
    expect(clean).toEqual({ category: 'Rent', amount: 1234.56, period: '2026-08-21', active: true });
    expect('stale_key' in clean).toBe(false);
    expect(() => coerceRow({ amount: 'oops' }, cols, 4)).toThrow(/Row 5.*Amount.*not a number/s);
  });
});

// ─── Routes ─────────────────────────────────────────────────────────────────

let adminToken: string;
let analystToken: string;
let viewerToken: string;
let otherToken: string;
let tenantId: number;
let gridId: number;

describe('/api/grids', () => {
  beforeAll(async () => {
    await cleanTestDb();
    const admin = await registerUser({ email: 'grids-admin@test.com', companyName: 'GridCo' });
    adminToken = admin.token;
    tenantId = admin.user.tenantId;
    analystToken = makeToken({ tenantId, role: 'analyst', email: 'grids-analyst@test.com' });
    viewerToken = makeToken({ tenantId, role: 'viewer', email: 'grids-viewer@test.com' });
    const other = await registerUser({ email: 'grids-other@test.com', companyName: 'OtherGridCo' });
    otherToken = other.token;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('creates a grid with derived keys and slug', async () => {
    const res = await (await request())
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Budget 2026',
        kind: 'budget',
        columns: [
          { name: 'Category', type: 'text' },
          { name: 'Period', type: 'date' },
          { name: 'Amount', type: 'number' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    gridId = res.body.data.id;
    expect(res.body.data.slug).toBe('budget_2026');
    expect(res.body.data.viewName).toBe('grid_budget_2026');
    expect(res.body.data.columns.map((c: { key: string }) => c.key)).toEqual(['category', 'period', 'amount']);
    // Materialisation ran (or recorded why it couldn't) — never silence.
    const row = await getTestDb()('managed_grids').where({ id: gridId }).first();
    expect(row.warehouse_path !== null || row.materialize_error !== null).toBe(true);
  });

  it('refuses a name that collides on slug', async () => {
    const res = await (await request())
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'budget   2026!', columns: [{ name: 'A', type: 'text' }] });
    expect(res.status).toBe(409);
  });

  it('saves rows with spreadsheet-shaped values and updates the count', async () => {
    const res = await (await request())
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${analystToken}`)
      .send({
        rows: [
          { data: { category: 'Rent', period: '21/01/2026', amount: '1.250,00' } },
          { data: { category: 'Salaries', period: '2026-01-21', amount: 84000 } },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.rowCount).toBe(2);
    const stored = await getTestDb()('managed_grid_rows')
      .where({ grid_id: gridId })
      .orderBy('position', 'asc');
    expect(stored).toHaveLength(2);
    expect(stored[0].data.amount).toBe(1250);
    expect(stored[0].data.period).toBe('2026-01-21');
  });

  it('rejects an invalid value with the row and column named', async () => {
    const res = await (await request())
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${analystToken}`)
      .send({ rows: [{ data: { category: 'X', amount: 'twelve' } }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Row 1/);
    expect(res.body.error).toMatch(/Amount/);
    // The failed save must not have replaced the previous rows.
    const stored = await getTestDb()('managed_grid_rows').where({ grid_id: gridId });
    expect(stored).toHaveLength(2);
  });

  it('renaming keeps the slug; column update with preserved key survives', async () => {
    const res = await (await request())
      .put(`/api/grids/${gridId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Budget FY26',
        columns: [
          { key: 'category', name: 'Cost category', type: 'text' },
          { key: 'period', name: 'Period', type: 'date' },
          { key: 'amount', name: 'Amount', type: 'number' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Budget FY26');
    expect(res.body.data.slug).toBe('budget_2026');
    expect(res.body.data.columns[0]).toEqual({ key: 'category', name: 'Cost category', type: 'text' });
  });

  it('lists the tenant grids', async () => {
    const res = await (await request()).get('/api/grids').set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].rowCount).toBe(2);
  });

  it('is tenant-isolated: the other tenant sees nothing and gets 404 by id', async () => {
    const list = await (await request()).get('/api/grids').set('Authorization', `Bearer ${otherToken}`);
    expect(list.body.data).toHaveLength(0);
    for (const [method, path] of [
      ['get', `/api/grids/${gridId}`],
      ['delete', `/api/grids/${gridId}`],
    ] as const) {
      const res = await (await request())[method](path).set('Authorization', `Bearer ${otherToken}`);
      expect(res.status).toBe(404);
    }
    const rowsRes = await (await request())
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ rows: [] });
    expect(rowsRes.status).toBe(404);
  });

  it('refuses viewers on every route', async () => {
    for (const res of await Promise.all([
      (await request()).get('/api/grids').set('Authorization', `Bearer ${viewerToken}`),
      (await request()).post('/api/grids').set('Authorization', `Bearer ${viewerToken}`).send({ name: 'X', columns: [{ name: 'A', type: 'text' }] }),
      (await request()).get(`/api/grids/${gridId}`).set('Authorization', `Bearer ${viewerToken}`),
      (await request()).put(`/api/grids/${gridId}/rows`).set('Authorization', `Bearer ${viewerToken}`).send({ rows: [] }),
      (await request()).delete(`/api/grids/${gridId}`).set('Authorization', `Bearer ${viewerToken}`),
    ])) {
      expect(res.status).toBe(403);
    }
  });

  it('enforces the row cap with a business-language refusal', async () => {
    const rows = Array.from({ length: 10_001 }, () => ({ data: {} }));
    const res = await (await request())
      .put(`/api/grids/${gridId}/rows`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows });
    expect(res.status).toBe(400);
  });

  // ─── Linked columns + the topics graph ───────────────────────────────────

  it('links: round-trips a column link and refuses unsafe targets', async () => {
    const res = await (await request())
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Region mapping',
        kind: 'mapping',
        columns: [
          { name: 'Customer', type: 'text', link: { table: 'dim_customer', column: 'customer_name' } },
          { name: 'Region', type: 'text' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.columns[0].link).toEqual({ table: 'dim_customer', column: 'customer_name' });
    expect(res.body.data.columns[1].link).toBeUndefined();

    const bad = await (await request())
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Bad link',
        columns: [{ name: 'X', type: 'text', link: { table: 'dim; DROP', column: 'a' } }],
      });
    expect(bad.status).toBe(400);
  });

  it('linkable-columns lists built dimension columns, not measures or technical', async () => {
    const db = getTestDb();
    const [product] = await db('data_products')
      .insert({ tenant_id: tenantId, connection_id: null, name: 'Sales', status: 'approved', kind: 'analytics' })
      .returning('id');
    const productId = Number((product as { id?: number }).id ?? product);
    const [schema] = await db('star_schemas')
      .insert({ tenant_id: tenantId, data_product_id: productId, name: 'sales_star', fact_table_type: 'transaction' })
      .returning('id');
    const schemaId = Number((schema as { id?: number }).id ?? schema);
    const inserted = await db('product_tables')
      .insert([
        {
          tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_customer',
          display_name: 'Customers', table_role: 'dimension', dag_order: 0,
          transformation_status: 'success', delta_path: '/tmp/x/dim_customer', row_count: 57,
        },
        {
          tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fact_sales',
          display_name: 'Sales', table_role: 'fact', dag_order: 1,
          transformation_status: 'success', delta_path: '/tmp/x/fact_sales', row_count: 100,
        },
      ])
      .returning('id');
    const dimId = Number((inserted[0] as { id?: number }).id ?? inserted[0]);
    const factId = Number((inserted[1] as { id?: number }).id ?? inserted[1]);
    await db('product_columns').insert([
      { tenant_id: tenantId, product_table_id: dimId, column_name: 'customer_name', data_type: 'VARCHAR', column_role: 'natural_key', is_technical: false },
      { tenant_id: tenantId, product_table_id: dimId, column_name: 'lifetime_value', data_type: 'DOUBLE', column_role: 'measure', is_technical: false },
      { tenant_id: tenantId, product_table_id: dimId, column_name: 'customer_key', data_type: 'INTEGER', column_role: 'surrogate_key', is_technical: true },
      { tenant_id: tenantId, product_table_id: factId, column_name: 'amount', data_type: 'DOUBLE', column_role: 'measure', is_technical: false },
    ]);
    await db('product_relationships').insert({
      tenant_id: tenantId, star_schema_id: schemaId,
      from_table_id: factId, from_column_name: 'customer_key',
      to_table_id: dimId, to_column_name: 'customer_key',
      relationship_type: 'fact_to_dim',
    });

    const res = await (await request())
      .get('/api/grids/linkable-columns')
      .set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    const tables = res.body.data as Array<{ tableName: string; columns: Array<{ name: string }> }>;
    const dim = tables.find((t) => t.tableName === 'dim_customer');
    expect(dim).toBeDefined();
    expect(dim!.columns.map((c) => c.name)).toEqual(['customer_name']);
    expect(tables.find((t) => t.tableName === 'fact_sales')).toBeUndefined();
  });

  it('link-values 404s for a target that does not resolve', async () => {
    const res = await (await request())
      .get('/api/grids/link-values?table=dim_nope&column=whatever')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    // A two-field combination needs BOTH columns on the same table.
    const res2 = await (await request())
      .get('/api/grids/link-values?table=dim_customer&column=customer_name&column2=not_a_column')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res2.status).toBe(404);
  });

  it('coverage reports target-missing for a stale link, and nothing for no links', async () => {
    const created = await (await request())
      .post('/api/grids')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Stale map',
        kind: 'mapping',
        columns: [{ name: 'Old', type: 'text', link: { table: 'dim_gone', column: 'name' } }],
      });
    const staleId = created.body.data.id as number;
    const cov = await (await request())
      .get(`/api/grids/${staleId}/coverage`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(cov.status).toBe(200);
    expect(cov.body.data.columns).toHaveLength(1);
    expect(cov.body.data.columns[0].status).toBe('target-missing');

    const noLinks = await (await request())
      .get(`/api/grids/${gridId}/coverage`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(noLinks.status).toBe(200);
    expect(noLinks.body.data.columns).toHaveLength(0);
  });

  it('topics-graph ships tables, relationships and grids with their links', async () => {
    const res = await (await request())
      .get('/api/relationships/topics-graph')
      .set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    const data = res.body.data as {
      tables: Array<{ tableName: string; topic: string; columns: Array<{ name: string }> }>;
      relationships: Array<{ fromTable: string; toTable: string; toColumn: string }>;
      grids: Array<{ name: string; viewName: string; columns: Array<{ key: string; link?: unknown }> }>;
    };
    const dim = data.tables.find((t) => t.tableName === 'dim_customer');
    expect(dim).toBeDefined();
    expect(dim!.topic).toBe('Sales');
    // The surrogate key is technical BUT a relationship endpoint — it ships.
    expect(dim!.columns.map((c) => c.name)).toContain('customer_key');
    expect(data.relationships.some((r) => r.fromTable === 'fact_sales' && r.toTable === 'dim_customer')).toBe(true);
    const mapping = data.grids.find((g) => g.name === 'Region mapping');
    expect(mapping).toBeDefined();
    expect(mapping!.viewName).toBe('grid_region_mapping');
    expect(mapping!.columns[0].link).toEqual({ table: 'dim_customer', column: 'customer_name' });
    // Other tenant sees none of it.
    const other = await (await request())
      .get('/api/relationships/topics-graph')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(other.body.data.tables).toHaveLength(0);
    expect(other.body.data.grids).toHaveLength(0);
  });

  it('topics-graph keeps edges landing on draft stubs and derives fk-metadata joins', async () => {
    // The production shape: a consuming product holds a STUB copy of a shared
    // dim (transformation_sql null, status stuck at 'draft' — the bus-matrix
    // flow never ran it through the skip-path), and the built relationship
    // references the STUB's id. Filtering stubs out by status silently
    // dropped every fact→shared-dim edge — the 2026-08-24 empty canvas.
    const db = getTestDb();
    const [p2] = await db('data_products')
      .insert({ tenant_id: tenantId, connection_id: null, name: 'General Ledger', status: 'approved', kind: 'analytics' })
      .returning('id');
    const p2Id = Number((p2 as { id?: number }).id ?? p2);
    const [s2] = await db('star_schemas')
      .insert({ tenant_id: tenantId, data_product_id: p2Id, name: 'gl_star', fact_table_type: 'transaction' })
      .returning('id');
    const s2Id = Number((s2 as { id?: number }).id ?? s2);
    const inserted = await db('product_tables')
      .insert([
        {
          tenant_id: tenantId, star_schema_id: s2Id, table_name: 'dim_customer',
          display_name: 'Customers', table_role: 'dimension', dag_order: 0,
          is_shared_dimension: true, transformation_status: 'draft', transformation_sql: null,
        },
        {
          tenant_id: tenantId, star_schema_id: s2Id, table_name: 'fact_gl',
          display_name: 'GL lines', table_role: 'fact', dag_order: 1,
          transformation_status: 'success', delta_path: '/tmp/x/fact_gl', row_count: 9,
        },
      ])
      .returning('id');
    const stubId = Number((inserted[0] as { id?: number }).id ?? inserted[0]);
    const glFactId = Number((inserted[1] as { id?: number }).id ?? inserted[1]);
    await db('product_columns').insert([
      { tenant_id: tenantId, product_table_id: glFactId, column_name: 'amount', data_type: 'DOUBLE', column_role: 'measure', is_technical: false },
      // Asserted by a relationship row below — synthesis must NOT duplicate it.
      { tenant_id: tenantId, product_table_id: glFactId, column_name: 'customer_key', data_type: 'INTEGER', column_role: 'foreign_key', is_technical: true, fk_target_table: 'dim_customer', fk_target_column: 'customer_key' },
      // No relationship row anywhere — must be derived from this metadata.
      { tenant_id: tenantId, product_table_id: glFactId, column_name: 'owner_key', data_type: 'INTEGER', column_role: 'foreign_key', is_technical: true, fk_target_table: 'dim_customer', fk_target_column: 'customer_key' },
    ]);
    await db('product_relationships').insert({
      tenant_id: tenantId, star_schema_id: s2Id,
      from_table_id: glFactId, from_column_name: 'customer_key',
      to_table_id: stubId, to_column_name: 'customer_key',
      relationship_type: 'fact_to_dim',
    });

    const res = await (await request())
      .get('/api/relationships/topics-graph')
      .set('Authorization', `Bearer ${analystToken}`);
    expect(res.status).toBe(200);
    const data = res.body.data as {
      tables: Array<{ tableName: string; topic: string; isStub: boolean }>;
      relationships: Array<{ id: number; fromTable: string; fromColumn: string; toTable: string; toColumn: string }>;
    };

    // Both copies ship — the draft stub included — and say which is which.
    const copies = data.tables.filter((t) => t.tableName === 'dim_customer');
    expect(copies).toHaveLength(2);
    expect(copies.filter((t) => t.isStub)).toHaveLength(1);
    expect(copies.find((t) => t.isStub)!.topic).toBe('General Ledger');

    // The edge landing on the draft stub survives.
    const stubEdge = data.relationships.find((r) => r.fromTable === 'fact_gl' && r.fromColumn === 'customer_key');
    expect(stubEdge).toBeDefined();
    expect(stubEdge!.toTable).toBe('dim_customer');
    expect(stubEdge!.id).toBeGreaterThan(0);

    // The metadata-only join is derived; the asserted one is not duplicated.
    const derived = data.relationships.filter((r) => r.fromTable === 'fact_gl' && r.fromColumn === 'owner_key');
    expect(derived).toHaveLength(1);
    expect(derived[0].id).toBeLessThan(0);
    expect(derived[0].toColumn).toBe('customer_key');
    expect(data.relationships.filter((r) => r.fromTable === 'fact_gl' && r.fromColumn === 'customer_key')).toHaveLength(1);
  });

  it('deletes the grid and its rows', async () => {
    const res = await (await request())
      .delete(`/api/grids/${gridId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const db = getTestDb();
    expect(await db('managed_grids').where({ id: gridId }).first()).toBeUndefined();
    expect(await db('managed_grid_rows').where({ grid_id: gridId })).toHaveLength(0);
  });
});
