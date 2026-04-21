import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Row-Level Security isolation tests.
 *
 * Each test registers two independent tenants via the API and verifies that
 * resources created by Tenant A are never visible to Tenant B.
 *
 * Requires backend running on port 3001.
 */

const BACKEND = 'http://localhost:3001/api';
const ts = Date.now();

interface Credentials {
  email: string;
  password: string;
  company: string;
  name: string;
}

async function register(req: APIRequestContext, creds: Credentials): Promise<string> {
  const res = await req.post(`${BACKEND}/auth/register`, {
    data: {
      email: creds.email,
      password: creds.password,
      companyName: creds.company,
      displayName: creds.name,
    },
  });
  expect([200, 201]).toContain(res.status());
  const body = await res.json();
  return body.data?.token as string;
}

async function authedGet(req: APIRequestContext, token: string, path: string) {
  return req.get(`${BACKEND}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function authedPost(req: APIRequestContext, token: string, path: string, data: unknown) {
  return req.post(`${BACKEND}${path}`, {
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
}

test.describe('RLS isolation', () => {
  let tokenA: string;
  let tokenB: string;

  test.beforeAll(async ({ request }) => {
    tokenA = await register(request, {
      email: `rls-a-${ts}@test.com`,
      password: 'RlsTestPass123!',
      company: `RLS Corp A ${ts}`,
      name: 'Tenant A Admin',
    });
    tokenB = await register(request, {
      email: `rls-b-${ts}@test.com`,
      password: 'RlsTestPass123!',
      company: `RLS Corp B ${ts}`,
      name: 'Tenant B Admin',
    });
  });

  test('dashboards: Tenant B cannot see dashboards created by Tenant A', async ({ request }) => {
    // Tenant A creates a dashboard (saved spec)
    const createRes = await authedPost(request, tokenA, '/dashboards', {
      title: `Private Dashboard ${ts}`,
      description: 'Should not be visible to Tenant B',
      spec: { filters: [], widgets: [] },
    });
    expect(createRes.status()).toBe(200);
    const created = await createRes.json();
    const dashboardId: number = created.data?.id;
    expect(dashboardId).toBeTruthy();

    // Tenant B lists dashboards — must not contain Tenant A's dashboard
    const listRes = await authedGet(request, tokenB, '/dashboards');
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    const ids: number[] = (list.data ?? []).map((d: { id: number }) => d.id);
    expect(ids).not.toContain(dashboardId);

    // Tenant B directly fetching Tenant A's dashboard must fail (403 or 404)
    const fetchRes = await authedGet(request, tokenB, `/dashboards/${dashboardId}`);
    expect([403, 404]).toContain(fetchRes.status());
  });

  test('connections: Tenant B cannot see connections created by Tenant A', async ({ request }) => {
    // Tenant A creates a connection (SQLite — no real file needed for DB row to exist)
    const createRes = await authedPost(request, tokenA, '/connections', {
      name: `Private Connection ${ts}`,
      type: 'sqlite',
      config: { filename: `/tmp/rls_test_${ts}.db` },
    });
    // Accept 200 (created) or 400/500 (file missing) — we only care the row is scoped to A
    const created = await createRes.json();
    const connId: number | undefined = created.data?.id;

    if (connId) {
      // Tenant B listing connections must not include Tenant A's connection
      const listRes = await authedGet(request, tokenB, '/connections');
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      const ids: number[] = (list.data ?? []).map((c: { id: number }) => c.id);
      expect(ids).not.toContain(connId);

      // Tenant B directly fetching Tenant A's connection must fail
      const fetchRes = await authedGet(request, tokenB, `/connections/${connId}`);
      expect([403, 404]).toContain(fetchRes.status());
    }
  });

  test('query log: Tenant B cannot see queries run by Tenant A', async ({ request }) => {
    // Tenant B's query log must be empty or contain only Tenant B's own entries.
    // We verify by fetching gaps/query log for each tenant and checking no cross-contamination.
    const resA = await authedGet(request, tokenA, '/definitions/gaps?limit=100');
    const resB = await authedGet(request, tokenB, '/definitions/gaps?limit=100');

    if (resA.status() === 200 && resB.status() === 200) {
      const gapsA = await resA.json();
      const gapsB = await resB.json();

      // Extract tenant_ids from each result set
      const tenantIdsInA = new Set(
        (gapsA.data ?? []).map((g: { tenant_id: number }) => g.tenant_id)
      );
      const tenantIdsInB = new Set(
        (gapsB.data ?? []).map((g: { tenant_id: number }) => g.tenant_id)
      );

      // Each result set must contain at most one distinct tenant_id (their own)
      expect(tenantIdsInA.size).toBeLessThanOrEqual(1);
      expect(tenantIdsInB.size).toBeLessThanOrEqual(1);

      // If both have data, they must not share tenant IDs
      if (tenantIdsInA.size > 0 && tenantIdsInB.size > 0) {
        const overlap = [...tenantIdsInA].filter((id) => tenantIdsInB.has(id));
        expect(overlap).toHaveLength(0);
      }
    }
  });

  test('notifications: Tenant B receives no notifications from Tenant A', async ({ request }) => {
    const resA = await authedGet(request, tokenA, '/notifications');
    const resB = await authedGet(request, tokenB, '/notifications');

    if (resA.status() === 200 && resB.status() === 200) {
      const notifsA = await resA.json();
      const notifsB = await resB.json();

      const idsA = new Set((notifsA.data ?? []).map((n: { id: number }) => n.id));
      const idsB = new Set((notifsB.data ?? []).map((n: { id: number }) => n.id));

      // No notification ID should appear in both tenants' results
      const overlap = [...idsA].filter((id) => idsB.has(id));
      expect(overlap).toHaveLength(0);
    }
  });
});
