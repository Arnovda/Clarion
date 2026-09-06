/**
 * /api/policies — the masking and row-filter control's own router.
 *
 * Why this exists (2026-09-06 evaluation, H6): twelve routers had zero
 * tests, and `/api/home` is what that cost — a wrong column name sat in
 * production behind a swallowed catch. This is the most consequential of
 * the twelve: the rows here decide what every other read path hides.
 * `data-policies-everywhere.test.ts` proves the ENGINE applies them; this
 * proves the door that creates them refuses what it should, scopes to the
 * tenant, and tells a user which policies bind them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';

let adminToken: string;
let viewerToken: string;
let viewerId: number;
let analystToken: string;
let tenantId: number;
let otherAdminToken: string;
let policyId: number;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'pol-admin@test.com', companyName: 'PolicyRouterCo' });
  adminToken = admin.token; tenantId = admin.user.tenantId;
  const viewer = await createUserWithToken({ tenantId, role: 'viewer', email: 'pol-viewer@test.com' });
  viewerToken = viewer.token; viewerId = viewer.id;
  analystToken = (await createUserWithToken({ tenantId, role: 'analyst', email: 'pol-analyst@test.com' })).token;
  otherAdminToken = (await registerUser({ email: 'pol-other@test.com', companyName: 'OtherPolicyCo' })).token;
});

afterAll(async () => { await closeTestDb(); });

const post = async (token: string, body: Record<string, unknown>) =>
  (await request()).post('/api/policies').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /api/policies — what it refuses', () => {
  it('creates a row filter for a role', async () => {
    const res = await post(adminToken, {
      name: 'North only', role: 'viewer', table_name: 'customers',
      filter_expression: "region = 'North'", policy_type: 'row_filter',
    });
    expect(res.status).toBe(200);
    policyId = res.body.data.id;
    expect(policyId).toBeGreaterThan(0);
  });

  it('refuses a policy that targets nobody, and one that targets both a user and a role', async () => {
    const neither = await post(adminToken, { name: 'x', table_name: 't', filter_expression: '1=1' });
    expect(neither.status).toBe(400);
    const both = await post(adminToken, {
      name: 'x', table_name: 't', filter_expression: '1=1', role: 'viewer', user_id: viewerId,
    });
    expect(both.status).toBe(400);
  });

  it('refuses a role it cannot bind — an admin bypasses policies, so naming one is a mistake, not a rule', async () => {
    const res = await post(adminToken, {
      name: 'x', role: 'admin', table_name: 't', filter_expression: '1=1',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a column mask with no column', async () => {
    const res = await post(adminToken, {
      name: 'mask', role: 'viewer', table_name: 'customers',
      filter_expression: 'masked', policy_type: 'column_mask',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a filter expression that is not a filter', async () => {
    const res = await post(adminToken, {
      name: 'evil', role: 'viewer', table_name: 'customers',
      filter_expression: "1=1; DROP TABLE customers",
    });
    expect(res.status).toBe(400);
  });

  it('is admin-only: an analyst cannot write the rules that bind them', async () => {
    const res = await post(analystToken, {
      name: 'self-serve', role: 'viewer', table_name: 'customers', filter_expression: '1=1',
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/policies', () => {
  it('lists this tenant\'s policies for an admin, and refuses a viewer', async () => {
    const mine = await (await request()).get('/api/policies').set('Authorization', `Bearer ${adminToken}`);
    expect(mine.status).toBe(200);
    expect((mine.body.data as unknown[]).length).toBe(1);

    const refused = await (await request()).get('/api/policies').set('Authorization', `Bearer ${viewerToken}`);
    expect(refused.status).toBe(403);
  });

  it('never shows another tenant\'s policies', async () => {
    const res = await (await request()).get('/api/policies').set('Authorization', `Bearer ${otherAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /api/policies/mine — what binds me', () => {
  it('gives the viewer the role policy, and the analyst nothing', async () => {
    const v = await (await request()).get('/api/policies/mine').set('Authorization', `Bearer ${viewerToken}`);
    expect(v.status).toBe(200);
    expect((v.body.data as Array<{ name: string }>).map((p) => p.name)).toEqual(['North only']);

    const a = await (await request()).get('/api/policies/mine').set('Authorization', `Bearer ${analystToken}`);
    expect(a.body.data).toEqual([]);
  });

  it('hides a deactivated policy from the user it used to bind', async () => {
    await getTestDb()('data_policies').where({ id: policyId }).update({ is_active: false });
    const v = await (await request()).get('/api/policies/mine').set('Authorization', `Bearer ${viewerToken}`);
    expect(v.body.data).toEqual([]);
    await getTestDb()('data_policies').where({ id: policyId }).update({ is_active: true });
  });
});

describe('PUT / DELETE /api/policies/:id', () => {
  it('refuses to edit or delete another tenant\'s policy', async () => {
    const put = await (await request())
      .put(`/api/policies/${policyId}`).set('Authorization', `Bearer ${otherAdminToken}`)
      .send({ name: 'hijacked', table_name: 'customers', filter_expression: '1=1', role: 'viewer' });
    expect([403, 404]).toContain(put.status);

    const del = await (await request())
      .delete(`/api/policies/${policyId}`).set('Authorization', `Bearer ${otherAdminToken}`);
    expect([403, 404]).toContain(del.status);

    // Still there for its owner.
    const still = await getTestDb()('data_policies').where({ id: policyId }).first();
    expect(still).toBeTruthy();
    expect(still.name).toBe('North only');
  });

  it('deletes its own', async () => {
    const del = await (await request())
      .delete(`/api/policies/${policyId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(await getTestDb()('data_policies').where({ id: policyId }).first()).toBeUndefined();
  });
});
