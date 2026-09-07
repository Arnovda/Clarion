/**
 * ONE ASSISTANT, TWO ENTRY POINTS (2026-09-07).
 *
 * `/build`'s chat and a topic page's Refine chat were two boxes in two places
 * that could not see each other. A user thinking "I want to see quotations"
 * cannot pre-sort that into change-this-subject or add-a-new-one — working it
 * out IS the question — so having to pick the box first meant answering before
 * asking. They are one assistant now; the ANCHOR (which subject you are in)
 * is the only difference.
 *
 * These tests pin the backend half: the anchor reaches the prompt when it is
 * the caller's own subject, and CANNOT when it is not. A forged anchor putting
 * another tenant's subject name into a prompt would be a cross-tenant leak
 * through the one field this change added.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import app from '../index';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { registerUser } from './helpers';

const db = getTestDb();

// Capture what the model is actually given. The assistant's value is entirely
// in its context, so that string is the thing worth asserting on.
const seen: string[] = [];
vi.mock('../ai/AIService', async (orig) => ({
  ...(await orig<typeof import('../ai/AIService')>()),
  respondBuildChat: vi.fn(async (coverage: string) => {
    seen.push(coverage);
    return { reply: 'ok', proposal: null };
  }),
}));

let alice: { token: string; tenantId: number };
let mallory: { token: string };
let aliceProductId: number;

beforeAll(async () => {
  await cleanTestDb();
  const a = await registerUser({ email: 'alice@anchor.test', companyName: 'Alice Co' });
  alice = { token: a.token, tenantId: a.user.tenantId };
  const m = await registerUser({ email: 'mallory@anchor.test', companyName: 'Mallory Co' });
  mallory = { token: m.token };

  const [conn] = await db('connections').insert({
    tenant_id: alice.tenantId, name: 'Alice source', type: 'duckdb',
    connector_type: 'exactonline', config: JSON.stringify({}),
  }).returning('id');
  const [prod] = await db('data_products').insert({
    tenant_id: alice.tenantId, connection_id: Number((conn as { id: number }).id ?? conn),
    name: 'Receivables', description: 'Who owes us money',
    status: 'approved', kind: 'analytics',
  }).returning('id');
  aliceProductId = Number((prod as { id: number }).id ?? prod);
});

afterAll(async () => { await closeTestDb(); });

const ask = (token: string, body: Record<string, unknown>) =>
  request(app).post('/api/products/build-chat')
    .set('Authorization', `Bearer ${token}`)
    .send({ messages: [{ role: 'user', content: 'I want to see quotations' }], ...body });

describe('the subject assistant anchor', () => {
  it('without an anchor the prompt says nothing about where the user is (the /build case)', async () => {
    seen.length = 0;
    const res = await ask(alice.token, {});
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('WHERE THE USER IS');
  });

  it('with the caller\'s own subject, the anchor reaches the prompt by name', async () => {
    seen.length = 0;
    const res = await ask(alice.token, { anchorProductId: aliceProductId });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('WHERE THE USER IS');
    expect(seen[0]).toContain('Receivables');
    expect(seen[0]).toContain('Who owes us money');
  });

  it('ANOTHER TENANT\'S subject id is dropped, not trusted into the prompt', async () => {
    // The whole risk this field introduces: a forged id must not leak the
    // other tenant's subject name. It answers normally, simply unanchored.
    seen.length = 0;
    const res = await ask(mallory.token, { anchorProductId: aliceProductId });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('Receivables');
    expect(seen[0]).not.toContain('WHERE THE USER IS');
  });

  it('a nonexistent anchor degrades to unanchored rather than failing the ask', async () => {
    seen.length = 0;
    const res = await ask(alice.token, { anchorProductId: 99999999 });
    expect(res.status).toBe(200);
    expect(seen[0]).not.toContain('WHERE THE USER IS');
  });

  it('rejects a malformed anchor at the schema, before any work', async () => {
    const res = await ask(alice.token, { anchorProductId: -1 });
    expect(res.status).toBe(400);
  });
});
