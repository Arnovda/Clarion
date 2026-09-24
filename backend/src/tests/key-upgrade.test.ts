/**
 * STABLE INTEGER KEYS (clarion_key), end to end on real DuckDB + Postgres.
 *
 * The defect the owner found (2026-09-24, catalog SQL tab of Reference ›
 * Account): the lookup's key was `ROW_NUMBER() OVER (ORDER BY a.ID)`. A new
 * account lands mid-order, every key after it shifts, and a fact built
 * earlier keeps the old numbers — invoice lines silently move to the
 * neighbouring customer. This suite pins, against the real runner:
 *
 *   - a lone "Rebuild now" of such a lookup is refused (and of a subject
 *     owning one), because it is the corruption path;
 *   - a save that switches ONE end of a join to clarion_key is refused;
 *   - the upgrade plans the lookup deterministically and hands the fact
 *     (which found its key by joining the lookup) to the model — whose
 *     rewrite is checked before anything is stored, and a bad one changes
 *     NOTHING;
 *   - after a good upgrade every key is a BIGINT, the fact still joins its
 *     lookup with the same totals, and the lookup can be rebuilt on its own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'duckdb-async';

process.env.STORAGE_FORMAT = 'parquet';

// The ONE mocked thing: the model's rewrite of the fact. Each test sets what
// it returns; everything the service does with it runs for real.
const rewriteMock = vi.fn();
vi.mock('../ai/AIService', async (orig) => ({
  ...(await orig<typeof import('../ai/AIService')>()),
  rewriteForeignKeysToClarionKey: (...args: unknown[]) => rewriteMock(...args),
}));

import { request, registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { runProductTransformation } from '../services/transformationRunner';
import { runKeyUpgradeWorkflow, planKeyUpgrade, relationOfExpression, readsOnlySources } from '../services/keyUpgrade';
import { loadKeyGraph, summariseKeyHealth, declarationKeyViolations, type KeyGraph } from '../services/keyHealth';
import { tenantQuery } from '../services/tenantQuery';
import { busMatrixKeyViolations } from '../services/busMatrixBuilder';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

const warehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-key-upgrade-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

let adminToken: string;
let tenantId: number;
let connectionId: number;
let productId: number;
let dimId: number;
let factId: number;

const DIM_SQL = `SELECT ROW_NUMBER() OVER (ORDER BY a.ID) AS account_key, a.ID AS account_id, a.Name AS account_name FROM Accounts a`;
const FACT_SQL = `SELECT i.InvoiceID AS invoice_id, d.account_key AS account_key, i.AmountDC AS amount FROM SalesInvoices i LEFT JOIN dim_account d ON d.account_id = i.InvoiceTo`;
const GOOD_FACT = `SELECT i.InvoiceID AS invoice_id, clarion_key('Accounts', i.InvoiceTo) AS account_key, i.AmountDC AS amount FROM SalesInvoices i`;

async function writeSourceTable(entity: string, selectSql: string) {
  const dir = path.join(warehouse, entity);
  fs.mkdirSync(dir, { recursive: true });
  const db = await Database.create(':memory:');
  try {
    await db.exec(`COPY (${selectSql}) TO '${path.join(dir, 'data.parquet').replace(/'/g, "''")}' (FORMAT PARQUET)`);
  } finally { await db.close(); }
}

async function readProductTable(tableId: number, sql: string): Promise<Array<Record<string, unknown>>> {
  const row = await getTestDb()('product_tables').where({ id: tableId }).first();
  const db = await Database.create(':memory:');
  try {
    return await db.all(sql.replace('$T', `read_parquet('${path.join(row.delta_path, 'data.parquet').replace(/'/g, "''")}')`)) as Array<Record<string, unknown>>;
  } finally { await db.close(); }
}

async function totalsByName(): Promise<Array<[string, number]>> {
  const dim = await getTestDb()('product_tables').where({ id: dimId }).first();
  const fact = await getTestDb()('product_tables').where({ id: factId }).first();
  const db = await Database.create(':memory:');
  try {
    const rows = await db.all(`
      SELECT d.account_name AS name, SUM(f.amount) AS total
      FROM read_parquet('${path.join(fact.delta_path, 'data.parquet')}') f
      JOIN read_parquet('${path.join(dim.delta_path, 'data.parquet')}') d ON d.account_key = f.account_key
      GROUP BY 1 ORDER BY 1`) as Array<{ name: string; total: number }>;
    return rows.map((r) => [r.name, Number(r.total)]);
  } finally { await db.close(); }
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@keys.test', companyName: 'Keys BV' });
  adminToken = admin.token; tenantId = admin.user.tenantId;

  await writeSourceTable('Accounts', `SELECT * FROM (VALUES ('a1', 'Van Damme BVBA'), ('a2', 'Peeters NV'), ('a3', 'Nord GmbH')) t(ID, Name)`);
  await writeSourceTable('SalesInvoices', `SELECT * FROM (VALUES ('i1', 'a1', 100.0), ('i2', 'a1', 250.0), ('i3', 'a2', 80.0), ('i4', 'a3', 999.5)) t(InvoiceID, InvoiceTo, AmountDC)`);

  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Exact (keys)', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts', 'SalesInvoices'], warehouse_path: warehouse, query_engine: 'duckdb',
    last_sync_status: 'succeeded', config: JSON.stringify({}),
  }).returning('id');
  connectionId = idOf(conn);
  const [product] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: 'Sales', description: 'keys', status: 'approved', kind: 'analytics',
  }).returning('id');
  productId = idOf(product);
  const [schema] = await db('star_schemas').insert({
    tenant_id: tenantId, data_product_id: productId, name: 'Sales star', grain: 'one row per invoice',
  }).returning('id');
  const [dim] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'dim_account', table_role: 'dimension', dag_order: 0, transformation_sql: DIM_SQL,
  }).returning('id');
  const [fact] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'fact_sales_invoices', table_role: 'fact', dag_order: 1, transformation_sql: FACT_SQL,
  }).returning('id');
  dimId = idOf(dim); factId = idOf(fact);
  await db('product_columns').insert([
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_key', data_type: 'BIGINT', column_role: 'surrogate_key', sort_order: 0 },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_id', data_type: 'VARCHAR', column_role: 'natural_key', sort_order: 1 },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_name', data_type: 'VARCHAR', column_role: 'attribute', sort_order: 2 },
    { tenant_id: tenantId, product_table_id: factId, column_name: 'invoice_id', data_type: 'VARCHAR', column_role: 'degenerate_dimension', sort_order: 0 },
    { tenant_id: tenantId, product_table_id: factId, column_name: 'account_key', data_type: 'BIGINT', column_role: 'foreign_key', fk_target_table: 'dim_account', fk_target_column: 'account_key', sort_order: 1 },
    { tenant_id: tenantId, product_table_id: factId, column_name: 'amount', data_type: 'DOUBLE', column_role: 'measure', sort_order: 2 },
  ]);
  await db('product_relationships').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), from_table_id: factId, from_column_name: 'account_key',
    to_table_id: dimId, to_column_name: 'account_key', relationship_type: 'fact_to_dim',
  });

  const productRow = await db('data_products').where({ id: productId }).first();
  const results = await runProductTransformation(productRow, await db('product_tables').whereIn('id', [dimId, factId]), tenantId);
  expect(results.map((r) => r.status)).toEqual(['success', 'success']);
});

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(warehouse, { recursive: true, force: true });
});

describe('the ROW_NUMBER-era state is recognised and guarded', () => {
  it('reads the lookup as renumbering and the fact as holding its keys', async () => {
    const graph = await tenantQuery(tenantId, (db) => loadKeyGraph(db, tenantId, connectionId));
    const health = summariseKeyHealth(graph);
    expect(health.unstable.map((t) => t.table_name)).toEqual(['dim_account']);
    expect(health.raw.map((t) => t.table_name)).toEqual(['fact_sales_invoices']);
    expect(health.hashed).toBe(0);
  });

  it('refuses "Rebuild now" on the lookup alone — the corruption path — but not on the fact', async () => {
    const r = await (await request()).post(`/api/products/tables/${dimId}/run`).set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('unstable_keys');
    expect(r.body.error).toMatch(/fact_sales_invoices/);
    expect(r.body.error).toMatch(/Upgrade the keys/);
    const f = await (await request()).post(`/api/products/tables/${factId}/run`).set('Authorization', `Bearer ${adminToken}`);
    expect(f.status).toBe(200);
  });

  it('refuses a subject rebuild that would renumber a lookup its facts elsewhere depend on — only when the facts are OUTSIDE it', async () => {
    // Here the fact is in the same subject, so the subject rebuild is safe.
    const r = await (await request()).post(`/api/products/${productId}/refresh-start`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(r.status).not.toBe(409);
  });

  it('refuses a save that switches ONE end of the join, and says how to fix it', async () => {
    const r = await (await request()).put(`/api/products/tables/${dimId}/sql`).set('Authorization', `Bearer ${adminToken}`)
      .send({ sql: DIM_SQL.replace('ROW_NUMBER() OVER (ORDER BY a.ID)', "clarion_key('Accounts', a.ID)") });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('key_rule');
    expect(r.body.error).toMatch(/clarion_key/);
    const stored = await getTestDb()('product_tables').where({ id: dimId }).first();
    expect(stored.transformation_sql).toBe(DIM_SQL);
  });

  it('the dry run says what an upgrade would do, and that the fact needs the assistant', async () => {
    const r = await (await request()).post('/api/products/keys/upgrade-start').set('Authorization', `Bearer ${adminToken}`)
      .send({ connectionId, dryRun: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ tables: 2, byAssistant: 1, blockers: [], unstable: ['dim_account'] });
  });

  it('the Build page reports counts only — no table names', async () => {
    const r = await (await request()).get('/api/products/build-overview').set('Authorization', `Bearer ${adminToken}`);
    const src = (r.body.data.sources as Array<{ id: number; keys: unknown }>).find((s) => s.id === connectionId);
    expect(src?.keys).toEqual({ toUpgrade: 2, renumbering: 1, rebuildInstead: 0 });
    expect(JSON.stringify(src?.keys)).not.toMatch(/dim_|fact_/);
  });
});

describe('the upgrade', () => {
  const emitted: string[] = [];
  const emit = (e: { type: string; text?: string }) => { if (e.text) emitted.push(`${e.type}: ${e.text}`); };

  it('a model rewrite that changes a column is refused and NOTHING is stored', async () => {
    rewriteMock.mockResolvedValueOnce({ sql: GOOD_FACT.replace('i.AmountDC AS amount', 'i.AmountDC AS amount_dc'), notes: '' });
    await expect(runKeyUpgradeWorkflow({ connectionId, tenantId, userEmail: 'admin@keys.test', emit }))
      .rejects.toThrow(/columns changed.*Nothing was changed/);
    const db = getTestDb();
    expect((await db('product_tables').where({ id: dimId }).first()).transformation_sql).toBe(DIM_SQL);
    expect((await db('product_tables').where({ id: factId }).first()).transformation_sql).toBe(FACT_SQL);
  });

  it('a model rewrite that hashes the wrong entity is refused too', async () => {
    rewriteMock.mockResolvedValueOnce({ sql: GOOD_FACT.replace("'Accounts'", "'Account'"), notes: '' });
    await expect(runKeyUpgradeWorkflow({ connectionId, tenantId, emit })).rejects.toThrow(/expected clarion_key\('accounts'/);
    expect((await getTestDb()('product_tables').where({ id: factId }).first()).transformation_sql).toBe(FACT_SQL);
  });

  it('a good upgrade stores both, rebuilds together, and every join still lands on the same row', async () => {
    const before = await totalsByName();
    rewriteMock.mockResolvedValueOnce({ sql: GOOD_FACT, notes: 'Computed the account key from the invoice.' });
    const result = await runKeyUpgradeWorkflow({ connectionId, tenantId, userEmail: 'admin@keys.test', emit });
    expect(result).toMatchObject({ allOk: true, tablesChanged: 2, rebuiltProducts: 1 });

    const db = getTestDb();
    const dim = await db('product_tables').where({ id: dimId }).first();
    expect(dim.transformation_sql).toBe(`SELECT clarion_key('Accounts', a.ID) AS account_key, a.ID AS account_id, a.Name AS account_name FROM Accounts a`);
    expect(dim.declared_by).toBe('admin@keys.test (key upgrade)');
    const fact = await db('product_tables').where({ id: factId }).first();
    expect(fact.transformation_sql).toBe(GOOD_FACT);

    const types = await readProductTable(factId, 'SELECT typeof(account_key) AS t FROM $T LIMIT 1');
    expect(types[0].t).toBe('BIGINT');
    const keyCol = await db('product_columns').where({ product_table_id: dimId, column_name: 'account_key' }).first();
    expect(keyCol.data_type).toBe('BIGINT');

    // Same customers, same totals — the join survived the re-keying.
    expect(await totalsByName()).toEqual(before);
    expect(before).toEqual([['Nord GmbH', 999.5], ['Peeters NV', 80], ['Van Damme BVBA', 350]]);
    expect(emitted.some((l) => l.startsWith('done: Keys upgraded'))).toBe(true);
  });

  it('after the upgrade the lookup can be rebuilt on its own — even after a new account lands mid-order', async () => {
    await writeSourceTable('Accounts', `SELECT * FROM (VALUES ('a0', 'Aardvark BV'), ('a1', 'Van Damme BVBA'), ('a2', 'Peeters NV'), ('a3', 'Nord GmbH')) t(ID, Name)`);
    const r = await (await request()).post(`/api/products/tables/${dimId}/run`).set('Authorization', `Bearer ${adminToken}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The fact was NOT rebuilt; with ROW_NUMBER every total would now be on the wrong name.
    expect(await totalsByName()).toEqual([['Nord GmbH', 999.5], ['Peeters NV', 80], ['Van Damme BVBA', 350]]);
  });

  it('health reads every key as clarion_key now, and the upgrade has nothing left to do', async () => {
    const graph = await tenantQuery(tenantId, (db) => loadKeyGraph(db, tenantId, connectionId));
    expect(summariseKeyHealth(graph)).toMatchObject({ unstable: [], raw: [], hashed: 2 });
    expect(planKeyUpgrade(graph).steps).toEqual([]);
  });
});

describe('the plan (pure)', () => {
  const graph = (dimSql: string, factSql: string): KeyGraph => ({
    tables: [
      { id: 1, table_name: 'dim_item', table_role: 'dimension', transformation_sql: dimSql, product_id: 1, product_name: 'Reference', connection_id: 1,
        columns: [
          { id: 1, column_name: 'item_key', column_role: 'surrogate_key', transformation_expression: null, data_type: 'VARCHAR', fk_target_table: null, fk_target_column: null },
          { id: 2, column_name: 'item_id', column_role: 'natural_key', transformation_expression: null, data_type: 'VARCHAR', fk_target_table: null, fk_target_column: null },
        ] },
      { id: 2, table_name: 'fact_lines', table_role: 'fact', transformation_sql: factSql, product_id: 2, product_name: 'Sales', connection_id: 1,
        columns: [{ id: 3, column_name: 'item_key', column_role: 'foreign_key', transformation_expression: null, data_type: 'VARCHAR', fk_target_table: 'dim_item', fk_target_column: 'item_key' }] },
    ],
    joins: [{ from_table_id: 2, to_table_id: 1, from_table: 'fact_lines', from_column: 'item_key', to_table: 'dim_item', to_column: 'item_key' }],
  });

  it('the raw-id form (phase 1) is rewritten directly on both ends — no model', () => {
    const plan = planKeyUpgrade(graph(
      'SELECT i.ID AS item_key, i.ID AS item_id FROM Items i',
      'SELECT TRY_CAST(l.Item AS VARCHAR) AS item_key, l.Amount FROM SalesInvoiceLines l',
    ));
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((s) => [s.tableName, s.sql, s.forModel.length])).toEqual([
      ['dim_item', "SELECT clarion_key('Items', i.ID) AS item_key, i.ID AS item_id FROM Items i", 0],
      ['fact_lines', "SELECT clarion_key('items', TRY_CAST(l.Item AS VARCHAR)) AS item_key, l.Amount FROM SalesInvoiceLines l", 0],
    ]);
  });

  it('a fact that looked its key up in the lookup goes to the model', () => {
    const plan = planKeyUpgrade(graph(
      'SELECT ROW_NUMBER() OVER (ORDER BY i.ID) AS item_key, i.ID AS item_id FROM Items i',
      'SELECT d.item_key AS item_key FROM SalesInvoiceLines l JOIN dim_item d ON d.item_id = l.Item',
    ));
    const fact = plan.steps.find((s) => s.tableName === 'fact_lines')!;
    expect(fact.forModel).toEqual([{ column: 'item_key', entity: 'items', lookupTable: 'dim_item', lookupNaturalColumn: 'item_id', lookupKeyColumn: 'item_key' }]);
    expect(fact.sql).toBe(fact.oldSql); // nothing guessed by text substitution
  });

  it('reads the entity off the alias, and knows a lookup read from a source read', () => {
    expect(relationOfExpression('SELECT a.ID FROM Accounts a JOIN X x ON 1=1', 'a.ID')).toBe('Accounts');
    expect(relationOfExpression('SELECT ID FROM Accounts', 'ID')).toBe('Accounts');
    const products = new Set(['dim_item']);
    expect(readsOnlySources('SELECT l.Item FROM SalesInvoiceLines l', 'l.Item', products)).toBe(true);
    expect(readsOnlySources('SELECT d.item_key FROM L l JOIN dim_item d ON 1=1', 'd.item_key', products)).toBe(false);
    expect(readsOnlySources('WITH c AS (SELECT 1) SELECT c.k FROM c', 'c.k', products)).toBe(false); // a CTE: cannot tell
  });

  it('the declaration check allows a legacy pair and refuses a one-sided switch', () => {
    const g = graph('SELECT i.ID AS item_key, i.ID AS item_id FROM Items i', 'SELECT l.Item AS item_key FROM L l');
    expect(declarationKeyViolations(g, 2, 'SELECT l.Item AS item_key, 1 AS x FROM L l')).toEqual([]);
    expect(declarationKeyViolations(g, 2, "SELECT clarion_key('Items', l.Item) AS item_key FROM L l").join('')).toMatch(/lookup's key is not/);
  });
});

describe('a new design is held to the rule (validateBusMatrix)', () => {
  const design = (dimKey: string, factKey: string) => ({
    conformed_dimensions: [{
      table_name: 'dim_account', display_name: 'Account', description: 'a', source_tables: ['Accounts'],
      transformation_sql: `SELECT ${dimKey} AS account_key, a.ID AS account_id FROM Accounts a`,
      columns: [
        { column_name: 'account_key', data_type: 'BIGINT', display_name: 'k', description: 'k', column_role: 'surrogate_key' },
        { column_name: 'account_id', data_type: 'VARCHAR', display_name: 'id', description: 'id', column_role: 'natural_key' },
      ],
    }],
    fact_tables: [{
      table_name: 'fact_sales', display_name: 'S', description: 'One row per line', grain: 'One row per line', fact_table_type: 'transaction',
      transformation_sql: `SELECT ${factKey} AS account_key, l.Amount AS amount FROM Lines l`, source_tables: ['Lines'], dimensions_used: ['dim_account'],
      columns: [{ column_name: 'account_key', data_type: 'BIGINT', display_name: 'k', description: 'k', column_role: 'foreign_key', fk_target_table: 'dim_account', fk_target_column: 'account_key' }],
    }],
    relationships: [],
    data_products: [], proposed_kpis: [], rationale: '', dim_date_range: { start: '2024-01-01', end: '2024-12-31' },
  }) as unknown as BusMatrixOutput;

  it('passes clarion_key on both ends (the relationship read from the column metadata)', () => {
    expect(busMatrixKeyViolations(design("clarion_key('Accounts', a.ID)", "clarion_key('Accounts', l.Account)"))).toEqual([]);
  });
  it('refuses the raw id, a ROW_NUMBER, and two ends that hash different entities', () => {
    expect(busMatrixKeyViolations(design('a.ID', 'l.Account')).join('\n')).toMatch(/must be clarion_key/);
    expect(busMatrixKeyViolations(design('ROW_NUMBER() OVER (ORDER BY a.ID)', "clarion_key('Accounts', l.Account)")).join('\n')).toMatch(/renumbered/);
    expect(busMatrixKeyViolations(design("clarion_key('Accounts', a.ID)", "clarion_key('Customers', l.Account)")).join('\n')).toMatch(/different entities/);
  });
});
