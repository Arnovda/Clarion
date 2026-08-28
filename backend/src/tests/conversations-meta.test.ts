/**
 * Ask AI Release 1 persistence — the truths the 2026-08-27 assessment found
 * missing, pinned:
 *
 *  1. The `meta` bundle (assumptions, sub-scores, sources, …) round-trips
 *     through POST /conversations/:id/messages → GET /conversations/:id.
 *     Before migration 82 it was silently dropped, so reloaded answers
 *     looked more certain than they were.
 *  2. PATCH /conversations/:id/messages/:messageId — the corrected-answer
 *     persistence: updates land, meta MERGES (a repair update must not wipe
 *     the assumptions the original persist wrote), rows cap at 200, and
 *     another user's conversation is a 404.
 *  3. A thumbs-down creates a definition gap that GET /api/reports/gaps can
 *     actually return — the old inner join on query_log made every
 *     user-reported bad answer structurally invisible (NULL query_log_id).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { migrateTestDb, closeTestDb } from './db-helpers';

let token: string;
let otherToken: string;

beforeAll(async () => {
  await migrateTestDb();
  const a = await registerUser();
  token = a.token;
  const b = await registerUser();
  otherToken = b.token;
});

afterAll(async () => {
  await closeTestDb();
});

async function createConversation(tok: string): Promise<number> {
  const agent = await request();
  const res = await agent
    .post('/api/conversations')
    .set('Authorization', `Bearer ${tok}`)
    .send({ title: 'meta test' });
  expect(res.status).toBe(200);
  return res.body.data.id as number;
}

async function appendMessage(tok: string, convId: number, body: Record<string, unknown>): Promise<number> {
  const agent = await request();
  const res = await agent
    .post(`/api/conversations/${convId}/messages`)
    .set('Authorization', `Bearer ${tok}`)
    .send(body);
  expect(res.status).toBe(200);
  return res.body.data.id as number;
}

describe('conversation message meta', () => {
  it('round-trips the meta bundle through append + fetch', async () => {
    const convId = await createConversation(token);
    const meta = {
      assumptions: ['Revenue excl. VAT'],
      subScores: { schema: 0.9, join: 0.8, formula: 0.85 },
      sources: [{ name: 'fact_receivables', kind: 'product', lastRefreshedAt: '2026-08-26T22:14:00Z' }],
      answeredInMs: 9200,
    };
    await appendMessage(token, convId, {
      role: 'assistant',
      content: 'You are owed €118.460,21.',
      question: 'Who still has to pay me?',
      meta,
    });

    const agent = await request();
    const res = await agent
      .get(`/api/conversations/${convId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const msg = res.body.data.messages.find((m: { role: string }) => m.role === 'assistant');
    const stored = typeof msg.meta === 'string' ? JSON.parse(msg.meta) : msg.meta;
    expect(stored.assumptions).toEqual(['Revenue excl. VAT']);
    expect(stored.subScores.schema).toBe(0.9);
    expect(stored.sources[0].name).toBe('fact_receivables');
    expect(stored.answeredInMs).toBe(9200);
  });
});

describe('PATCH /conversations/:id/messages/:messageId', () => {
  it('persists a corrected answer and MERGES meta instead of replacing it', async () => {
    const convId = await createConversation(token);
    const msgId = await appendMessage(token, convId, {
      role: 'assistant',
      content: 'Wrong answer: -€118.460,21',
      sql: 'SELECT wrong',
      rows: [{ open_ar_amount: -118460.21 }],
      warning: 'All values are negative.',
      meta: { assumptions: ['Open invoices only'] },
    });

    const agent = await request();
    const patch = await agent
      .patch(`/api/conversations/${convId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        content: 'Corrected: €118.460,21 outstanding.',
        sql: 'SELECT right',
        rows: [{ open_ar_amount: 118460.21 }],
        confidence: 0.95,
        warning: null,
        wasRepaired: true,
        meta: { repairSummary: ['Checked the sign convention on credit entries.'] },
      });
    expect(patch.status).toBe(200);

    const res = await agent
      .get(`/api/conversations/${convId}`)
      .set('Authorization', `Bearer ${token}`);
    const msg = res.body.data.messages.find((m: { id: number }) => m.id === msgId);
    expect(msg.content).toBe('Corrected: €118.460,21 outstanding.');
    expect(msg.sql).toBe('SELECT right');
    expect(msg.was_repaired).toBe(true);
    expect(msg.warning).toBeNull();
    const rows = typeof msg.rows === 'string' ? JSON.parse(msg.rows) : msg.rows;
    expect(rows[0].open_ar_amount).toBe(118460.21);
    const meta = typeof msg.meta === 'string' ? JSON.parse(msg.meta) : msg.meta;
    // The merge is the point: repairSummary added, assumptions NOT wiped.
    expect(meta.repairSummary).toEqual(['Checked the sign convention on credit entries.']);
    expect(meta.assumptions).toEqual(['Open invoices only']);
  });

  it('caps stored rows at 200', async () => {
    const convId = await createConversation(token);
    const msgId = await appendMessage(token, convId, {
      role: 'assistant', content: 'big', rows: [{ n: 1 }],
    });
    const agent = await request();
    const many = Array.from({ length: 250 }, (_, i) => ({ n: i }));
    const patch = await agent
      .patch(`/api/conversations/${convId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: many });
    expect(patch.status).toBe(200);
    const res = await agent
      .get(`/api/conversations/${convId}`)
      .set('Authorization', `Bearer ${token}`);
    const msg = res.body.data.messages.find((m: { id: number }) => m.id === msgId);
    const rows = typeof msg.rows === 'string' ? JSON.parse(msg.rows) : msg.rows;
    expect(rows.length).toBe(200);
  });

  it("refuses another user's conversation with 404, and empty updates with 400", async () => {
    const convId = await createConversation(token);
    const msgId = await appendMessage(token, convId, { role: 'assistant', content: 'mine' });

    const agent = await request();
    const foreign = await agent
      .patch(`/api/conversations/${convId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: 'stolen' });
    expect(foreign.status).toBe(404);

    const empty = await agent
      .patch(`/api/conversations/${convId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(empty.status).toBe(400);
  });
});

describe('feedback gaps reach the admin gaps list', () => {
  it('a thumbs-down (no query_log row) is visible in GET /api/reports/gaps', async () => {
    const convId = await createConversation(token);
    const question = `Why is column X empty? ${Date.now()}`;
    const msgId = await appendMessage(token, convId, {
      role: 'assistant',
      content: 'Some answer.',
      question,
    });

    const agent = await request();
    const fb = await agent
      .patch(`/api/conversations/messages/${msgId}/feedback`)
      .set('Authorization', `Bearer ${token}`)
      .send({ feedback: 'down', comment: 'numbers look wrong' });
    expect(fb.status).toBe(200);

    // The gap row has query_log_id NULL — the old inner join dropped it.
    const gaps = await agent
      .get('/api/reports/gaps?limit=50')
      .set('Authorization', `Bearer ${token}`);
    expect(gaps.status).toBe(200);
    const rows = gaps.body.data as Array<{ gap_description: string; question_text: string | null }>;
    const mine = rows.find((g) => g.gap_description.includes(question));
    expect(mine).toBeTruthy();
    expect(mine!.gap_description).toContain('numbers look wrong');
  });
});

describe('worksheet steps (migration 84)', () => {
  it('parentMessageId, label and dataAsOf round-trip through append + fetch', async () => {
    const convId = await createConversation(token);
    const rootId = await appendMessage(token, convId, {
      role: 'assistant',
      content: 'Root answer.',
      question: 'Total revenue this year?',
      dataAsOf: '2026-08-21T06:00:00Z',
    });
    const childId = await appendMessage(token, convId, {
      role: 'assistant',
      content: 'Branch answer.',
      question: 'Same, drafts included?',
      parentMessageId: rootId,
      label: 'Same, drafts included',
    });

    const agent = await request();
    const res = await agent
      .get(`/api/conversations/${convId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const msgs = res.body.data.messages as Array<Record<string, unknown>>;
    const root = msgs.find((m) => m.id === rootId)!;
    const child = msgs.find((m) => m.id === childId)!;
    expect(root.parent_message_id).toBeNull();
    expect(root.data_as_of).toBeTruthy();
    expect(child.parent_message_id).toBe(rootId);
    expect(child.label).toBe('Same, drafts included');
    expect(child.starred).toBe(false);
  });

  it('refuses a parent from another conversation (400) — the tree must stay internal', async () => {
    const convA = await createConversation(token);
    const convB = await createConversation(token);
    const inA = await appendMessage(token, convA, { role: 'assistant', content: 'A.', question: 'a?' });

    const agent = await request();
    const res = await agent
      .post(`/api/conversations/${convB}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'assistant', content: 'B.', question: 'b?', parentMessageId: inA });
    expect(res.status).toBe(400);
  });

  it('PATCH renames and stars a step; label null reverts to the auto label', async () => {
    const convId = await createConversation(token);
    const msgId = await appendMessage(token, convId, {
      role: 'assistant', content: 'X.', question: 'Who are my top 5 customers?',
    });

    const agent = await request();
    const rename = await agent
      .patch(`/api/conversations/${convId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Top 5 customers', starred: true });
    expect(rename.status).toBe(200);

    let res = await agent.get(`/api/conversations/${convId}`).set('Authorization', `Bearer ${token}`);
    let msg = (res.body.data.messages as Array<Record<string, unknown>>).find((m) => m.id === msgId)!;
    expect(msg.label).toBe('Top 5 customers');
    expect(msg.starred).toBe(true);

    const revert = await agent
      .patch(`/api/conversations/${convId}/messages/${msgId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: null });
    expect(revert.status).toBe(200);
    res = await agent.get(`/api/conversations/${convId}`).set('Authorization', `Bearer ${token}`);
    msg = (res.body.data.messages as Array<Record<string, unknown>>).find((m) => m.id === msgId)!;
    expect(msg.label).toBeNull();
    expect(msg.starred).toBe(true); // untouched by the label revert
  });
});
