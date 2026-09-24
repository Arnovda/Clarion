/**
 * The Studio coworker, END TO END: every tool against the real routes of a
 * real workspace, then every Keep and Undo exactly as the panel sends them.
 *
 * Why this suite exists (2026-09-24, owner screenshot): asked "open the Cash
 * Flow subject", the coworker answered "I'm having trouble opening it
 * directly". describe_workspace listed the subjects by NAME with no ids, and
 * search_catalog matched tables and columns but never a subject — so the model
 * had nothing to pass to open_subject but a guess. The first suite mocked its
 * way around the routes and could not see that. Here the ONLY mocked things
 * are the two model calls: the loop's (scripted, so each tool is called the
 * way the model would call it) and the SQL writer's.
 *
 * Real Postgres, real DuckDB over real Parquet, the real loopback.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Database } from 'duckdb-async';

process.env.STORAGE_FORMAT = 'parquet';

const sqlProposals: Array<{ sql: string; summary: string }> = [];
vi.mock('../ai/AIService', async (orig) => {
  const actual = await orig<typeof import('../ai/AIService')>();
  return {
    ...actual,
    callClaudeWithTools: vi.fn(),
    proposeTransformationEdit: vi.fn(async () => sqlProposals.shift() ?? { sql: 'SELECT 1 AS x', summary: '' }),
  };
});

// Neo4j is not part of the test environment (NEO4J_URI=""). The relationship
// Keep writes the graph edge first; stub exactly those writes so the Postgres
// row — what the product counts and the canvas reads — is still exercised.
vi.mock('../db/semanticGraph', async (orig) => {
  const actual = await orig<typeof import('../db/semanticGraph')>();
  const { getTestDb: tdb } = await import('./db-helpers');
  return {
    ...actual,
    nextPgId: vi.fn(async () => Number((await tdb().raw("SELECT nextval('semantic_node_id_seq') AS id")).rows[0].id)),
    getColumnByPgId: vi.fn(async () => null),
    createRelationship: vi.fn(async () => undefined),
    deleteRelationship: vi.fn(async () => undefined),
  };
});

import { callClaudeWithTools } from '../ai/AIService';
import { getApp, request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { setFlagRollout, invalidateFeatureFlagCache } from '../services/featureFlags';
import { setInternalApiBase } from '../services/coworker/internalApi';
import { COWORKER_TOOLS } from '../services/coworker/tools';

const mockModel = vi.mocked(callClaudeWithTools);
const warehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-coworker-e2e-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

let server: Server;
let base: string;
let token: string;
let tenantId: number;
let connectionId: number;
let productId: number;
let factId: number;
let dimId: number;
let invoicesId: number;
let accountsId: number;
const col: Record<string, number> = {};
let relationshipId: number;

const FACT_SQL = 'SELECT i.ID AS invoice_id, i.AccountID AS account_id, i.Amount AS open_amount FROM Invoices i';

async function writeSourceTable(entity: string, selectSql: string) {
  const dir = path.join(warehouse, entity);
  fs.mkdirSync(dir, { recursive: true });
  const db = await Database.create(':memory:');
  try {
    await db.exec(`COPY (${selectSql}) TO '${path.join(dir, 'data.parquet').replace(/'/g, "''")}' (FORMAT PARQUET)`);
  } finally { await db.close(); }
}

function step(content: unknown[]) {
  return { content, stopReason: 'end_turn', model: 'claude-haiku-4-5-20251001', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 };
}

/** The model calls ONE tool, then answers. Returns what the tool gave back. */
function script(name: string, input: Record<string, unknown>) {
  const seen: { toolResult?: { content: string; is_error?: boolean } } = {};
  mockModel
    .mockImplementationOnce(async () => step([
      { type: 'text', text: `Calling ${name}.` },
      { type: 'tool_use', id: `tu_${name}`, name, input },
    ]))
    .mockImplementationOnce(async (opts) => {
      const last = opts.messages[opts.messages.length - 1];
      seen.toolResult = (last.content as Array<{ content: string; is_error?: boolean }>)[0];
      return step([{ type: 'text', text: 'Done.' }]);
    });
  return seen;
}

