/**
 * Operator console — tenant administration (P1-5).
 *
 * The gate is the ONLY access control on this surface (it reads/writes
 * across tenants, so RLS is not the backstop it is everywhere else) —
 * hence the refusal tests for viewer, analyst AND admin, mirroring
 * feature-flags.test.ts. AUTH_STATUS_TTL_MS=0 so the suspend test can
 * observe P1-3's enforcement on the very next request.
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb } from './db-helpers';
import { semanticDb } from '../db/knex';

let operatorToken: string;
let operatorTenantId: number;
let targetTenantId: number;
let targetAdminToken: string;
let targetAdminId: number;
let savedOperators: string | undefined;

beforeAll(async () => {
  await cleanTestDb();

  const operatorEmail = `operator-${Date.now()}@test.com`;
  const op = await registerUser({ email: operatorEmail, companyName: 'OperatorCo' });
  operatorToken = op.token;
  operatorTenantId = op.user.tenantId;

  const target = await registerUser({ email: `target-${Date.now()}@test.com`, companyName: 'TargetCo' });
  targetTenantId = target.user.tenantId;
  targetAdminToken = target.token;
  targetAdminId = target.user.id;

  savedOperators = process.env.PLATFORM_OPERATOR_EMAILS;
  process.env.PLATFORM_OPERATOR_EMAILS = operatorEmail;
});

afterAll(async () => {
  process.env.PLATFORM_OPERATOR_EMAILS = savedOperators;
  await closeTestDb();
});

describe('operator gate', () => {
  it('refuses viewer, analyst AND admin with 404 — the console does not exist to them', async () => {
    const agent = await request();
    for (const role of ['viewer', 'analyst', 'admin'] as const) {
      const { token } = await createUserWithToken({ tenantId: targetTenantId, role });
      const res = await agent.get('/api/admin/tenants').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('GET /api/admin/tenants', () => {
  it('lists every tenant with per-tenant health, and the counts do not bleed across tenants', async () => {
    const agent = await request();
    const res = await agent.get('/api/admin/tenants').set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.callerTenantId).toBe(operatorTenantId);

    const rows = res.body.data.tenants as Array<Record<string, unknown>>;
    const target = rows.find((t) => t.id === targetTenantId)!;
    const operator = rows.find((t) => t.id === operatorTenantId)!;
    expect(target).toBeDefined();
    expect(operator).toBeDefined();
    expect(target.status).toBe('active');

    // The gate-refusal test above created three extra users in the TARGET
    // tenant; the operator tenant has exactly its one registrant. If a
    // health read ever dropped its tenant filter, both rows would show
    // the global total and this splits them apart.
    expect(Number(target.users)).toBeGreaterThanOrEqual(4);
    expect(Number(operator.users)).toBeLessThan(Number(target.users));

    // P1-6 traffic columns: present on every row, and NULL here — the test
    // process has no Redis, and "no data" must never render as zeros
    // pretending to be measurements.
    expect('requests24h' in target).toBe(true);
    expect(target.requests24h).toBeNull();
    expect(target.errors24h).toBeNull();
    expect(target.p95Ms24h).toBeNull();
  });
});

describe('suspend / resume', () => {
  it('suspend flips status, bites via requireAuth on the next request, and resume restores', async () => {
    const agent = await request();

    const susp = await agent
      .post(`/api/admin/tenants/${targetTenantId}/suspend`)
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(susp.status).toBe(200);

    // P1-3 enforcement: the target tenant's still-valid token is refused.
    const refused = await agent.get('/api/auth/me').set('Authorization', `Bearer ${targetAdminToken}`);
    expect(refused.status).toBe(401);

    // The audit row landed in the TARGET tenant's trail, naming the operator.
    const audit = await semanticDb('audit_events')
      .where({ tenant_id: targetTenantId, action: 'tenant.suspend' })
      .orderBy('id', 'desc')
      .first();
    expect(audit).toBeDefined();
    expect(audit.actor_role).toBe('platform_operator');

    const resume = await agent
      .post(`/api/admin/tenants/${targetTenantId}/resume`)
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(resume.status).toBe(200);

    const restored = await agent.get('/api/auth/me').set('Authorization', `Bearer ${targetAdminToken}`);
    expect(restored.status).toBe(200);
  });

  it('refuses to suspend the tenant the operator is signed into', async () => {
    const agent = await request();
    const res = await agent
      .post(`/api/admin/tenants/${operatorTenantId}/suspend`)
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(400);
    // And the operator still works — nothing was written.
    const row = await semanticDb('tenants').where({ id: operatorTenantId }).first();
    expect(row.status).toBe('active');
  });

  it('404s an unknown tenant', async () => {
    const agent = await request();
    const res = await agent
      .post('/api/admin/tenants/999999/suspend')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /:id/budget', () => {
  it('sets a numeric budget and back to null (unlimited), auditing both', async () => {
    const agent = await request();
    const set = await agent
      .patch(`/api/admin/tenants/${targetTenantId}/budget`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ monthlyTokenBudget: 5_000_000 });
    expect(set.status).toBe(200);
    let row = await semanticDb('tenants').where({ id: targetTenantId }).first();
    expect(Number(row.monthly_token_budget)).toBe(5_000_000);

    const clear = await agent
      .patch(`/api/admin/tenants/${targetTenantId}/budget`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ monthlyTokenBudget: null });
    expect(clear.status).toBe(200);
    row = await semanticDb('tenants').where({ id: targetTenantId }).first();
    expect(row.monthly_token_budget).toBeNull();

    const audits = await semanticDb('audit_events')
      .where({ tenant_id: targetTenantId, action: 'tenant.budget_change' });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('400s a negative budget', async () => {
    const agent = await request();
    const res = await agent
      .patch(`/api/admin/tenants/${targetTenantId}/budget`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ monthlyTokenBudget: -1 });
    expect(res.status).toBe(400);
  });
});

describe('POST /:id/impersonate', () => {
  it('issues a working token for a real user, audits into the target tenant, and returns NO refresh token', async () => {
    const agent = await request();
    const res = await agent
      .post(`/api/admin/tenants/${targetTenantId}/impersonate`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ userId: targetAdminId, reason: 'reproducing dashboard bug #42' });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    // The time-box: no refresh token means the session cannot be extended.
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data.expiresInMinutes).toBe(15);

    const me = await agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.tenantId).toBe(targetTenantId);

    const audit = await semanticDb('audit_events')
      .where({ tenant_id: targetTenantId, action: 'tenant.impersonate' })
      .orderBy('id', 'desc')
      .first();
    expect(audit).toBeDefined();
    const ctx = typeof audit.context === 'string' ? JSON.parse(audit.context) : audit.context;
    expect(ctx.reason).toContain('dashboard bug #42');
  });

  it("404s a user who belongs to a DIFFERENT tenant — the id must be the target's own", async () => {
    const { id: foreignUserId } = await createUserWithToken({ tenantId: operatorTenantId, role: 'viewer' });
    const agent = await request();
    const res = await agent
      .post(`/api/admin/tenants/${targetTenantId}/impersonate`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ userId: foreignUserId, reason: 'cross-tenant probe' });
    expect(res.status).toBe(404);
  });

  it('400s without a reason — an unexplained support session is the pattern audits exist to prevent', async () => {
    const agent = await request();
    const res = await agent
      .post(`/api/admin/tenants/${targetTenantId}/impersonate`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ userId: targetAdminId });
    expect(res.status).toBe(400);
  });
});
