/**
 * 2-4 / 4-4 — auth events are in the audit trail, the trail has a
 * retention rule, and it can be exported.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { runRetentionSweep, RETENTION_RULES, retentionDays } from '../services/retention';

let tenantId: number;
let adminToken: string;
let email: string;
const password = 'TestPassword123!';

beforeAll(async () => {
  await cleanTestDb();
  email = `audit-${Date.now()}@test.com`;
  const t = await registerUser({ email, companyName: 'AuditCo', password });
  tenantId = t.user.tenantId; adminToken = t.token;
});

afterAll(async () => { await closeTestDb(); });

const events = (action: string) => getTestDb()('audit_events').where({ tenant_id: tenantId, action }).orderBy('id', 'desc');

describe('auth events land in the tenant trail (2-4)', () => {
  it('register, wrong password, success, logout, forgot — each a row with ip and email', async () => {
    const reg = await events('user.register').first();
    expect(reg).toBeDefined();
    expect(reg.actor_email).toBe(email);

    const agent = await request();
    const bad = await agent.post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    const fail = await events('login.fail').first();
    expect(fail).toBeDefined();
    expect(fail.ip).toBe('203.0.113.9');
    expect(fail.actor_email).toBe(email);
    const ctx = typeof fail.context === 'string' ? JSON.parse(fail.context) : fail.context;
    expect(ctx.reason).toBe('bad_password');

    // An unknown email writes nothing anywhere (no tenant to write to).
    const unknown = await agent.post('/api/auth/login').send({ email: 'nobody@nowhere.test', password });
    expect(unknown.status).toBe(401);

    const ok = await agent.post('/api/auth/login').send({ email, password });
    expect(ok.status).toBe(200);
    const success = await events('login.success').first();
    expect(success).toBeDefined();
    expect(success.actor_user_id).toBeTruthy();

    const out = await agent.post('/api/auth/logout').send({ refreshToken: ok.body.data.refreshToken });
    expect(out.status).toBe(200);
    expect(await events('session.logout').first()).toBeDefined();

    const forgot = await agent.post('/api/auth/forgot-password').send({ email });
    expect(forgot.status).toBe(200);
    expect(await events('password.forgot_requested').first()).toBeDefined();
  });
});

describe('the trail is exportable and bounded (4-4)', () => {
  it('admins export CSV (and the export is recorded); viewers cannot; the retention rule exists', async () => {
    const agent = await request();
    const res = await agent.get('/api/users/audit/export.csv?action=login').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = (res.text as string).trim().split('\r\n');
    expect(lines[0]).toBe('id,at,action,actor_email,actor_role,actor_name,entity_type,entity_id,ip,user_agent,context');
    expect(lines.length).toBeGreaterThanOrEqual(3); // login.fail + login.success at least
    expect(lines.every((l, i) => i === 0 || l.includes(',login.'))).toBe(true);
    expect(await events('audit.export').first()).toBeDefined();

    const bad = await agent.get('/api/users/audit/export.csv?since=yesterday').set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    const { token: viewer } = await createUserWithToken({ tenantId, role: 'viewer' });
    const refused = await agent.get('/api/users/audit/export.csv').set('Authorization', `Bearer ${viewer}`);
    expect(refused.status).toBe(403);

    const rule = RETENTION_RULES.find((r) => r.table === 'audit_events')!;
    expect(rule).toBeDefined();
    expect(retentionDays(rule)).toBe(730);
    // An old row is pruned, a fresh one kept.
    const db = getTestDb();
    await db('audit_events').insert({ tenant_id: tenantId, action: 'test.old', created_at: new Date(Date.now() - 800 * 86_400_000) });
    const deleted = await runRetentionSweep(db, [rule]);
    expect(deleted.audit_events).toBeGreaterThanOrEqual(1);
    expect(await events('test.old').first()).toBeUndefined();
    expect(await events('login.success').first()).toBeDefined();
  });
});