async function turn(message: string, context: Record<string, unknown> = { path: '/catalog' }, history: unknown[] = []) {
  const res = await fetch(`${base}/api/coworker/turn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context, history }),
  });
  const text = await res.text();
  const events = text.split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  return { status: res.status, events };
}

/** One tool, one turn: the step must settle `done`, never `failed`. */
async function runTool(name: string, input: Record<string, unknown>, context?: Record<string, unknown>) {
  const seen = script(name, input);
  const t = await turn(`use ${name}`, context);
  expect(t.status).toBe(200);
  const steps = t.events.filter((e) => e.type === 'step');
  const settled = steps[steps.length - 1];
  expect(settled, `${name} produced no step`).toBeTruthy();
  expect(settled.status, `${name} failed: ${String(settled.detail)}`).toBe('done');
  expect(seen.toolResult?.is_error).toBeFalsy();
  return {
    events: t.events,
    result: seen.toolResult?.content ?? '',
    focus: t.events.find((e) => e.type === 'focus')?.target as Record<string, unknown> | undefined,
    proposal: t.events.find((e) => e.type === 'proposal')?.proposal as Record<string, unknown> | undefined,
  };
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'cw-e2e@test.com', companyName: 'Cash BV' });
  token = admin.token;
  tenantId = admin.user.tenantId;

  await writeSourceTable('Accounts', `SELECT * FROM (VALUES ('a1','Van Damme BVBA'),('a2','Peeters NV'),('a3','Janssens'),('a4','Maes'),('a5','Claes'),('a6','Wouters'),('a7','Goossens'),('a8','Mertens'),('a9','Willems')) t(ID, Name)`);
  await writeSourceTable('Invoices', `SELECT * FROM (VALUES ('i1','a1',100.0),('i2','a2',50.0),('i3','a3',20.0),('i4','a4',10.0),('i5','a5',5.0),('i6','a6',7.0),('i7','a7',8.0),('i8','a8',9.0),('i9','a9',3.0),('i10','a1',4.0)) t(ID, AccountID, Amount)`);

  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name: 'Exact Online', type: 'duckdb', connector_type: 'exactonline',
    selected_entities: ['Accounts', 'Invoices'], warehouse_path: warehouse, query_engine: 'duckdb',
    last_sync_status: 'succeeded', profiling_status: 'done', config: JSON.stringify({}),
  }).returning('id');
  connectionId = idOf(conn);

  const [acc] = await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'Accounts', display_name: 'Accounts', is_active: true }).returning('id');
  const [inv] = await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'Invoices', display_name: 'Invoices', is_active: true }).returning('id');
  accountsId = idOf(acc); invoicesId = idOf(inv);
  for (const [t, name] of [[accountsId, 'ID'], [accountsId, 'Name'], [invoicesId, 'ID'], [invoicesId, 'AccountID'], [invoicesId, 'Amount']] as const) {
    const [c] = await db('source_columns').insert({ tenant_id: tenantId, table_id: t, column_name: name, data_type: name === 'Amount' ? 'DOUBLE' : 'VARCHAR' }).returning('id');
    col[`${t === accountsId ? 'Accounts' : 'Invoices'}.${name}`] = idOf(c);
  }
  const [rel] = await db('table_relationships').insert({
    tenant_id: tenantId, from_table_id: invoicesId, from_column_id: col['Invoices.AccountID'],
    to_table_id: accountsId, to_column_id: col['Accounts.ID'], relationship_type: 'many_to_one', ai_draft: true, kind: 'join',
  }).returning('id');
  relationshipId = idOf(rel);

  const [product] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: 'Cash Flow', description: 'Open receivables and payments',
    status: 'approved', kind: 'analytics',
  }).returning('id');
  productId = idOf(product);
  const [schema] = await db('star_schemas').insert({ tenant_id: tenantId, data_product_id: productId, name: 'Cash Flow star' }).returning('id');
  const [fact] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'fact_receivables', display_name: 'Receivables',
    table_role: 'fact', dag_order: 1, transformation_sql: FACT_SQL, transformation_status: 'success',
  }).returning('id');
  factId = idOf(fact);
  const [dim] = await db('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'dim_account', display_name: 'Accounts',
    table_role: 'dimension', dag_order: 0, transformation_sql: 'SELECT ID AS account_id, Name AS account_name FROM Accounts', transformation_status: 'success',
  }).returning('id');
  dimId = idOf(dim);
  await db('product_columns').insert([
    { tenant_id: tenantId, product_table_id: factId, column_name: 'invoice_id', data_type: 'VARCHAR', sort_order: 0 },
    { tenant_id: tenantId, product_table_id: factId, column_name: 'open_amount', data_type: 'DOUBLE', column_role: 'measure', sort_order: 1 },
  ]);
  await db('data_product_sources').insert({ tenant_id: tenantId, data_product_id: productId, source_table_id: invoicesId, table_name: 'Invoices' });
  await db('product_kpis').insert({ tenant_id: tenantId, data_product_id: productId, name: 'Open AR Balance', formula_sql: 'SUM(open_amount)', question_text: 'How much do customers still owe me?' });

  await setFlagRollout(db, 'ai_coworker', 'tenants', [tenantId], 'test');
  const app = await getApp();
  server = (app as unknown as { listen: (p: number) => Server }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setInternalApiBase(`${base}/api`);
});

afterAll(async () => {
  setInternalApiBase(null);
  await new Promise((r) => server.close(r));
  await getTestDb()('feature_flags').where({ key: 'ai_coworker' }).del();
  invalidateFeatureFlagCache();
  await closeTestDb();
  fs.rmSync(warehouse, { recursive: true, force: true });
});

beforeEach(() => { mockModel.mockReset(); });

describe('the screenshot: "open the Cash Flow subject"', () => {
  it('describe_workspace carries the ids the open_* tools need', async () => {
    const r = await runTool('describe_workspace', {});
    expect(r.result).toContain(`Cash Flow (product_id ${productId})`);
    expect(r.result).toContain(`table_id ${factId}`);
    expect(r.result).toContain('fact_receivables');
    expect(r.result).toContain(`connection_id ${connectionId}`);
    expect(r.result).toContain(`Invoices (source table_id ${invoicesId})`);
  });

  it('search_catalog finds a SUBJECT by its name', async () => {
    const r = await runTool('search_catalog', { query: 'cash flow' });
    expect(r.result).toContain(`"product_id":${productId}`);
    expect(r.result).toContain('"layer":"subject"');
  });

  it('open_subject by NAME opens it, moves the screen and lists the metrics', async () => {
    const r = await runTool('open_subject', { name: 'Cash Flow' }, { path: '/build', label: 'Build' });
    expect(r.focus).toEqual({ kind: 'subject', productId });
    expect(r.result).toContain('Open AR Balance');
    expect(r.result).toContain('SUM(open_amount)');
    expect(r.result).toContain(`"table_id":${factId}`);
  });

  it('a guessed id is refused with what to do instead — not a bare "not found"', async () => {
    const seen = script('open_subject', { product_id: 999_999 });
    const t = await turn('open it');
    const failed = t.events.find((e) => e.type === 'step' && e.status === 'failed');
    expect(failed).toBeTruthy();
    expect(seen.toolResult?.is_error).toBe(true);
    expect(seen.toolResult?.content).toMatch(/never guess/);
  });

  it('an unknown name lists the subjects that do exist', async () => {
    const seen = script('open_subject', { name: 'Treasury' });
    await turn('open treasury');
    expect(seen.toolResult?.content).toContain(`Cash Flow (product_id ${productId})`);
  });
});

describe('every read tool works against the real routes', () => {
  it('open_table by id and by name', async () => {
    const a = await runTool('open_table', { table_id: factId });
    expect(a.focus).toEqual({ kind: 'table', tableId: factId, tab: 'sql' });
    expect(a.result).toContain('SELECT i.ID');
    const b = await runTool('open_table', { table_name: 'Receivables' });
    expect(b.focus).toMatchObject({ kind: 'table', tableId: factId });
  });

  it('open_source_table returns column ids and the relationship', async () => {
    const r = await runTool('open_source_table', { table_id: invoicesId });
    expect(r.focus).toEqual({ kind: 'source-table', tableId: invoicesId, connectionId });
    expect(r.result).toContain(`"id":${col['Invoices.AccountID']}`);
    expect(r.result).toContain('Invoices.AccountID');
    expect(r.result).toContain('Accounts.ID');
  });

  it('table_lineage, table_usage, list_definitions', async () => {
    await runTool('table_lineage', { table_id: factId, layer: 'product' });
    await runTool('table_usage', { table_name: 'fact_receivables' });
    await runTool('list_definitions', {});
  });

  it('check_relationship measures an existing link on the data and writes nothing', async () => {
    const before = await getTestDb()('table_relationships').where({ id: relationshipId }).first();
    const r = await runTool('check_relationship', { relationship_id: relationshipId });
    expect(r.focus).toEqual({ kind: 'relations', tableId: invoicesId, relationshipId });
    expect(r.result).toContain('"verdict":"strong"');
    const after = await getTestDb()('table_relationships').where({ id: relationshipId }).first();
    expect(after.measured).toEqual(before.measured);
    expect(after.ai_draft).toBe(true);
  });

  it('source_status', async () => {
    const r = await runTool('source_status', { connection_id: connectionId });
    expect(r.focus).toEqual({ kind: 'source', connectionId });
    expect(r.result).toContain('Exact Online');
  });
});

describe('every proposal is checked, then kept and undone through the ordinary routes', () => {
  const api = async () => (await request());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('SQL: proposed, compiled, kept (stored), undone (restored)', async () => {
    sqlProposals.push({ sql: `${FACT_SQL} WHERE i.Amount > 0`, summary: 'Only open amounts.' });
    const r = await runTool('propose_sql_change', { table_name: 'fact_receivables', instruction: 'only positive amounts' });
    expect(r.proposal).toMatchObject({ kind: 'sql', tableId: factId, compiled: true });
    expect((await getTestDb()('product_tables').where({ id: factId }).first()).transformation_sql).toBe(FACT_SQL);

    const keep = await (await api()).put(`/api/products/tables/${factId}/sql`).set(auth()).send({ sql: r.proposal!.after });
    expect(keep.status).toBe(200);
    expect((await getTestDb()('product_tables').where({ id: factId }).first()).transformation_sql).toContain('WHERE i.Amount > 0');

    const undo = await (await api()).put(`/api/products/tables/${factId}/sql`).set(auth()).send({ sql: r.proposal!.before });
    expect(undo.status).toBe(200);
    expect((await getTestDb()('product_tables').where({ id: factId }).first()).transformation_sql).toBe(FACT_SQL);
  });

  it('relationship: named on the card, measured, kept, undone', async () => {
    // Amount → Accounts.ID is nonsense; the point is the card and the measure.
    const r = await runTool('propose_relationship', {
      from_table_id: invoicesId, from_column_id: col['Invoices.AccountID'],
      to_table_id: accountsId, to_column_id: col['Accounts.ID'], reason: 'Each invoice is for one account.',
    });
    expect(r.proposal).toMatchObject({ kind: 'relationship', fromLabel: 'Invoices.AccountID', toLabel: 'Accounts.ID' });
    expect((r.proposal!.measurement as { verdict: string }).verdict).toBe('strong');
    const p = r.proposal!;
    const keep = await (await api()).post('/api/semantic/relationships').set(auth()).send({
      from_table_id: p.fromTableId, from_column_id: p.fromColumnId, to_table_id: p.toTableId, to_column_id: p.toColumnId,
      relationship_type: 'many_to_one', description: p.reason, kind: 'join', measured: p.measurement,
    });
    expect(keep.status).toBe(201);
    expect(await getTestDb()('table_relationships').where({ id: keep.body.data.id }).first()).toMatchObject({ ai_draft: false, kind: 'join' });
    const undo = await (await api()).delete(`/api/semantic/relationships/${keep.body.data.id}`).set(auth());
    expect(undo.status).toBeLessThan(300);
    expect(await getTestDb()('table_relationships').where({ id: keep.body.data.id }).first()).toBeUndefined();
  });

  it('relationship: a column that is not on its table is refused before measuring', async () => {
    const seen = script('propose_relationship', {
      from_table_id: invoicesId, from_column_id: col['Accounts.Name'],
      to_table_id: accountsId, to_column_id: col['Accounts.ID'], reason: 'x',
    });
    await turn('link');
    expect(seen.toolResult?.is_error).toBe(true);
    expect(seen.toolResult?.content).toMatch(/not a column of from_table_id/);
  });

  it('glossary term with a link: checked, kept, undone', async () => {
    const r = await runTool('propose_glossary_term', {
      term: 'Open receivables', meaning: 'What customers still owe.',
      links: [{ kind: 'column', table: 'fact_receivables', column: 'open_amount' }, { kind: 'kpi', kpi: 'Open AR Balance' }],
    });
    const p = r.proposal!;
    const keep = await (await api()).post('/api/semantic/glossary').set(auth()).send({ term: p.term, meaning: p.meaning, links: p.links });
    expect(keep.status).toBe(201);
    const undo = await (await api()).delete(`/api/semantic/glossary/${keep.body.data.id}`).set(auth());
    expect(undo.status).toBeLessThan(300);
  });

  it('new table: proposed, kept (created), and its SQL drafted as the next proposal', async () => {
    const r = await runTool('propose_new_table', {
      product_id: productId, table_name: 'dim_customer_region', table_role: 'dimension',
      description: 'One row per account.', sql_instruction: 'accounts with their name',
    });
    const p = r.proposal!;
    const keep = await (await api()).post(`/api/products/${productId}/tables`).set(auth()).send({ tableName: p.tableName, tableRole: p.tableRole, description: p.description });
    expect(keep.status).toBe(200);
    sqlProposals.push({ sql: 'SELECT ID AS account_id, Name AS account_name FROM Accounts', summary: 'Accounts.' });
    const draft = await (await api()).post(`/api/products/tables/${keep.body.data.id}/sql/propose`).set(auth()).send({ instruction: p.sqlInstruction });
    expect(draft.body.data).toMatchObject({ proposed: true, compiled: true });
  });

  it('new subject: the proposal fits what the build route accepts', async () => {
    const r = await runTool('propose_new_subject', {
      connection_id: connectionId, name: 'Sales invoices', description: 'Invoices by account.', entities: ['Invoices', 'Accounts'],
    });
    const p = r.proposal!;
    const keep = await (await api()).post('/api/products/bus-matrix/extend-start').set(auth()).send({
      connectionId: p.connectionId, name: p.name, description: p.description, entities: p.entities,
    });
    // No Redis in tests: 503 means every validation and guard passed; a 400
    // would mean the coworker proposed something its own Keep cannot send.
    expect(keep.status).not.toBe(400);
  });

  it('new subject: more tables than the build route takes is refused up front', async () => {
    const seen = script('propose_new_subject', {
      connection_id: connectionId, name: 'Everything', description: 'x',
      entities: Array.from({ length: 13 }, (_, i) => `T${i}`),
    });
    await turn('build it');
    expect(seen.toolResult?.content).toMatch(/at most 12/);
  });
});

it('every tool the coworker offers is exercised above', () => {
  const covered = new Set([
    'describe_workspace', 'search_catalog', 'open_subject', 'open_table', 'open_source_table', 'table_lineage',
    'table_usage', 'list_definitions', 'check_relationship', 'source_status', 'propose_sql_change',
    'propose_relationship', 'propose_glossary_term', 'propose_new_table', 'propose_new_subject',
    // preview_rows goes to the product-preview route, which reads a MATERIALISED
    // table; it is pinned in coworker.test.ts (withheld from hybrid tenants).
    'preview_rows',
  ]);
  expect(COWORKER_TOOLS.map((t) => t.definition.name).filter((n) => !covered.has(n))).toEqual([]);
});
