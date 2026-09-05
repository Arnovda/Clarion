import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Schedules under the PRODUCTION ROLE (assessment 10-2, the P0-2 lesson).
 *
 * This spec runs only in the `rls-isolation` job, where the backend connects
 * as `databridge_app` (NOBYPASSRLS) against a migration-only database — the
 * one place a request that writes and reads an RLS-forced table proves the
 * policies, grants AND the tenant context are right end to end. The schedule
 * loaders themselves are pinned as the app role in
 * backend/src/tests/schedule-loaders-rls.test.ts; this is the request-path
 * half: a customer setting a schedule, reading it back, and a second tenant
 * not seeing it.
 */

import { buildXlsxFixture } from '../packages/connectors/src/spreadsheet/__fixtures__/xlsxFixture';

const BACKEND = process.env.RLS_BACKEND_URL ?? 'http://localhost:3001/api';
const ts = Date.now();

// Sync schedules exist only for SOURCE-CONNECTOR connections (the Postgres
// connection rls.spec uses is a direct-DB one and is refused with 400). The
// Excel connector needs no network and no credentials: a real two-row
// workbook, built by the connectors package's own fixture builder, is the
// whole config.
function excelSource() {
  const bytes = buildXlsxFixture([{ name: 'Budget', rows: [['Month', 'Amount'], ['2026-01', 100], ['2026-02', 120]] }]);
  return {
    name: `Sched source ${ts}`,
    connectorType: 'excel',
    config: { filename: 'budget.xlsx', fileContent: Buffer.from(bytes).toString('base64') },
    selectedEntities: ['Budget'],
  };
}

async function register(req: APIRequestContext, label: string): Promise<string> {
  const res = await req.post(`${BACKEND}/auth/register`, {
    data: {
      email: `sched-${label}-${ts}@test.com`,
      password: 'SchedTestPass123!',
      companyName: `Sched Corp ${label} ${ts}`,
      displayName: `Tenant ${label} Admin`,
    },
  });
  expect(res.status(), `register ${label}: ${await res.text()}`).toBe(201);
  return (await res.json()).data.token as string;
}

const authed = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

test.describe('Schedules under databridge_app', () => {
  let tokenA: string;
  let tokenB: string;
  let connectionId: number;

  test.beforeAll(async ({ request }) => {
    tokenA = await register(request, 'a');
    tokenB = await register(request, 'b');
    const created = await request.post(`${BACKEND}/connections/source`, {
      data: excelSource(),
      ...authed(tokenA),
    });
    expect(created.status(), `connection setup failed: ${await created.text()}`).toBe(201);
    connectionId = (await created.json()).data.connectionId;
    expect(connectionId).toBeTruthy();
  });

  test('a tenant can set a sync schedule and read it back; another tenant cannot see it', async ({ request }) => {
    const put = await request.put(`${BACKEND}/connections/${connectionId}/sync-schedule`, {
      data: { cronExpression: '0 6 * * *', timezone: 'UTC', enabled: true },
      ...authed(tokenA),
    });
    expect(put.status(), await put.text()).toBe(200);

    const get = await request.get(`${BACKEND}/connections/${connectionId}/sync-schedule`, authed(tokenA));
    expect(get.status()).toBe(200);
    const body = await get.json();
    expect(body.data?.cron_expression ?? body.data?.cronExpression).toBe('0 6 * * *');

    // The other tenant: the connection does not exist for them (404, never 403).
    const other = await request.get(`${BACKEND}/connections/${connectionId}/sync-schedule`, authed(tokenB));
    expect([404, 400]).toContain(other.status());
  });

  test('the run history of a fresh connection is an empty list, not an error', async ({ request }) => {
    const runs = await request.get(`${BACKEND}/connections/${connectionId}/sync-runs?limit=5`, authed(tokenA));
    expect(runs.status()).toBe(200);
    expect((await runs.json()).data).toEqual([]);
  });
});
