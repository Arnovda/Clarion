import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Row-Level Security isolation tests.
 *
 * Each test registers two independent tenants via the API and verifies that
 * resources created by Tenant A are never visible to Tenant B.
 *
 * Requires backend running on port 3001. Runs in CI (test.yml, `rls-isolation`
 * job) against the same Postgres service container the API tests use.
 *
 * A NOTE ON CONDITIONAL ASSERTIONS — do not reintroduce them.
 * Until 2026-08-04 three of the four tests here were dead: they guarded their
 * assertions behind `if (id)` / `if (status === 200)`, and every one of those
 * guards was false. The connections test read `data.id` where the route
 * returns `data.connectionId`, and sent `config.filename` where the SQLite
 * connector reads `config.filepath`; the query-log test called
 * `/definitions/gaps`, which is not a mounted route (it is `/reports/gaps`).
 * All three passed green while asserting nothing. A skipped isolation test is
 * worse than a missing one — it reports safety it never checked. Assert
 * unconditionally, and let a setup failure fail the test.
 */

const BACKEND = 'http://localhost:3001/api';
const ts = Date.now();

/**
 * A source database the backend can genuinely reach — `POST /connections`
 * tests the connection before it stores the row, so an unreachable config
 * never produces a connection to isolate. In CI this is the Postgres service
 * container; locally it is the docker-compose dev database.
 */
const SOURCE_DB = {
  host:     process.env.RLS_SOURCE_PGHOST ?? 'localhost',
  port:     Number(process.env.RLS_SOURCE_PGPORT ?? 5432),
  database: process.env.RLS_SOURCE_PGDATABASE ?? 'databridge_test',
  user:     process.env.RLS_SOURCE_PGUSER ?? 'databridge',
  password: process.env.RLS_SOURCE_PGPASSWORD ?? 'databridge',
};

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

    // ...and Tenant A must still see their own. Asserting only the refusal
    // would let a gate that denies everybody pass this whole file.
    const ownRes = await authedGet(request, tokenA, `/dashboards/${dashboardId}`);
    expect(ownRes.status()).toBe(200);
  });

  test('connections: Tenant B cannot see connections created by Tenant A', async ({ request }) => {
    // Connections are the most sensitive tenant-owned row in the schema — they
    // carry AES-encrypted source credentials — so this is the isolation
    // assertion worth having.
    const createRes = await authedPost(request, tokenA, '/connections', {
      name: `Private Connection ${ts}`,
      type: 'postgres',
      config: SOURCE_DB,
    });
    expect(
      createRes.status(),
      `connection setup failed: ${await createRes.text()}`,
    ).toBe(201);

    const created = await createRes.json();
    const connId: number = created.data?.connectionId;
    expect(connId).toBeTruthy();

    // Tenant B listing connections must not include Tenant A's connection
    const listRes = await authedGet(request, tokenB, '/connections');
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    const ids: number[] = (list.data ?? []).map((c: { id: number }) => c.id);
    expect(ids).not.toContain(connId);

    // Tenant B directly fetching Tenant A's connection must be refused
    const fetchRes = await authedGet(request, tokenB, `/connections/${connId}`);
    expect([403, 404]).toContain(fetchRes.status());

    // ...and Tenant A must still see their own — a gate that refuses everyone
    // would pass every assertion above while breaking the product.
    const ownRes = await authedGet(request, tokenA, `/connections/${connId}`);
    expect(ownRes.status()).toBe(200);
  });

  test('definition gaps: neither tenant sees the other\'s rows', async ({ request }) => {
    // The route is /reports/gaps (admin-only; both registrants are the admin
    // of their own tenant). Gaps are written by low-confidence queries, which
    // need a live AI call — so on a fresh CI database both sets are usually
    // empty and this is a weaker check than the two above. It still catches
    // the regression that matters: a gaps query that forgets its tenant
    // predicate and returns the whole table.
    const resA = await authedGet(request, tokenA, '/reports/gaps?limit=100');
    const resB = await authedGet(request, tokenB, '/reports/gaps?limit=100');

    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    const gapsA = await resA.json();
    const gapsB = await resB.json();

    const idsA = new Set<number>((gapsA.data ?? []).map((g: { id: number }) => g.id));
    const idsB = new Set<number>((gapsB.data ?? []).map((g: { id: number }) => g.id));

    const overlap = [...idsA].filter((id) => idsB.has(id));
    expect(overlap).toHaveLength(0);
  });

  test('notifications: Tenant B receives no notifications from Tenant A', async ({ request }) => {
    const resA = await authedGet(request, tokenA, '/notifications');
    const resB = await authedGet(request, tokenB, '/notifications');

    expect(resA.status()).toBe(200);
    expect(resB.status()).toBe(200);

    const notifsA = await resA.json();
    const notifsB = await resB.json();

    const idsA = new Set<number>((notifsA.data ?? []).map((n: { id: number }) => n.id));
    const idsB = new Set<number>((notifsB.data ?? []).map((n: { id: number }) => n.id));

    // No notification ID should appear in both tenants' results
    const overlap = [...idsA].filter((id) => idsB.has(id));
    expect(overlap).toHaveLength(0);
  });
});
