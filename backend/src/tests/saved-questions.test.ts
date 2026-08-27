/**
 * Saved questions + pin-widget — Ask AI Release 3 ("answers go somewhere").
 *
 * What must stay true:
 *  1. The SQL guard runs at SAVE time — an unsafe query must never be stored,
 *     because a verified row bypasses generation on every future exact match.
 *  2. `verified` is honoured only for curators (admin/analyst); a viewer can
 *     save but never verify — including via the create body.
 *  3. Matching is on the NORMALIZED question: two spellings of the same
 *     question collide (409) instead of silently creating a second row the
 *     verified lookup could race against.
 *  4. Tenant isolation on every mutating route is an EXPLICIT tenant_id
 *     filter (404 for foreign ids) — not RLS, which tests run without.
 *  5. pin-widget appends only to dashboards the caller OWNS, and guards the
 *     widget SQL server-side no matter what the client derived.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, makeToken } from './helpers';
import { migrateTestDb, closeTestDb, getTestDb } from './db-helpers';
import { normalizeQuestion } from '../services/savedQuestions';

let adminToken: string;
let viewerToken: string;
let otherToken: string;   // a different tenant's admin
let tenantA: number;
let connA: number;

beforeAll(async () => {
  await migrateTestDb();
  const a = await registerUser();
  adminToken = a.token;
  tenantA = a.user.tenantId;

  const db = getTestDb();
  const [viewer] = await db('users')
    .insert({
      tenant_id: tenantA,
      email: `viewer-${Date.now()}@test.com`,
      password_hash: 'x',
      display_name: 'Viewer',
      role: 'viewer',
    })
    .returning('id');
  const viewerId = typeof viewer === 'object' ? (viewer as { id: number }).id : (viewer as number);
  viewerToken = makeToken({ sub: viewerId, tenantId: tenantA, role: 'viewer', email: 'viewer@test.com' });

  const [conn] = await db('connections')
    .insert({ tenant_id: tenantA, name: 'Test conn', type: 'sqlite', config: JSON.stringify({}) })
    .returning('id');
  connA = typeof conn === 'object' ? (conn as { id: number }).id : (conn as number);

  const b = await registerUser();
  otherToken = b.token;
});

afterAll(async () => {
  await closeTestDb();
});

async function save(tok: string, body: Record<string, unknown>) {
  return (await request())
    .post('/api/saved-questions')
    .set('Authorization', `Bearer ${tok}`)
    .send(body);
}

describe('normalizeQuestion', () => {
  it('collapses case, whitespace and trailing punctuation', () => {
    expect(normalizeQuestion('  Wie moet  mij nog  betalen?? ')).toBe('wie moet mij nog betalen');
    expect(normalizeQuestion('Total revenue last month.')).toBe(normalizeQuestion('total  REVENUE last month'));
  });
});

describe('saved questions', () => {
  it('curator saves verified; fields land; normalized question stored', async () => {
    const res = await save(adminToken, {
      question: 'Who still has to pay me?',
      sql: 'SELECT customer, amount FROM fact_receivables',
      tablesUsed: ['fact_receivables'],
      connectionId: connA,
      dataLayer: 'product',
      verified: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.normalized_question).toBe('who still has to pay me');
    expect(res.body.data.data_layer).toBe('product');
  });

  it('a viewer can save, but verified is refused silently (stored false)', async () => {
    const res = await save(viewerToken, {
      question: 'Viewer question one',
      sql: 'SELECT 1 AS x',
      connectionId: connA,
      verified: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.verified).toBe(false);
    expect(res.body.data.verified_by).toBeNull();
  });

  it('refuses unsafe SQL with 400 — nothing stored', async () => {
    const res = await save(adminToken, {
      question: 'Sneaky drop',
      sql: 'DROP TABLE users',
      connectionId: connA,
    });
    expect(res.status).toBe(400);
    const row = await getTestDb()('saved_questions').where({ normalized_question: 'sneaky drop' }).first();
    expect(row).toBeUndefined();
  });

  it('normalized duplicate on the same connection → 409', async () => {
    const res = await save(adminToken, {
      question: '  who STILL has to pay me ',   // same normalized as the first save
      sql: 'SELECT 2 AS x',
      connectionId: connA,
    });
    expect(res.status).toBe(409);
  });

  it('unknown connection → 404', async () => {
    const res = await save(adminToken, {
      question: 'No such connection',
      sql: 'SELECT 1 AS x',
      connectionId: 999999,
    });
    expect(res.status).toBe(404);
  });

  it('list is tenant-scoped and verified-first', async () => {
    const mine = await (await request())
      .get('/api/saved-questions')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(mine.status).toBe(200);
    const questions = (mine.body.data as Array<{ question: string; verified: boolean }>);
    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions[0].verified).toBe(true); // verified sorts first

    const theirs = await (await request())
      .get('/api/saved-questions')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(theirs.status).toBe(200);
    expect((theirs.body.data as unknown[]).length).toBe(0);
  });

  it('verify: viewer 403; foreign tenant 404; curator flips the flag', async () => {
    const row = await getTestDb()('saved_questions').where({ normalized_question: 'viewer question one' }).first();

    const asViewer = await (await request())
      .patch(`/api/saved-questions/${row.id}/verify`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ verified: true });
    expect(asViewer.status).toBe(403);

    const foreign = await (await request())
      .patch(`/api/saved-questions/${row.id}/verify`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ verified: true });
    expect(foreign.status).toBe(404);

    const asAdmin = await (await request())
      .patch(`/api/saved-questions/${row.id}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ verified: true });
    expect(asAdmin.status).toBe(200);
    const after = await getTestDb()('saved_questions').where({ id: row.id }).first();
    expect(after.verified).toBe(true);
    expect(after.verified_by).not.toBeNull();
  });

  it('delete: viewer refused on someone else’s row (403), allowed on their own', async () => {
    const adminRow = await getTestDb()('saved_questions').where({ normalized_question: 'who still has to pay me' }).first();
    const refuse = await (await request())
      .delete(`/api/saved-questions/${adminRow.id}`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(refuse.status).toBe(403);

    const ownRow = await getTestDb()('saved_questions').where({ normalized_question: 'viewer question one' }).first();
    const ok = await (await request())
      .delete(`/api/saved-questions/${ownRow.id}`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(ok.status).toBe(200);
    expect(await getTestDb()('saved_questions').where({ id: ownRow.id }).first()).toBeUndefined();
  });
});

describe('pin-widget', () => {
  async function pin(tok: string, body: Record<string, unknown>) {
    return (await request())
      .post('/api/dashboards/pin-widget')
      .set('Authorization', `Bearer ${tok}`)
      .send(body);
  }

  it('refuses unsafe widget SQL with 400', async () => {
    const res = await pin(adminToken, {
      connectionId: connA,
      widget: { type: 'kpi_card', title: 'Bad', sql: "SELECT * FROM read_parquet('az://x/y')" },
    });
    expect(res.status).toBe(400);
  });

  it('creates a new dashboard from an answer, then appends to it when owned', async () => {
    const created = await pin(adminToken, {
      connectionId: connA,
      title: 'Receivables',
      widget: { type: 'kpi_card', title: 'Open receivables', sql: 'SELECT SUM(amount) AS value FROM fact_receivables' },
    });
    expect(created.status).toBe(200);
    expect(created.body.data.created).toBe(true);
    const dashId = created.body.data.id as number;

    const appended = await pin(adminToken, {
      dashboardId: dashId,
      connectionId: connA,
      widget: { type: 'data_table', title: 'Detail', sql: 'SELECT customer, amount FROM fact_receivables' },
    });
    expect(appended.status).toBe(200);

    const row = await getTestDb()('dashboards').where({ id: dashId }).first();
    const spec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
    expect(spec.widgets.length).toBe(2);
    expect(spec.widgets[1].type).toBe('data_table');
    expect(spec.widgets[1].colSpan).toBe(4);
  });

  it('cannot append to a dashboard the caller does not own → 404', async () => {
    const dash = await getTestDb()('dashboards').orderBy('id', 'desc').first();
    const res = await pin(otherToken, {
      dashboardId: dash.id,
      connectionId: connA,
      widget: { type: 'bar_chart', title: 'X', sql: 'SELECT a AS label, b AS value FROM t' },
    });
    expect(res.status).toBe(404);
  });
});
