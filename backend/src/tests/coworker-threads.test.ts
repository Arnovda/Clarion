/**
 * The Studio coworker's history — "your conversations, nobody else's".
 *
 * The per-user half is NOT enforced by RLS (the policy isolates tenants), so
 * these tests hold it directly: a colleague in the SAME tenant can neither
 * read, overwrite (by guessing the id) nor delete your thread, and another
 * tenant cannot reach it at all. Plus the role gate, the size bound and the
 * per-person cap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { MAX_THREADS_PER_USER } from '../routes/coworkerThreads';

let ownerToken: string;
let colleagueToken: string;
let viewerToken: string;
let strangerToken: string;
let tenantId: number;

beforeAll(async () => {
  await cleanTestDb();
  const owner = await registerUser({ email: 'thread-owner@test.com', companyName: 'ThreadCo' });
  ownerToken = owner.token;
  tenantId = owner.user.tenantId;
  colleagueToken = (await createUserWithToken({ tenantId, role: 'analyst' })).token;
  viewerToken = (await createUserWithToken({ tenantId, role: 'viewer' })).token;
  strangerToken = (await registerUser({ email: 'thread-stranger@test.com', companyName: 'OtherThreadCo' })).token;
});

afterAll(async () => { await closeTestDb(); });

const body = (title = 'What does this table hold?') => ({
  title,
  contextLabel: 'Reference › Item',
  messages: [
    { id: 'm1', role: 'user', text: title, trail: [], proposalIds: [], working: false, startedAt: 1 },
    { id: 'm2', role: 'assistant', text: 'It holds your items.', trail: [], proposalIds: ['p1'], working: false, startedAt: 2 },
  ],
  proposals: { p1: { status: 'kept', proposal: { id: 'p1', kind: 'glossary', term: 'Item' } } },
});

const put = async (token: string, id: string, b: unknown) =>
  (await request()).put(`/api/coworker/threads/${id}`).set('Authorization', `Bearer ${token}`).send(b);
const get = async (token: string, path = '') =>
  (await request()).get(`/api/coworker/threads${path}`).set('Authorization', `Bearer ${token}`);
const del = async (token: string, id: string) =>
  (await request()).delete(`/api/coworker/threads/${id}`).set('Authorization', `Bearer ${token}`);

describe('coworker threads', () => {
  const id = randomUUID();

  it('saves a thread, lists it, and returns it whole', async () => {
    expect((await put(ownerToken, id, body())).status).toBe(200);

    const list = await get(ownerToken);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id, title: 'What does this table hold?', contextLabel: 'Reference › Item', messageCount: 2 });
    expect(list.body.data[0].messages).toBeUndefined();

    const one = await get(ownerToken, `/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.messages).toHaveLength(2);
    expect(one.body.data.proposals.p1.status).toBe('kept');
  });

  it('saving again replaces the thread and moves it to the top', async () => {
    const other = randomUUID();
    await put(ownerToken, other, body('Second question'));
    const b = body();
    b.messages.push({ id: 'm3', role: 'user', text: 'And its group?', trail: [], proposalIds: [], working: false, startedAt: 3 });
    expect((await put(ownerToken, id, b)).status).toBe(200);
    const list = await get(ownerToken);
    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([id, other]);
    expect(list.body.data[0].messageCount).toBe(3);
    await del(ownerToken, other);
  });

  it('a colleague in the same tenant cannot read, overwrite or delete it', async () => {
    expect((await get(colleagueToken)).body.data).toHaveLength(0);
    expect((await get(colleagueToken, `/${id}`)).status).toBe(404);
    // Guessing the id: the upsert's conflict branch is owner-filtered.
    expect((await put(colleagueToken, id, body('Hijacked'))).status).toBe(404);
    expect((await del(colleagueToken, id)).status).toBe(404);
    const one = await get(ownerToken, `/${id}`);
    expect(one.body.data.title).toBe('What does this table hold?');
  });

  it('another tenant cannot reach it at all', async () => {
    expect((await get(strangerToken)).body.data).toHaveLength(0);
    expect((await get(strangerToken, `/${id}`)).status).toBe(404);
    expect((await put(strangerToken, id, body('Hijacked'))).status).toBe(404);
    expect((await del(strangerToken, id)).status).toBe(404);
  });

  it('viewers have no coworker, so no history either', async () => {
    expect((await get(viewerToken)).status).toBe(403);
    expect((await put(viewerToken, randomUUID(), body())).status).toBe(403);
  });

  it('refuses a malformed id, an empty title and an oversized body', async () => {
    expect((await put(ownerToken, 'not-a-uuid', body())).status).toBe(400);
    expect((await put(ownerToken, randomUUID(), { ...body(), title: '  ' })).status).toBe(400);
    const huge = body();
    huge.messages[1].text = 'x'.repeat(1_600_000);
    const r = await put(ownerToken, randomUUID(), huge);
    expect([413]).toContain(r.status);
  });

  it('keeps at most MAX_THREADS_PER_USER per person, dropping the oldest', async () => {
    const db = getTestDb();
    const owner = await db('coworker_threads').where({ id }).first();
    const rows = Array.from({ length: MAX_THREADS_PER_USER + 5 }, (_, i) => ({
      id: randomUUID(), tenant_id: tenantId, user_id: owner.user_id, title: `old ${i}`,
      messages: '[]', proposals: '{}', updated_at: new Date(Date.UTC(2020, 0, 1, 0, i)),
    }));
    await db('coworker_threads').insert(rows);
    expect((await put(ownerToken, id, body())).status).toBe(200);
    const count = await db('coworker_threads').where({ user_id: owner.user_id }).count<{ count: string }[]>('* as count');
    expect(Number(count[0].count)).toBe(MAX_THREADS_PER_USER);
    // The one just saved is kept; the oldest seeded ones went.
    expect(await db('coworker_threads').where({ id }).first()).toBeTruthy();
    expect(await db('coworker_threads').where({ title: 'old 0' }).first()).toBeUndefined();
  });

  it('deletes it for the owner', async () => {
    expect((await del(ownerToken, id)).status).toBe(200);
    expect((await get(ownerToken, `/${id}`)).status).toBe(404);
  });
});
