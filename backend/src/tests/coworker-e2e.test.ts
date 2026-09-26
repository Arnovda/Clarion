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
    // The definition edits write the graph first, then mirror to Postgres —
    // the Postgres side is what these tests read.
    updateTable: vi.fn(async () => undefined),
    updateColumn: vi.fn(async () => undefined),
    updateProductTable: vi.fn(async () => undefined),
    updateProductColumn: vi.fn(async () => undefined),
    updateRelationship: vi.fn(async () => undefined),
    setRelationshipFlagged: vi.fn(async () => undefined),
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

describe('the new abilities: every proposal checked, nothing written until Keep, Keep and Undo through the routes', () => {
  const api = async () => (await request());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const db = () => getTestDb();

  it('descriptions: one card for several tables and columns, before → after, Undo restores', async () => {
    // The fact's GRAPH id deliberately equals the dim's POSTGRES id: the two
    // id sequences overlap in real life, and the mirror used to update BOTH
    // rows (`id = x OR neo4j_pg_id = x`). Only the fact may change.
    await db()('product_tables').where({ id: factId }).update({ neo4j_pg_id: dimId });
    const [openCol] = await db()('product_columns').where({ product_table_id: factId, column_name: 'open_amount' }).update({ neo4j_pg_id: 7_700_001 }).returning('id');
    const dimBefore = await db()('product_tables').where({ id: dimId }).first();

    const r = await runTool('propose_descriptions', { items: [
      { target: 'source-column', id: col['Invoices.Amount'], field: 'description', text: 'The invoice amount, VAT excluded.' },
      { target: 'subject-table', id: factId, field: 'description', text: 'One row per open invoice.' },
      { target: 'subject-column', id: idOf(openCol), field: 'display_name', text: 'Open amount' },
    ] });
    const p = r.proposal as { kind: string; items: Array<{ target: string; id: number; field: string; before: string | null; after: string; label: string }> };
    expect(p.kind).toBe('descriptions');
    expect(p.items).toHaveLength(3);
    expect(p.items[0]).toMatchObject({ label: 'Invoices › Amount', before: null, after: 'The invoice amount, VAT excluded.' });
    expect(p.items[1].id).toBe(dimId); // the graph id is what the route takes
    expect((await db()('source_columns').where({ id: col['Invoices.Amount'] }).first()).description ?? null).toBeNull();

    const path = (it: { target: string; id: number }) => ({
      'source-column': `/api/semantic/columns/${it.id}`, 'subject-table': `/api/semantic/product-tables/${it.id}`,
      'subject-column': `/api/semantic/product-columns/${it.id}`, 'source-table': `/api/semantic/tables/${it.id}`,
    } as Record<string, string>)[it.target];
    for (const it of p.items) {
      const k = await (await api()).patch(path(it)).set(auth()).send({ [it.field]: it.after });
      expect(k.status, JSON.stringify(k.body)).toBe(200);
    }
    expect((await db()('source_columns').where({ id: col['Invoices.Amount'] }).first()).description).toBe('The invoice amount, VAT excluded.');
    expect((await db()('product_tables').where({ id: factId }).first()).description).toBe('One row per open invoice.');
    expect((await db()('product_columns').where({ id: idOf(openCol) }).first()).display_name).toBe('Open amount');
    expect((await db()('product_tables').where({ id: dimId }).first()).description ?? null).toBe(dimBefore.description ?? null);

    for (const it of [...p.items].reverse()) {
      const u = await (await api()).patch(path(it)).set(auth()).send({ [it.field]: it.before ?? '' });
      expect(u.status).toBe(200);
    }
    expect((await db()('product_tables').where({ id: factId }).first()).description || null).toBeNull();
    expect((await db()('source_columns').where({ id: col['Invoices.Amount'] }).first()).description || null).toBeNull();
  });

  it('descriptions: text that is already stored is not proposed', async () => {
    await db()('source_tables').where({ id: invoicesId }).update({ description: 'Sales invoices.' });
    const seen = script('propose_descriptions', { items: [{ target: 'source-table', id: invoicesId, field: 'description', text: 'Sales invoices.' }] });
    await turn('describe');
    expect(seen.toolResult?.is_error).toBe(true);
    expect(seen.toolResult?.content).toMatch(/already what is stored/);
  });

  it('metric: a new one is RUN on the data first, then kept and undone', async () => {
    const r = await runTool('propose_metric', {
      product_id: productId, name: 'Invoice count', formula_sql: 'SELECT COUNT(*) AS n FROM Invoices',
      question_text: 'How many invoices do we have?',
    });
    const p = r.proposal as Record<string, any>;
    expect(p).toMatchObject({ kind: 'metric', kpiId: null, name: 'Invoice count' });
    expect(p.check).toMatchObject({ ran: true, ok: true, value: '10' });
    expect(p.changes.map((c: { field: string }) => c.field)).toEqual(['Name', 'Formula', 'Question it answers']);
    expect(await db()('product_kpis').where({ data_product_id: productId, name: 'Invoice count' }).first()).toBeUndefined();

    const v = p.values;
    const keep = await (await api()).post(`/api/products/${productId}/kpis`).set(auth()).send({
      name: v.name, description: v.description, formulaSql: v.formula_sql, formulaPlainText: v.formula_plain_text, questionText: v.question_text,
    });
    expect(keep.status).toBe(200);
    expect(await db()('product_kpis').where({ id: keep.body.data.id }).first()).toMatchObject({ name: 'Invoice count', tenant_id: tenantId });
    const undo = await (await api()).delete(`/api/products/kpis/${keep.body.data.id}`).set(auth());
    expect(undo.status).toBe(200);
    expect(await db()('product_kpis').where({ id: keep.body.data.id }).first()).toBeUndefined();
  });

  it('metric: a change to an existing one shows only what changes; a broken formula says why', async () => {
    const kpi = await db()('product_kpis').where({ data_product_id: productId, name: 'Open AR Balance' }).first();
    const r = await runTool('propose_metric', { product_id: productId, kpi_id: kpi.id, question_text: 'Who still owes me money?' });
    const p = r.proposal as Record<string, any>;
    expect(p.changes).toEqual([{ field: 'Question it answers', before: 'How much do customers still owe me?', after: 'Who still owes me money?' }]);

    const bad = await runTool('propose_metric', { product_id: productId, name: 'Broken', formula_sql: 'SELECT SUM(no_such_column) FROM Invoices' });
    expect((bad.proposal as Record<string, any>).check).toMatchObject({ ran: true, ok: false });
    expect(String((bad.proposal as Record<string, any>).check.error)).toMatch(/no_such_column/);
  });

  it('glossary: a change to an existing term, before → after, kept and undone', async () => {
    const created = await (await api()).post('/api/semantic/glossary').set(auth()).send({ term: 'DSO', meaning: 'Days sales outstanding.' });
    expect(created.status).toBe(201);
    const r = await runTool('propose_glossary_change', { term: 'dso', meaning: 'How many days, on average, customers take to pay.' });
    const p = r.proposal as Record<string, any>;
    expect(p).toMatchObject({ kind: 'glossary-edit', termId: created.body.data.id });
    expect(p.changes).toEqual([{ field: 'Meaning', before: 'Days sales outstanding.', after: 'How many days, on average, customers take to pay.' }]);
    expect(r.focus).toEqual({ kind: 'definitions' });

    const keep = await (await api()).patch(`/api/semantic/glossary/${p.termId}`).set(auth()).send(p.after);
    expect(keep.status).toBe(200);
    expect((await db()('business_glossary').where({ id: p.termId }).first()).meaning).toMatch(/on average/);
    const undo = await (await api()).patch(`/api/semantic/glossary/${p.termId}`).set(auth()).send(p.before);
    expect(undo.status).toBe(200);
    expect((await db()('business_glossary').where({ id: p.termId }).first()).meaning).toBe('Days sales outstanding.');
  });

  it('relationship review: flag (measured first), kept, unflagged by Undo; then confirm', async () => {
    const r = await runTool('propose_relationship_review', { relationship_id: relationshipId, action: 'flag', reason: 'Testing the flag.' });
    const p = r.proposal as Record<string, any>;
    expect(p).toMatchObject({ kind: 'relationship-review', action: 'flag', label: 'Invoices.AccountID → Accounts.ID' });
    expect(p.measurement.verdict).toBe('strong');
    expect(p.changes[0]).toMatchObject({ field: 'Status', after: 'Flagged — Ask AI does not join on it' });
    expect((await db()('table_relationships').where({ id: relationshipId }).first()).flagged_at).toBeNull();

    expect((await (await api()).post(`/api/relationships/${relationshipId}/flag`).set(auth()).send({ flagged: true, reason: p.reason })).status).toBe(200);
    expect((await db()('table_relationships').where({ id: relationshipId }).first()).flagged_at).not.toBeNull();
    expect((await (await api()).post(`/api/relationships/${relationshipId}/flag`).set(auth()).send({ flagged: false, reason: null })).status).toBe(200);
    expect((await db()('table_relationships').where({ id: relationshipId }).first()).flagged_at).toBeNull();

    const c = await runTool('propose_relationship_review', { relationship_id: relationshipId, action: 'confirm', reason: 'Holds on every invoice.' });
    const cp = c.proposal as Record<string, any>;
    const keep = await (await api()).patch(`/api/semantic/relationships/${relationshipId}`).set(auth()).send({ measured: cp.measurement });
    expect(keep.status).toBe(200);
    expect(await db()('table_relationships').where({ id: relationshipId }).first()).toMatchObject({ confirmed_by_user: true, ai_draft: false });
    const again = script('propose_relationship_review', { relationship_id: relationshipId, action: 'confirm', reason: 'x' });
    await turn('confirm');
    expect(again.toolResult?.content).toMatch(/already confirmed/);
  });

  it('run_query answers a number question on the data', async () => {
    const r = await runTool('run_query', { connection_id: connectionId, sql: 'SELECT COUNT(*) AS invoices FROM Invoices;' });
    expect(r.result).toContain('"invoices":10');
    const seen = script('run_query', { connection_id: connectionId, sql: 'SELECT nope FROM Invoices' });
    await turn('count');
    expect(seen.toolResult?.is_error).toBe(true);
    expect(seen.toolResult?.content).toMatch(/nope/);
  });

  it('first build: only for a source with no subjects yet; an addition there is redirected', async () => {
    const refused = script('propose_first_build', { connection_id: connectionId });
    await turn('build');
    expect(refused.toolResult?.content).toMatch(/already has subjects/);

    const [c2] = await db()('connections').insert({
      tenant_id: tenantId, name: 'Odoo', type: 'duckdb', connector_type: 'odoo', selected_entities: ['sale_order'],
      warehouse_path: warehouse, query_engine: 'duckdb', last_sync_status: 'succeeded', profiling_status: 'done', config: JSON.stringify({}),
    }).returning('id');
    await db()('source_tables').insert({ tenant_id: tenantId, connection_id: idOf(c2), table_name: 'sale_order', is_active: true });
    const r = await runTool('propose_first_build', { connection_id: idOf(c2) });
    expect(r.proposal).toMatchObject({ kind: 'first-build', connectionId: idOf(c2), connectionName: 'Odoo' });
    const keep = await (await api()).post('/api/products/bus-matrix/start').set(auth()).send({ connectionId: idOf(c2) });
    expect(keep.status).not.toBe(400); // 503 without Redis: every check before the queue passed

    const redirected = script('propose_new_subject', { connection_id: idOf(c2), name: 'Orders', description: 'x', entities: ['sale_order'] });
    await turn('add');
    expect(redirected.toolResult?.content).toMatch(/propose_first_build/);
  });

  it('rebuild: proposed for one table, kept through the table\'s own Rebuild now', async () => {
    const r = await runTool('propose_rebuild_table', { table_id: dimId, why: 'Bring in the new accounts.' });
    expect(r.proposal).toMatchObject({ kind: 'rebuild', tableId: dimId, tableName: 'dim_account' });
    const keep = await (await api()).post(`/api/products/tables/${dimId}/run`).set(auth());
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect((await db()('product_tables').where({ id: dimId }).first()).delta_path).toBeTruthy();
  });

  let gridId: number;

  it('your tables: a new mapping, pre-filled from the subject column it maps; listed and opened', async () => {
    await db()('product_columns').where({ product_table_id: dimId, column_name: 'account_name' }).update({ column_role: 'dimension' });
    const r = await runTool('propose_new_grid', {
      name: 'Account segments', kind: 'mapping', description: 'Which segment each account is in.',
      columns: [{ name: 'Account', type: 'text', link_table: 'dim_account', link_column: 'account_name' }, { name: 'Segment', type: 'text' }],
      seed_from_link: true,
    });
    const p = r.proposal as Record<string, any>;
    expect(p).toMatchObject({ kind: 'grid-new', seedFromLink: true });
    expect(await db()('managed_grids').where({ tenant_id: tenantId, name: 'Account segments' }).first()).toBeUndefined();

    const created = await (await api()).post('/api/grids').set(auth()).send({ name: p.name, kind: p.gridKind, description: p.description, columns: p.columns });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    gridId = created.body.data.id;
    const link = created.body.data.columns.find((c: { link?: unknown }) => c.link);
    const values = await (await api()).get('/api/grids/link-values').query({ table: link.link.table, column: link.link.column }).set(auth());
    expect(values.body.data.values).toContain('Van Damme BVBA');
    await (await api()).put(`/api/grids/${gridId}/rows`).set(auth()).send({ rows: values.body.data.values.map((x: string) => ({ data: { [link.key]: x } })) });

    const list = await runTool('list_your_tables', {});
    expect(list.result).toContain('Account segments');
    const open = await runTool('open_your_table', { grid_id: gridId });
    expect(open.focus).toEqual({ kind: 'grid', gridId });
    expect(open.result).toContain('Van Damme BVBA');
  });

  it('your tables: rows changed, added and removed are shown as such, kept and undone', async () => {
    const r = await runTool('propose_grid_rows', {
      grid_id: gridId,
      change: [{ row: 1, values: { Segment: 'Key account' } }],
      remove: [2],
      add: [{ Account: 'New customer', Segment: 'SMB' }],
    });
    const p = r.proposal as Record<string, any>;
    expect(p.diff.map((d: { status: string }) => d.status)).toEqual(['changed', 'removed', 'added']);
    expect(p.rowsAfter).toHaveLength(p.rowsBefore.length);
    const before = await db()('managed_grid_rows').where({ grid_id: gridId }).count<{ count: string }[]>('id as count');

    expect((await (await api()).put(`/api/grids/${gridId}/rows`).set(auth()).send({ rows: p.rowsAfter.map((data: object) => ({ data })) })).status).toBe(200);
    const kept = await db()('managed_grid_rows').where({ grid_id: gridId }).orderBy('position').select('data');
    expect(kept.some((row: { data: Record<string, unknown> }) => Object.values(row.data).includes('New customer'))).toBe(true);
    expect((await (await api()).put(`/api/grids/${gridId}/rows`).set(auth()).send({ rows: p.rowsBefore.map((data: object) => ({ data })) })).status).toBe(200);
    const after = await db()('managed_grid_rows').where({ grid_id: gridId }).count<{ count: string }[]>('id as count');
    expect(after[0].count).toBe(before[0].count);

    const unknown = script('propose_grid_rows', { grid_id: gridId, add: [{ Colour: 'red' }] });
    await turn('add');
    expect(unknown.toolResult?.content).toMatch(/has no column "Colour"/);

    expect((await (await api()).delete(`/api/grids/${gridId}`).set(auth())).status).toBeLessThan(300);
  });
});

it('every tool the coworker offers is exercised above', () => {
  const covered = new Set([
    'describe_workspace', 'search_catalog', 'open_subject', 'open_table', 'open_source_table', 'table_lineage',
    'table_usage', 'list_definitions', 'check_relationship', 'source_status', 'propose_sql_change',
    'propose_relationship', 'propose_glossary_term', 'propose_new_table', 'propose_new_subject',
    'propose_descriptions', 'propose_metric', 'propose_glossary_change', 'propose_relationship_review',
    'propose_rebuild_table', 'propose_first_build', 'list_your_tables', 'open_your_table',
    'propose_new_grid', 'propose_grid_rows', 'run_query',
    // preview_rows goes to the product-preview route, which reads a MATERIALISED
    // table; it is pinned in coworker.test.ts (withheld from hybrid tenants).
    'preview_rows',
  ]);
  expect(COWORKER_TOOLS.map((t) => t.definition.name).filter((n) => !covered.has(n))).toEqual([]);
});
