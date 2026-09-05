/**
 * Wave A "small items" of the 2026-09-05 market-readiness assessment (v2):
 *   2-1  PATCH /users/profile was dead — shadowed by PATCH /users/:id.
 *   2-2  A 15-minute impersonation session could mint a 180-day API token,
 *        change the password, re-enrol MFA or close the account: the
 *        `impersonatedBy` claim was written and read nowhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { signImpersonationToken } from '../middleware/auth';

let adminToken: string;
let tenantId: number;
let viewerToken: string;
let viewerId: number;
let supportToken: string;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@small.test', companyName: 'SmallCo' });
  adminToken = admin.token; tenantId = admin.user.tenantId;
  const viewer = await createUserWithToken({ tenantId, role: 'viewer', email: 'viewer@small.test' });
  viewerToken = viewer.token; viewerId = viewer.id;
  // The token the operator console mints: the customer's admin identity,
  // 15 minutes, `impersonatedBy` naming the operator.
  supportToken = signImpersonationToken({
    sub: admin.user.id, tenantId, email: admin.user.email, displayName: 'Admin', role: 'admin',
    impersonatedBy: 'operator@clarion.test',
  });
});

afterAll(async () => { await closeTestDb(); });

describe('2-1 own-profile routes are reachable by every role', () => {
  it('a viewer can change their display name (was 403 — matched as PATCH /:id)', async () => {
    const res = await (await request()).patch('/api/users/profile').set('Authorization', `Bearer ${viewerToken}`).send({ displayName: 'Vera Viewer' });
    expect(res.status).toBe(200);
    const row = await getTestDb()('users').where({ id: viewerId }).first();
    expect(row.display_name).toBe('Vera Viewer');
  });

  it('an admin can too (was 500 — Number("profile") is NaN)', async () => {
    const res = await (await request()).patch('/api/users/profile').set('Authorization', `Bearer ${adminToken}`).send({ displayName: 'Ada Admin' });
    expect(res.status).toBe(200);
  });

  it('GET /users/profile still answers and PATCH /users/:id still works for a real id', async () => {
    const me = await (await request()).get('/api/users/profile').set('Authorization', `Bearer ${viewerToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.display_name).toBe('Vera Viewer');
    const byId = await (await request()).patch(`/api/users/${viewerId}`).set('Authorization', `Bearer ${adminToken}`).send({ displayName: 'Vera V.' });
    expect(byId.status).toBe(200);
  });
});

describe('2-2 a support session cannot mint tokens, change credentials or close the account', () => {
  const asSupport = async (method: 'post' | 'delete', url: string, body?: unknown) =>
    (await request())[method](url).set('Authorization', `Bearer ${supportToken}`).send(body);

  it('the support token itself is accepted for ordinary reads', async () => {
    const res = await (await request()).get('/api/users/profile').set('Authorization', `Bearer ${supportToken}`);
    expect(res.status).toBe(200);
  });

  it('refuses API-token creation and revocation', async () => {
    const create = await asSupport('post', '/api/api-tokens', { name: 'excel' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('support_session');
    expect(await getTestDb()('api_tokens').where({ tenant_id: tenantId })).toHaveLength(0);
    const revoke = await asSupport('delete', '/api/api-tokens/1');
    expect(revoke.status).toBe(403);
  });

  it('refuses a password change, MFA changes, passkey enrolment and account closure', async () => {
    for (const [method, url, body] of [
      ['post', '/api/users/profile/password', { currentPassword: 'x', newPassword: 'NewPassword123!' }],
      ['post', '/api/auth/mfa/setup', {}],
      ['post', '/api/auth/mfa/enable', { code: '000000' }],
      ['post', '/api/auth/mfa/disable', { code: '000000' }],
      ['post', '/api/auth/mfa/regenerate-backup-codes', {}],
      ['post', '/api/auth/webauthn/register-options', {}],
      ['post', '/api/auth/webauthn/register-verify', {}],
      ['delete', '/api/auth/webauthn/credentials/1', undefined],
      ['post', '/api/settings/delete-tenant', { confirmName: 'SmallCo' }],
    ] as const) {
      const res = await asSupport(method, url, body);
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(403);
      expect(res.body.code, url).toBe('support_session');
    }
    expect(await getTestDb()('tenants').where({ id: tenantId })).toHaveLength(1);
  });

  it('the real admin, not impersonated, can still mint a token', async () => {
    const res = await (await request()).post('/api/api-tokens').set('Authorization', `Bearer ${adminToken}`).send({ name: 'excel' });
    expect(res.status).toBe(201);
  });
});
