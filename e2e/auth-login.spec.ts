import { test, expect } from '@playwright/test';

/**
 * Authentication under enforced row-level security.
 *
 * Runs in CI's `rls-isolation` job — the ONE environment where the backend
 * connects as `databridge_app` (NOBYPASSRLS) against a database provisioned
 * purely from migrations. That combination is production's shape, and until
 * 2026-09-01 nothing exercised it end-to-end:
 *
 *   - `e2e/rls.spec.ts` registers tenants and uses the token `/register`
 *     RETURNS — it never calls `/auth/login`.
 *   - `backend/src/tests/auth.test.ts` does test login, but the vitest suite
 *     connects as the `databridge` superuser, so RLS is inert.
 *
 * Between them sat the market-readiness assessment's P0-1: the `auth_lookup`
 * policy that lets an unauthenticated SELECT find a user existed in no
 * migration — only in a hand-run production script. A migration-only database
 * gave `users` just `tenant_isolation`, whose predicate under empty tenant
 * context is `tenant_id = NULL`: zero rows, so login could only 401 and
 * register's duplicate-email check always concluded the address was free.
 * Migration 20260901000088 moved the policy into the schema; this spec is the
 * gate that keeps it there.
 *
 * Every assertion here goes RED against a database without that migration —
 * verified by rolling it back and re-running before it shipped. Do not guard
 * any of them behind conditions (see the note atop rls.spec.ts).
 */

const BACKEND = 'http://localhost:3001/api';
const ts = Date.now();

const CREDS = {
  email: `auth-login-${ts}@test.com`,
  password: 'AuthFlowPass123!',
  companyName: `Auth Flow Corp ${ts}`,
  displayName: 'Auth Flow Admin',
};

test.describe('login under RLS (auth_lookup policy)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${BACKEND}/auth/register`, {
      data: CREDS,
    });
    expect([200, 201], `register failed: ${await res.text()}`).toContain(res.status());
  });

  test('login with correct credentials issues tokens', async ({ request }) => {
    // The P0-1 headline case. Without auth_lookup the user lookup under
    // empty tenant context reads zero rows and this is a 401 with the
    // password being right.
    const res = await request.post(`${BACKEND}/auth/login`, {
      data: { email: CREDS.email, password: CREDS.password },
    });
    expect(res.status(), `login failed: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.data?.token).toBeTruthy();
    expect(body.data?.refreshToken).toBeTruthy();

    // The access token must actually work — an authenticated read proves the
    // token carries a real user, not a fail-open stub.
    const me = await request.get(`${BACKEND}/auth/me`, {
      headers: { Authorization: `Bearer ${body.data.token}` },
    });
    expect(me.status()).toBe(200);
    expect((await me.json()).data?.email).toBe(CREDS.email);
  });

  test('login with a wrong password is refused', async ({ request }) => {
    // The counterweight: if the environment ever regressed to a role that
    // bypasses RLS AND some fail-open shim made the test above pass, this
    // one pins that authentication still discriminates.
    const res = await request.post(`${BACKEND}/auth/login`, {
      data: { email: CREDS.email, password: 'WrongPassword123!' },
    });
    expect(res.status()).toBe(401);
  });

  test('refresh token exchanges for a fresh access token', async ({ request }) => {
    // `refresh_tokens` is in the same five-table auth_lookup set. Without
    // the policy, validateRefreshToken's lookup reads zero rows and every
    // session dies at first access-token expiry.
    const login = await request.post(`${BACKEND}/auth/login`, {
      data: { email: CREDS.email, password: CREDS.password },
    });
    expect(login.status()).toBe(200);
    const { refreshToken } = (await login.json()).data;

    const res = await request.post(`${BACKEND}/auth/refresh`, {
      data: { refreshToken },
    });
    expect(res.status(), `refresh failed: ${await res.text()}`).toBe(200);
    expect((await res.json()).data?.token).toBeTruthy();
  });

  test('registering an already-taken email is refused', async ({ request }) => {
    // Register's duplicate check SELECTs users under empty tenant context.
    // Without auth_lookup it always found nothing, concluded the address was
    // free, and created a second user — after which login's `.first()` is
    // non-deterministic across the duplicates (the assessment's P0-5 defect
    // pair). With the policy this is a clean 409.
    const res = await request.post(`${BACKEND}/auth/register`, {
      data: {
        ...CREDS,
        companyName: `Auth Flow Corp Duplicate ${ts}`,
      },
    });
    expect(res.status(), `expected 409, got: ${await res.text()}`).toBe(409);
  });
});
