import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb } from './db-helpers';

let adminToken: string;
let tenantId: number;
let viewerToken: string;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'users-admin@test.com', companyName: 'UsersCo' });
  adminToken = admin.token;
  tenantId = admin.user.tenantId;
  viewerToken = (await createUserWithToken({ tenantId, role: 'viewer' })).token;
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/users', () => {
  it('returns users in tenant for admin', async () => {
    const res = await (await request())
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].email).toBe('users-admin@test.com');
    // Should not expose password hash
    expect(res.body.data[0].password_hash).toBeUndefined();
  });
});

describe('POST /api/users/invite', () => {
  it('invites a new user to the tenant', async () => {
    const res = await (await request())
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'invited@test.com',
        displayName: 'Invited User',
        role: 'analyst',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('invited user appears in user list', async () => {
    const res = await (await request())
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);

    const emails = res.body.data.map((u: { email: string }) => u.email);
    expect(emails).toContain('invited@test.com');
  });

  it('rejects duplicate invite', async () => {
    const res = await (await request())
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'invited@test.com',
        displayName: 'Dupe',
        role: 'viewer',
      });

    expect(res.status).toBe(409);
  });
});
