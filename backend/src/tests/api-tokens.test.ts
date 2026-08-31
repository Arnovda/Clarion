/**
 * Personal API tokens + the add-in surface.
 *
 * A token is a long-lived credential that sits on somebody's laptop inside
 * Excel, so these tests are mostly about the ways it must STOP working:
 * revoked, expired, owned by a deactivated user, pointed at another tenant's
 * data. The happy path is one test; the refusals are the rest.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { semanticDb } from '../db/knex';
import { request, registerUser } from './helpers';

describe('personal API tokens', () => {
  let agent: Awaited<ReturnType<typeof request>>;
  let owner: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    agent = await request();
    owner = await registerUser({ companyName: `TokenCo-${Date.now()}` });
  });

  /** A minimal connection row, so a saved question has something to hang off. */
  async function makeConnection(tenantId: number): Promise<number> {
    const [row] = await semanticDb('connections')
      .insert({ tenant_id: tenantId, name: 'probe', type: 'sqlite', config: JSON.stringify({}) })
      .returning(['id']);
    return Number(row.id);
  }

  async function mint(name = 'Excel on my laptop') {
    const res = await agent
      .post('/api/api-tokens')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.data as { id: number; token: string; prefix: string };
  }

  it('returns the plaintext exactly once, and marks it as such', async () => {
    const created = await mint();
    expect(created.token).toMatch(/^clr_[0-9a-f]{64}$/);
    expect(created.prefix).toBe(created.token.slice(0, 12));

    // The listing must never be able to reconstruct it.
    const list = await agent.get('/api/api-tokens').set('Authorization', `Bearer ${owner.token}`);
    expect(list.status).toBe(200);
    const row = list.body.data.find((t: { id: number }) => t.id === created.id);
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(row.token_hash).toBeUndefined();
  });

  it('authenticates as its owner', async () => {
    const created = await mint();
    const res = await agent.get('/api/addin/me').set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(owner.user.email);
    expect(res.body.data.role).toBe(owner.user.role);
  });

  it('refuses a token that was revoked', async () => {
    const created = await mint();
    const del = await agent
      .delete(`/api/api-tokens/${created.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(del.status).toBe(200);

    const res = await agent.get('/api/addin/me').set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(401);
  });

  it('refuses a token that has expired', async () => {
    const created = await mint();
    await semanticDb('api_tokens').where({ id: created.id }).update({
      expires_at: new Date(Date.now() - 1000),
    });
    const res = await agent.get('/api/addin/me').set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(401);
  });

  it('stops working the moment its owner is deactivated', async () => {
    // The token borrows its owner's authority; it must not outlive the
    // decision to close their account.
    const created = await mint();
    await semanticDb('users').where({ id: owner.user.id }).update({ is_active: false });
    try {
      const res = await agent.get('/api/addin/me').set('Authorization', `Bearer ${created.token}`);
      expect(res.status).toBe(401);
    } finally {
      await semanticDb('users').where({ id: owner.user.id }).update({ is_active: true });
    }
  });

  it('refuses a token that was never issued', async () => {
    const res = await agent
      .get('/api/addin/me')
      .set('Authorization', `Bearer clr_${'0'.repeat(64)}`);
    expect(res.status).toBe(401);
  });

  it('says the same thing for every kind of bad token', async () => {
    // A client cannot act differently on "expired" than on "wrong", and
    // telling it which only helps someone probing.
    const unknown = await agent
      .get('/api/addin/me')
      .set('Authorization', `Bearer clr_${'1'.repeat(64)}`);
    const revoked = await mint();
    await agent.delete(`/api/api-tokens/${revoked.id}`).set('Authorization', `Bearer ${owner.token}`);
    const revokedRes = await agent.get('/api/addin/me').set('Authorization', `Bearer ${revoked.token}`);
    expect(unknown.body.error).toBe(revokedRes.body.error);
  });

  it('leaves an ordinary session token working on the same route', async () => {
    // The token middleware must be a no-op for a JWT, or mounting it would
    // break the web app on any router it is added to.
    const res = await agent.get('/api/addin/me').set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await agent.get('/api/addin/me');
    expect(res.status).toBe(401);
  });

  it('carries the owner’s role and cannot exceed it', async () => {
    // A viewer's token is a viewer. Minting must not be a way to gain rights
    // the person does not have.
    const db = semanticDb;
    await db('users').where({ id: owner.user.id }).update({ role: 'viewer' });
    try {
      const created = await mint('viewer token');
      const me = await agent.get('/api/addin/me').set('Authorization', `Bearer ${created.token}`);
      expect(me.body.data.role).toBe('viewer');
    } finally {
      await db('users').where({ id: owner.user.id }).update({ role: 'admin' });
    }
  });

  it('cannot revoke another account’s token, and cannot tell it exists', async () => {
    const created = await mint();
    const stranger = await registerUser({ companyName: `OtherCo-${Date.now()}` });
    const res = await agent
      .delete(`/api/api-tokens/${created.id}`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(res.status).toBe(404);

    // And the original still works — the failed revoke changed nothing.
    const me = await agent.get('/api/addin/me').set('Authorization', `Bearer ${created.token}`);
    expect(me.status).toBe(200);
  });

  it('sees only its own tenant’s saved questions', async () => {
    const created = await mint();
    const stranger = await registerUser({ companyName: `OtherCo2-${Date.now()}` });
    const db = semanticDb;
    const strangerConn = await makeConnection(stranger.user.tenantId);

    // A question that belongs to somebody else entirely.
    await db('saved_questions').insert({
      tenant_id: stranger.user.tenantId,
      connection_id: strangerConn,
      question: 'What is the other tenant revenue?',
      normalized_question: 'what is the other tenant revenue',
      sql: 'SELECT 1',
      created_by: stranger.user.id,
    });

    const res = await agent.get('/api/addin/questions').set('Authorization', `Bearer ${created.token}`);
    expect(res.status).toBe(200);
    const questions = res.body.data as { question: string }[];
    expect(questions.some((q) => q.question.includes('other tenant'))).toBe(false);
  });

  it('refuses to run a saved question belonging to another tenant', async () => {
    const created = await mint();
    const stranger = await registerUser({ companyName: `OtherCo3-${Date.now()}` });
    const db = semanticDb;
    const strangerConn = await makeConnection(stranger.user.tenantId);
    const [row] = await db('saved_questions')
      .insert({
        tenant_id: stranger.user.tenantId,
        connection_id: strangerConn,
      connection_id: strangerConn,
        question: 'Theirs',
        normalized_question: 'theirs',
        sql: 'SELECT 1',
        created_by: stranger.user.id,
      })
      .returning(['id']);

    const res = await agent
      .post(`/api/addin/questions/${row.id}/run`)
      .set('Authorization', `Bearer ${created.token}`)
      .send({});
    // 404, not 403 — a cross-tenant id must not be confirmed to exist.
    expect(res.status).toBe(404);
  });

  it('validates the token name instead of storing an empty one', async () => {
    const res = await agent
      .post('/api/api-tokens')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});
