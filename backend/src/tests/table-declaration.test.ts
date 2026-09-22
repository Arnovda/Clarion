/**
 * THE DECLARATION CONTRACT (docs/backlog/declarative-data-engineering.md §3.4,
 * first slice). One editor, one store, one verb — and the three defects the
 * old `PUT /products/tables/:id/sql` carried, each pinned here:
 *
 *   1. It stored ANY text. Now the SQL is guarded (no reads outside the
 *      warehouse) and COMPILED in a real session before anything is written;
 *      a refusal stores nothing.
 *   2. It flipped a serving table to `draft`, so the table VANISHED from Ask
 *      AI (which filters on `success`). Now a serving table keeps serving and
 *      the declaration read model says "changed since the last build".
 *   3. It left the notebook's deploy cell alone, so the next Deploy copied
 *      the OLD cell back over the edit. Now the cell is synced on save.
 *
 * Plus: a shared dimension is edited at its owner, never through a stub; an
 * analyst may declare, a viewer may not; the assistant's proposal is guarded
 * and compiled the same way and is NEVER stored by itself; and the Definitions
 * read model unions the three stores under the caller's tenant only.
 *
 * Real DuckDB, real Parquet, the real session builder. The ONE mocked thing
 * is the model.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'duckdb-async';

process.env.STORAGE_FORMAT = 'parquet';

import { request, registerUser, createUserWithToken } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';

const proposals: Array<{ sql: string; summary: string }> = [];
const seenContexts: string[] = [];
vi.mock('../ai/AIService', async (orig) => ({
  ...(await orig<typeof import('../ai/AIService')>()),
  proposeTransformationEdit: vi.fn(async () => proposals.shift() ?? { sql: 'SELECT 1', summary: '' }),
  respondBuildChat: vi.fn(async (coverage: string) => {
    seenContexts.push(coverage);
    return { reply: 'ok', proposal: null };
  }),
}));

const warehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-declaration-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminToken: string;
let analystToken: string;
let viewerToken: string;
let otherAdminToken: string;
let tenantId: number;
let connectionId: number;
let productId: number;
let dimId: number;
let stubId: number;
let noCellTableId: number;
let cellId: number;

const ORIGINAL_SQL = 'SELECT ID AS account_key, Name AS account_name FROM Accounts';

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
  const admin = await registerUser({ email: 'admin@declaration.test', companyName: 'Declaration BV' });
  adminToken = admin.token; tenantId = admin.user.tenantId;
  analystToken = (await createUserWithToken({ tenantId, role: 'analyst', email: 'analyst@declaration.test' })).token;
  viewerToken = (await createUserWithToken({ tenantId, role: 'viewer', email: 'viewer@declaration.test' })).token;
  otherAdminToken = (await registerUser({ email: 'other@declaration.test', companyName: 'Other BV' })).token;

  await writeSourceTable('Accounts', `
    SELECT * FROM (VALUES
      ('a1', 'Van Damme BVBA', 'BE'),
      ('a2', 'Peeters NV',     'BE')
    ) AS t(ID, Name, Country)`);

  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Exact (declaration)', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts'], warehouse_path: warehouse, query_engine: 'duckdb',
    last_sync_status: 'succeeded', config: JSON.stringify({}),
  }).returning('id');
  connectionId = idOf(conn);

  const [product] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: 'Finance', description: 'declaration test',
    status: 'approved', kind: 'analytics',
  }).returning('id');
  productId = idOf(product);
  const [schema] = await db('star_schemas').insert({
    tenant_id: tenantId, data_product_id: productId, name: 'Finance star', grain: 'one row per account',
  }).returning('id');
  const schemaId = idOf(schema);

  // A SERVING dimension: success, with a deploy cell that still holds the
  // old SQL — the shape a table has after a build and a notebook Deploy.
  const [dim] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_account', display_name: 'Accounts',
    table_role: 'dimension', dag_order: 0, transformation_sql: ORIGINAL_SQL,
    transformation_status: 'success', delta_path: path.join(warehouse, 'product', 'dim_account'),
    last_run_at: new Date(Date.now() - 3600_000).toISOString(),
  }).returning('id');
  dimId = idOf(dim);
  const [cell] = await db('product_table_cells').insert({
    tenant_id: tenantId, product_table_id: dimId, cell_type: 'sql', source: ORIGINAL_SQL, position: 0, is_deploy_cell: true,
  }).returning('id');
  cellId = idOf(cell);
  await db('product_columns').insert([
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_key', data_type: 'VARCHAR', column_role: 'natural_key', sort_order: 0 },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'account_name', data_type: 'VARCHAR', column_role: 'attribute', description: 'The name on the invoice', sort_order: 1 },
  ]);

  // A stub of that dimension in a second subject — a shared dimension is
  // built at its owner and only mirrored here.
  const [product2] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: 'Sales', status: 'approved', kind: 'analytics',
  }).returning('id');
  const [schema2] = await db('star_schemas').insert({
    tenant_id: tenantId, data_product_id: idOf(product2), name: 'Sales star',
  }).returning('id');
  const [stub] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema2), table_name: 'dim_account', table_role: 'dimension', dag_order: 0,
    is_shared_dimension: true, source_product_table_id: dimId, transformation_status: 'draft',
  }).returning('id');
  stubId = idOf(stub);

  // A table with NO cells yet — the sync must create the deploy cell.
  const [noCell] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_country', table_role: 'dimension', dag_order: 0,
    transformation_sql: 'SELECT DISTINCT Country AS country FROM Accounts', transformation_status: 'draft',
  }).returning('id');
  noCellTableId = idOf(noCell);

  await db('product_kpis').insert({
    tenant_id: tenantId, data_product_id: productId, name: 'Active accounts',
    description: 'Accounts with an invoice in the last 12 months', question_text: 'How many active accounts do we have?',
    formula_sql: 'SELECT COUNT(*) FROM dim_account', ai_draft: false,
  });
});

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(warehouse, { recursive: true, force: true });
});

const put = async (token: string, tableId: number, sql: string) =>
  (await request()).put(`/api/products/tables/${tableId}/sql`).set(auth(token)).send({ sql });

describe('PUT /products/tables/:id/sql — the declaration is guarded, compiled and stored once', () => {
  it('refuses SQL that reads outside the warehouse, and stores nothing', async () => {
    const res = await put(adminToken, dimId, "SELECT * FROM read_parquet('az://warehouse/tenant_99/dim_account/*.parquet')");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/refused/i);
    const row = await getTestDb()('product_tables').where({ id: dimId }).first();
    expect(row.transformation_sql).toBe(ORIGINAL_SQL);
    expect(row.declared_at).toBeNull();
    expect(row.transformation_status).toBe('success');
  });

  it('refuses SQL that does not compile — the column is named — and stores nothing', async () => {
    const res = await put(adminToken, dimId, 'SELECT ID AS account_key, NoSuchColumn AS x FROM Accounts');
    expect(res.status).toBe(400);
    expect(res.body.compiled).toBe(false);
    expect(String(res.body.error)).toMatch(/NoSuchColumn/);
    expect(String(res.body.error)).not.toContain(warehouse);
    const row = await getTestDb()('product_tables').where({ id: dimId }).first();
    expect(row.transformation_sql).toBe(ORIGINAL_SQL);
    expect(row.declared_at).toBeNull();
  });

  it('refuses a stub of a shared dimension and names the owner', async () => {
    const res = await put(adminToken, stubId, 'SELECT ID AS account_key FROM Accounts');
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('Finance');
  });

  it('a viewer may not declare', async () => {
    const res = await put(viewerToken, dimId, ORIGINAL_SQL);
    expect(res.status).toBe(403);
  });

  it('an analyst may: the SQL is stored once, the deploy cell is synced, the table keeps serving', async () => {
    const newSql = 'SELECT ID AS account_key, Name AS account_name, Country AS country FROM Accounts';
    const res = await put(analystToken, dimId, `${newSql};`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The derived columns come from the compile, not from the model or a regex.
    expect(res.body.data.columns.map((c: { name: string }) => c.name)).toEqual(['account_key', 'account_name', 'country']);
    expect(res.body.data.keeps_serving).toBe(true);

    const db = getTestDb();
    const row = await db('product_tables').where({ id: dimId }).first();
    expect(row.transformation_sql).toBe(newSql);              // trailing semicolon stripped
    expect(row.transformation_status).toBe('success');       // still serving Ask AI
    expect(row.declared_by).toBeTruthy();
    expect(row.declared_at).not.toBeNull();
    // The deploy cell holds the SAME SQL now, so a later Deploy cannot revert it.
    const cell = await db('product_table_cells').where({ id: cellId }).first();
    expect(cell.source).toBe(newSql);
    expect(cell.is_deploy_cell).toBe(true);
  });

  it('the declaration read model says "changed since the last build" and carries the derived columns', async () => {
    const res = await (await request()).get(`/api/products/tables/${dimId}/declaration`).set(auth(analystToken));
    expect(res.status).toBe(200);
    expect(res.body.data.pending_rebuild).toBe(true);
    expect(res.body.data.declared_by).toBeTruthy();
    expect(res.body.data.product.name).toBe('Finance');
    expect(res.body.data.shared_from).toBeNull();
    expect(res.body.data.columns.map((c: { column_name: string }) => c.column_name)).toEqual(['account_key', 'account_name']);
  });

  it('a stub\'s declaration points at its owner', async () => {
    const res = await (await request()).get(`/api/products/tables/${stubId}/declaration`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.shared_from).toEqual({ tableId: dimId, productId, productName: 'Finance' });
  });

  it('a table with no cells gets a deploy cell created on save', async () => {
    const res = await put(adminToken, noCellTableId, 'SELECT DISTINCT Country AS country FROM Accounts ORDER BY 1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cells = await getTestDb()('product_table_cells').where({ product_table_id: noCellTableId });
    expect(cells).toHaveLength(1);
    expect(cells[0].is_deploy_cell).toBe(true);
    expect(cells[0].source).toContain('ORDER BY 1');
    expect(Number(cells[0].tenant_id)).toBe(tenantId);
  });

  it('another tenant cannot see or write the table', async () => {
    const seen = await (await request()).get(`/api/products/tables/${dimId}/declaration`).set(auth(otherAdminToken));
    expect(seen.status).toBe(404);
    const written = await put(otherAdminToken, dimId, 'SELECT 1 AS x');
    expect(written.status).toBe(404);
  });
});

describe('POST /products/tables/:id/sql/preview — the first rows, nothing stored', () => {
  it('returns the rows the declaration produces', async () => {
    const res = await (await request()).post(`/api/products/tables/${dimId}/sql/preview`).set(auth(analystToken))
      .send({ sql: 'SELECT ID AS account_key, Name AS account_name FROM Accounts ORDER BY 1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.columns).toEqual(['account_key', 'account_name']);
    expect(res.body.data.rows).toHaveLength(2);
    expect(res.body.data.rows[0].account_name).toBe('Van Damme BVBA');
  });

  it('reports a compile error in words, without a path', async () => {
    const res = await (await request()).post(`/api/products/tables/${dimId}/sql/preview`).set(auth(analystToken))
      .send({ sql: 'SELECT Nope FROM Accounts' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Nope/);
    expect(String(res.body.error)).not.toContain(warehouse);
  });

  it('is guarded like the save', async () => {
    const res = await (await request()).post(`/api/products/tables/${dimId}/sql/preview`).set(auth(analystToken))
      .send({ sql: "SELECT * FROM read_text('/proc/self/environ')" });
    expect(res.status).toBe(400);
  });
});

describe('POST /products/tables/:id/sql/propose — the assistant proposes, never writes', () => {
  const propose = async (token: string, instruction: string) =>
    (await request()).post(`/api/products/tables/${dimId}/sql/propose`).set(auth(token)).send({ instruction });

  it('a compiling proposal comes back with its columns, and the stored SQL is untouched', async () => {
    proposals.push({ sql: 'SELECT ID AS account_key, Name AS account_name, Country AS country, 1 AS one FROM Accounts', summary: 'Added a constant.' });
    const before = (await getTestDb()('product_tables').where({ id: dimId }).first()).transformation_sql;
    const res = await propose(analystToken, 'add a column that is always 1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.proposed).toBe(true);
    expect(res.body.data.compiled).toBe(true);
    expect(res.body.data.columns.map((c: { name: string }) => c.name)).toContain('one');
    expect(res.body.data.summary).toBe('Added a constant.');
    const after = (await getTestDb()('product_tables').where({ id: dimId }).first()).transformation_sql;
    expect(after).toBe(before);
  });

  it('a proposal that reads outside the warehouse is refused, not shown', async () => {
    proposals.push({ sql: "SELECT * FROM read_parquet('az://warehouse/tenant_99/x/*.parquet')", summary: 'Pulled in more data.' });
    const res = await propose(analystToken, 'get everything');
    expect(res.status).toBe(200);
    expect(res.body.data.proposed).toBe(false);
    expect(res.body.data.sql).toBeUndefined();
    expect(String(res.body.data.summary)).toMatch(/refused/i);
  });

  it('a proposal that does not compile is shown with its error, so the person can judge it', async () => {
    proposals.push({ sql: 'SELECT ID AS account_key, Missing AS m FROM Accounts', summary: 'Added Missing.' });
    const res = await propose(analystToken, 'add the missing column');
    expect(res.status).toBe(200);
    expect(res.body.data.proposed).toBe(true);
    expect(res.body.data.compiled).toBe(false);
    expect(String(res.body.data.error)).toMatch(/Missing/);
  });

  it('when the model returns the SQL unchanged there is no proposal', async () => {
    const current = (await getTestDb()('product_tables').where({ id: dimId }).first()).transformation_sql;
    proposals.push({ sql: current, summary: 'Nothing to change.' });
    const res = await propose(analystToken, 'keep it');
    expect(res.status).toBe(200);
    expect(res.body.data.proposed).toBe(false);
    expect(res.body.data.summary).toBe('Nothing to change.');
  });

  it('a viewer may not ask for a proposal', async () => {
    const res = await propose(viewerToken, 'anything');
    expect(res.status).toBe(403);
  });
});

describe('the catalog assistant\'s table anchor', () => {
  const ask = async (token: string, body: Record<string, unknown>) =>
    (await request()).post('/api/products/build-chat').set(auth(token))
      .send({ messages: [{ role: 'user', content: 'what is in this table?' }], ...body });

  it('the caller\'s own table reaches the prompt with its columns and its subject', async () => {
    seenContexts.length = 0;
    const res = await ask(analystToken, { anchorTableId: dimId });
    expect(res.status).toBe(200);
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]).toContain('THE TABLE THE USER IS LOOKING AT');
    expect(seenContexts[0]).toContain('dim_account');
    expect(seenContexts[0]).toContain('The name on the invoice');
    // The table's subject becomes the product anchor too.
    expect(seenContexts[0]).toContain('WHERE THE USER IS');
    expect(seenContexts[0]).toContain('Finance');
  });

  it('another tenant\'s table id is dropped, not trusted into the prompt', async () => {
    seenContexts.length = 0;
    const res = await ask(otherAdminToken, { anchorTableId: dimId });
    expect(res.status).toBe(200);
    expect(seenContexts[0]).not.toContain('THE TABLE THE USER IS LOOKING AT');
    expect(seenContexts[0]).not.toContain('dim_account');
  });
});

describe('GET /definitions — the three stores on one screen, this tenant only', () => {
  it('unions terms (links resolved), metrics (with their subject) and verified answers', async () => {
    const agent = await request();
    const term = await agent.post('/api/semantic/glossary').set(auth(adminToken)).send({
      term: 'Account', meaning: 'A customer or supplier we invoice',
      links: [{ kind: 'column', table: 'dim_account', column: 'account_name' }],
    });
    expect(term.status, JSON.stringify(term.body)).toBe(201);
    const verified = await agent.post('/api/saved-questions').set(auth(adminToken)).send({
      question: 'How many accounts do we have?', sql: 'SELECT COUNT(*) AS n FROM dim_account',
      connectionId, dataLayer: 'product', verified: true,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    const unverified = await agent.post('/api/saved-questions').set(auth(adminToken)).send({
      question: 'Which accounts are Belgian?', sql: "SELECT * FROM dim_account WHERE country = 'BE'",
      connectionId, dataLayer: 'product', verified: false,
    });
    expect(unverified.status, JSON.stringify(unverified.body)).toBe(201);

    const res = await agent.get('/api/definitions').set(auth(viewerToken));
    expect(res.status).toBe(200);
    const { terms, metrics, verifiedAnswers } = res.body.data;
    expect(terms).toHaveLength(1);
    expect(terms[0].term).toBe('Account');
    expect(terms[0].links[0]).toMatchObject({ kind: 'column', table: 'dim_account', column: 'account_name', resolved: true, topic: 'Finance' });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ name: 'Active accounts', question_text: 'How many active accounts do we have?', product: { name: 'Finance' } });
    expect(verifiedAnswers).toHaveLength(1);
    expect(verifiedAnswers[0].question).toBe('How many accounts do we have?');
  });

  it('another tenant sees none of it', async () => {
    const res = await (await request()).get('/api/definitions').set(auth(otherAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.terms).toHaveLength(0);
    expect(res.body.data.metrics).toHaveLength(0);
    expect(res.body.data.verifiedAnswers).toHaveLength(0);
  });
});
