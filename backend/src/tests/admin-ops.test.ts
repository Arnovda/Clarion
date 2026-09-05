/**
 * Wave B item 3 — operating without a database session.
 *
 *  6-1 the correlation id: a request's X-Request-ID lands on the sync run
 *      it triggers, rides nested tenant scopes, and is stamped on job data
 *      at enqueue time;
 *  6-2 the recent-errors feed: every kind, the correlation id beside it,
 *      the tenant filter, nothing from another tenant;
 *  6-4 announcements: published by the operator, seen by a plain user,
 *      gone once ended;
 *  6-5 operator user administration: invite, role, deactivate (never the
 *      last admin), reset MFA — each audited into the CUSTOMER's trail;
 *  6-6 the queues endpoint answers honestly without Redis; retry policy
 *      constants are what the design says.
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { withTenantAiContext } from '../services/aiBudget';
import { getCorrelation } from '../utils/requestScope';
import { RETRIED_JOB_OPTIONS, UNRETRIED_JOB_OPTIONS } from '../jobs/queues';
import { _resetAnnouncementCache } from '../services/announcements';

let operatorToken: string;
let tenantId: number;
let adminToken: string;
let adminId: number;
let otherTenantId: number;
let savedOperators: string | undefined;

beforeAll(async () => {
  await cleanTestDb();
  const operatorEmail = `operator-ops-${Date.now()}@test.com`;
  const op = await registerUser({ email: operatorEmail, companyName: 'OpsOperatorCo' });
  operatorToken = op.token;
  const t = await registerUser({ email: `ops-admin-${Date.now()}@test.com`, companyName: 'OpsCustomerCo' });
  tenantId = t.user.tenantId; adminToken = t.token; adminId = t.user.id;
  const o = await registerUser({ email: `ops-other-${Date.now()}@test.com`, companyName: 'OtherCo' });
  otherTenantId = o.user.tenantId;
  savedOperators = process.env.PLATFORM_OPERATOR_EMAILS;
  process.env.PLATFORM_OPERATOR_EMAILS = operatorEmail;
});

afterAll(async () => {
  process.env.PLATFORM_OPERATOR_EMAILS = savedOperators;
  await closeTestDb();
});

const op = (m: 'get' | 'post' | 'patch' | 'delete', url: string) =>
  request().then((a) => a[m](url).set('Authorization', `Bearer ${operatorToken}`));

describe('6-1 correlation id', () => {
  it('rides nested tenant scopes unless a scope names its own', async () => {
    await withTenantAiContext({ tenantId: 1, requestId: 'req-outer', jobId: 'j1', queue: 'transformation' }, async () => {
      expect(getCorrelation()).toEqual({ requestId: 'req-outer', jobId: 'j1', queue: 'transformation' });
      await withTenantAiContext(2, async () => {
        // A processor re-entering with just the tenant keeps the thread.
        expect(getCorrelation()).toEqual({ requestId: 'req-outer', jobId: 'j1', queue: 'transformation' });
      });
      await withTenantAiContext({ tenantId: 3, requestId: 'req-inner' }, async () => {
        expect(getCorrelation().requestId).toBe('req-inner');
      });
    });
    expect(getCorrelation()).toEqual({});
  });

  it('the X-Request-ID of a sync trigger lands on the source_sync_runs row', async () => {
    const [conn] = await getTestDb()('connections').insert({
      tenant_id: tenantId, name: 'EO', type: 'duckdb', connector_type: 'exactonline',
      selected_entities: ['Accounts'], config: JSON.stringify({}),
    }).returning('id');
    const connectionId = Number((conn as { id?: number }).id ?? conn);
    const agent = await request();
    const res = await agent.post(`/api/connections/${connectionId}/sync`)
      .set('Authorization', `Bearer ${adminToken}`).set('X-Request-ID', 'corr-test-0001').send({});
    // The run is queued (Redis absent → inline launch may fail later); the
    // row exists either way and carries the id.
    expect(res.headers['x-request-id']).toBe('corr-test-0001');
    const run = await getTestDb()('source_sync_runs').where({ tenant_id: tenantId, connection_id: connectionId }).orderBy('id', 'desc').first();
    expect(run).toBeDefined();
    expect(run.request_id).toBe('corr-test-0001');
  });

  it('retry policy: idempotent queues retry three times with backoff; design and email do not', () => {
    expect(RETRIED_JOB_OPTIONS.attempts).toBe(3);
    expect(RETRIED_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 15_000 });
    expect(UNRETRIED_JOB_OPTIONS.attempts).toBe(1);
    // Count-capped as well as age-capped (5-5): Redis runs with noeviction.
    expect((RETRIED_JOB_OPTIONS.removeOnFail as { count: number }).count).toBeGreaterThan(0);
  });
});

describe('6-2 recent errors', () => {
  it('lists every kind with its correlation id, filters by tenant, and never shows another tenant', async () => {
    const db = getTestDb();
    const [c] = await db('connections').insert({ tenant_id: tenantId, name: 'Odoo', type: 'duckdb', connector_type: 'odoo', selected_entities: ['res_partner'], config: JSON.stringify({}) }).returning('id');
    const connId = Number((c as { id?: number }).id ?? c);
    await db('source_sync_runs').insert({ tenant_id: tenantId, connection_id: connId, status: 'partial', error_message: '1 of 2 entities failed: res_partner (HTTP 500)', failed_entities: JSON.stringify({ res_partner: 'HTTP 500' }), request_id: 'corr-err-1', queued_at: new Date(), completed_at: new Date() });
    const [p] = await db('data_products').insert({ tenant_id: tenantId, name: 'Sales', status: 'active' }).returning('id');
    const productId = Number((p as { id?: number }).id ?? p);
    await db('transformation_runs').insert({ tenant_id: tenantId, product_id: productId, status: 'failed', error_message: 'Binder Error: column x', started_at: new Date(), finished_at: new Date(), triggered_by: 'test' });
    await db('ai_call_log').insert({ tenant_id: tenantId, model: 'm', call_label: 'generate_sql', category: 'question', failed: true, error_code: 'rate_limit' });
    // The other tenant's failure must not appear under a tenant filter.
    const [oc] = await db('connections').insert({ tenant_id: otherTenantId, name: 'X', type: 'duckdb', connector_type: 'odoo', selected_entities: ['a'], config: JSON.stringify({}) }).returning('id');
    await db('source_sync_runs').insert({ tenant_id: otherTenantId, connection_id: Number((oc as { id?: number }).id ?? oc), status: 'failed', error_message: 'other tenant secret', queued_at: new Date(), completed_at: new Date() });

    const res = await op('get', `/api/admin/ops/errors?tenantId=${tenantId}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.errors as Array<Record<string, unknown>>;
    // (The earlier sync trigger's run also failed — no worker here — so
    // 'sync' can appear twice; the partial one is the one under test.)
    const kinds = new Set(rows.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['ai', 'sync', 'transformation']);
    const sync = rows.find((r) => r.kind === 'sync' && r.requestId === 'corr-err-1')!;
    expect(sync.requestId).toBe('corr-err-1');
    expect(sync.summary).toMatch(/Partial sync of Odoo/);
    expect(sync.tenantName).toBe('OpsCustomerCo');
    expect(JSON.stringify(rows)).not.toContain('other tenant secret');

    const all = await op('get', '/api/admin/ops/errors');
    expect(all.status).toBe(200);
    expect(JSON.stringify(all.body.data.errors)).toContain('other tenant secret');

    const unknown = await op('get', '/api/admin/ops/errors?tenantId=999999');
    expect(unknown.status).toBe(404);

    const agent = await request();
    const asAdmin = await agent.get('/api/admin/ops/errors').set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(404);
  });
});

describe('6-6 queues', () => {
  it('says so when there are no queues (no Redis), instead of pretending', async () => {
    const res = await op('get', '/api/admin/ops/queues');
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
    const retry = await op('post', '/api/admin/ops/queues/transformation/jobs/1/retry');
    expect(retry.status).toBe(400);
    const bad = await op('post', '/api/admin/ops/queues/nope/jobs/1/cancel');
    expect(bad.status).toBe(400);
  });
});

describe('6-4 announcements', () => {
  it('published by the operator → seen by a plain user → gone once ended', async () => {
    _resetAnnouncementCache();
    const agent = await request();
    const { token: viewer } = await createUserWithToken({ tenantId, role: 'viewer' });
    const before = await agent.get('/api/announcements').set('Authorization', `Bearer ${viewer}`);
    expect(before.status).toBe(200);
    expect(before.body.data.announcements).toEqual([]);

    const pub = await (await request()).post('/api/admin/ops/announcements').set('Authorization', `Bearer ${operatorToken}`)
      .send({ message: 'Dashboards are slow; we are on it.', level: 'critical' });
    expect(pub.status).toBe(201);
    const id = pub.body.data.id as number;
    _resetAnnouncementCache();

    const during = await agent.get('/api/announcements').set('Authorization', `Bearer ${viewer}`);
    expect(during.body.data.announcements.map((a: { id: number }) => a.id)).toContain(id);
    expect(during.body.data.announcements[0].level).toBe('critical');

    const ended = await (await request()).patch(`/api/admin/ops/announcements/${id}`).set('Authorization', `Bearer ${operatorToken}`).send({ end: true });
    expect(ended.status).toBe(200);
    expect(ended.body.data.endsAt).not.toBeNull();
    _resetAnnouncementCache();
    const after = await agent.get('/api/announcements').set('Authorization', `Bearer ${viewer}`);
    expect(after.body.data.announcements.map((a: { id: number }) => a.id)).not.toContain(id);

    // History keeps it; a tenant admin cannot reach the operator list.
    const list = await op('get', '/api/admin/ops/announcements');
    expect(list.body.data.announcements.map((a: { id: number }) => a.id)).toContain(id);
    const asAdmin = await agent.get('/api/admin/ops/announcements').set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(404);

    const bad = await (await request()).post('/api/admin/ops/announcements').set('Authorization', `Bearer ${operatorToken}`).send({ message: 'x' });
    expect(bad.status).toBe(400);
  });
});

describe('6-5 operator user administration', () => {
  it('invites, changes role, refuses to strip the last admin, deactivates, resets MFA — all audited into the customer trail', async () => {
    const db = getTestDb();
    const invite = await (await request()).post(`/api/admin/tenants/${tenantId}/users/invite`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ email: 'colleague@opscustomer.test', displayName: 'Col League', role: 'analyst', reason: 'customer asked by phone' });
    expect(invite.status).toBe(201);
    expect(invite.body.data.user.role).toBe('analyst');
    expect(typeof invite.body.data.emailed).toBe('boolean');
    const colleagueId = invite.body.data.user.id as number;
    const row = await db('users').where({ id: colleagueId }).first();
    expect(row.tenant_id).toBe(tenantId);

    // The only active admin cannot be demoted or deactivated.
    const demote = await (await request()).patch(`/api/admin/tenants/${tenantId}/users/${adminId}`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ role: 'viewer', reason: 'test' });
    expect(demote.status).toBe(400);
    expect(demote.body.error).toMatch(/only active admin/);
    const deact = await (await request()).patch(`/api/admin/tenants/${tenantId}/users/${adminId}`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ isActive: false, reason: 'test' });
    expect(deact.status).toBe(400);

    // Promote the colleague, then the original admin may step down.
    const promote = await (await request()).patch(`/api/admin/tenants/${tenantId}/users/${colleagueId}`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ role: 'admin', reason: 'handover requested' });
    expect(promote.status).toBe(200);
    expect(promote.body.data.role).toBe('admin');
    const stepDown = await (await request()).patch(`/api/admin/tenants/${tenantId}/users/${adminId}`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ role: 'analyst', reason: 'handover' });
    expect(stepDown.status).toBe(200);
    const deactivate = await (await request()).patch(`/api/admin/tenants/${tenantId}/users/${adminId}`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ isActive: false, reason: 'left the company' });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.data.is_active).toBe(false);

    // MFA reset: refused when not enabled, works when it is.
    const noMfa = await (await request()).post(`/api/admin/tenants/${tenantId}/users/${colleagueId}/reset-mfa`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ reason: 'lost phone' });
    expect(noMfa.status).toBe(400);
    await db('users').where({ id: colleagueId }).update({ mfa_enabled_at: new Date(), mfa_secret: 'x' });
    const reset = await (await request()).post(`/api/admin/tenants/${tenantId}/users/${colleagueId}/reset-mfa`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ reason: 'lost phone' });
    expect(reset.status).toBe(200);
    const afterReset = await db('users').where({ id: colleagueId }).first();
    expect(afterReset.mfa_enabled_at).toBeNull();

    // Every act is in the CUSTOMER's audit trail as the operator.
    const audits = await db('audit_events').where({ tenant_id: tenantId, actor_role: 'platform_operator' }).select('action');
    const actions = audits.map((a) => a.action as string);
    for (const a of ['user.invite', 'user.update', 'user.deactivate', 'mfa.disable']) expect(actions).toContain(a);

    // A user of another tenant is not reachable through this tenant's path.
    const foreign = await (await request()).patch(`/api/admin/tenants/${otherTenantId}/users/${colleagueId}`).set('Authorization', `Bearer ${operatorToken}`)
      .send({ role: 'viewer', reason: 'not their tenant' });
    expect(foreign.status).toBe(404);
    // A tenant admin gets nothing (a fresh one — the original was just deactivated).
    const { token: freshAdmin } = await createUserWithToken({ tenantId, role: 'admin' });
    const asAdmin = await (await request()).post(`/api/admin/tenants/${tenantId}/users/invite`).set('Authorization', `Bearer ${freshAdmin}`)
      .send({ email: 'z@z.test', displayName: 'Z', role: 'viewer', reason: 'tenant admins may not' });
    expect(asAdmin.status).toBe(404);
  });
});
