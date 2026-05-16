/**
 * Unit tests for ExactOnlineConnector. All HTTP is mocked with nock —
 * no real network calls. Covers:
 *   • testConnection — happy path + auth failure
 *   • listEntities  — returns curated catalog
 *   • sync          — token rotation, pagination, OData cleanup, warehouse writes
 *   • cancellation  — sync aborts cleanly between pages
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Database } from 'duckdb-async';

import { ExactOnlineConnector } from './ExactOnlineConnector';
import { LocalFileWarehouseWriter } from '../ParquetWriter';
import { createNoopLogger } from '../logging';
import { createCancellationToken } from '../BaseSourceConnector';
import type { ConnectorConfig, SyncContext } from '../types';

const BASE_URL = 'https://start.exactonline.nl';
const DIVISION = '12345';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    clientId: 'cid',
    clientSecret: 'csec',
    refreshToken: 'rtok-original',
    division: DIVISION,
    baseUrl: BASE_URL,
    ...overrides,
  };
}

function mockTokenRefresh(opts: { newRefreshToken?: string } = {}) {
  return nock(BASE_URL)
    .post('/api/oauth2/token', /grant_type=refresh_token/)
    .reply(200, {
      access_token: 'access-12345',
      refresh_token: opts.newRefreshToken ?? 'rtok-rotated',
      expires_in: 600,
      token_type: 'bearer',
    });
}

beforeEach(() => {
  nock.disableNetConnect();
  // Keep retry-related tests fast. The HttpClient honours an env-var
  // backoff cap when set; this collapses the production 30s cap to
  // 10ms so a 10-retry budget runs in well under a second of wall
  // clock instead of 2.5 minutes.
  process.env.HTTP_CLIENT_BACKOFF_CAP_MS = '10';
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.HTTP_CLIENT_BACKOFF_CAP_MS;
});

describe('ExactOnlineConnector — testConnection', () => {
  it('returns ok=true when refresh + /Me both succeed', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/system/Me`)
      .matchHeader('authorization', 'Bearer access-12345')
      .reply(200, {
        d: { results: [{ UserName: 'arno@example.com', CurrentDivision: DIVISION }] },
      });

    const c = new ExactOnlineConnector();
    const result = await c.testConnection(makeConfig(), { log: createNoopLogger(), onCredentialRotated: async () => {} });

    expect(result.ok).toBe(true);
    expect(result.details?.user).toBe('arno@example.com');
    expect(result.details?.division).toBe(DIVISION);
  });

  it('returns ok=false with a user-facing error on auth failure', async () => {
    nock(BASE_URL)
      .post('/api/oauth2/token')
      .reply(400, { error: 'invalid_grant' });

    const c = new ExactOnlineConnector();
    const result = await c.testConnection(makeConfig(), { log: createNoopLogger() });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Token refresh failed/i);
    expect(result.error).toMatch(/HTTP 400/);
  });

  it('rejects an invalid config before any network call', async () => {
    const c = new ExactOnlineConnector();
    await expect(
      c.testConnection({ clientId: 'cid' /* missing fields */ } as ConnectorConfig, {
        log: createNoopLogger(),
      }),
    ).rejects.toThrow(/Config validation failed/);
    // No nock mocks set — if any HTTP fired, nock would error out.
  });

  it('refuses to refresh tokens if no onCredentialRotated handler is wired', async () => {
    // Regression: prior behaviour silently dropped the rotated refresh_token
    // when the caller didn't provide a persistence callback. The next sync
    // then tried the now-invalidated stored token and EO 401'd with
    // "Old refresh token used". This guard makes the failure surface
    // immediately in development instead.
    mockTokenRefresh(); // would issue a new refresh_token if we let it
    const c = new ExactOnlineConnector();
    const result = await c.testConnection(makeConfig(), { log: createNoopLogger() });
    // testConnection catches AuthRefreshError + returns ok:false rather than throwing.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/onCredentialRotated/);
  });
});

describe('ExactOnlineConnector — listEntities', () => {
  it('returns the curated catalog without making any HTTP calls', async () => {
    const c = new ExactOnlineConnector();
    const entities = await c.listEntities(makeConfig(), { log: createNoopLogger() });
    // Catalog was expanded from 8 → ~55 entities (verified May 2026
    // against EO's REST API docs). Floor is 40 to catch accidental
    // deletes without being brittle to additions.
    expect(entities.length).toBeGreaterThanOrEqual(40);
    expect(entities.find((e) => e.name === 'Accounts')).toBeDefined();
    expect(entities.find((e) => e.name === 'TransactionLines')).toBeDefined();
    // No nock mocks set — any HTTP would error.
  });

  it('every entity has the fields the wizard needs', async () => {
    const c = new ExactOnlineConnector();
    const entities = await c.listEntities(makeConfig(), { log: createNoopLogger() });
    for (const e of entities) {
      expect(e.name).toMatch(/^[A-Z][A-Za-z0-9]+$/);  // PascalCase, no spaces
      expect(e.displayName).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(e.category).toBeTruthy();
      expect(typeof e.supportsIncremental).toBe('boolean');
    }
  });

  it('exposes every documented category', async () => {
    const c = new ExactOnlineConnector();
    const entities = await c.listEntities(makeConfig(), { log: createNoopLogger() });
    const categories = new Set(entities.map((e) => e.category));
    // Every category the wizard groups by should be represented. Keeping
    // the expected list explicit so accidentally dropping a whole
    // category from the catalog fails this assertion.
    for (const expected of [
      'CRM', 'Sales', 'Purchase', 'Logistics', 'Inventory',
      'Financial', 'Cashflow', 'HRM', 'Project', 'Subscription', 'System',
    ]) {
      expect(categories.has(expected)).toBe(true);
    }
  });

  it('entity names are unique', async () => {
    const c = new ExactOnlineConnector();
    const entities = await c.listEntities(makeConfig(), { log: createNoopLogger() });
    const names = entities.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('ExactOnlineConnector — sync', () => {
  // Each test gets its own warehouse dir.
  const warehouses: string[] = [];
  async function makeWarehouse(): Promise<string> {
    const root = path.join(os.tmpdir(), `eo-test-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    warehouses.push(root);
    return root;
  }
  afterEach(async () => {
    while (warehouses.length > 0) {
      const root = warehouses.pop()!;
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function makeCtx(warehouseRoot: string): SyncContext & { rotated: ConnectorConfig | null } {
    const writer = new LocalFileWarehouseWriter(warehouseRoot);
    const cancellation = createCancellationToken();
    let rotated: ConnectorConfig | null = null;
    return {
      tenantId: 't1',
      connectionId: 'c42',
      warehouseWriter: writer,
      log: createNoopLogger(),
      progress: vi.fn(),
      cancellationToken: cancellation,
      onCredentialRotated: async (newConfig) => {
        rotated = newConfig;
      },
      get rotated() { return rotated; },
    } as SyncContext & { rotated: ConnectorConfig | null };
  }

  it('refreshes token, paginates an entity, persists rotation, writes Parquet', async () => {
    mockTokenRefresh({ newRefreshToken: 'rtok-FRESH' });

    // Two-page response for Accounts. The connector now declares Accounts
    // as incrementally syncable, which means it appends
    // `?$orderby=Modified asc` to the initial URL. We match query params
    // loosely so nock accepts the new shape.
    nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
      .query(true)
      .matchHeader('authorization', 'Bearer access-12345')
      .reply(200, {
        d: {
          results: [
            { __metadata: { uri: 'foo' }, ID: 'a1', Name: '  Acme NV  ' },
            { ID: 'a2', Name: 'Globex', Created: '/Date(1700000000000)/' },
          ],
          __next: `${BASE_URL}/api/v1/${DIVISION}/crm/Accounts?$skiptoken=2`,
        },
      });
    nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
      .query({ $skiptoken: '2' })
      .reply(200, {
        d: {
          results: [
            { ID: 'a3', Name: 'Initech', Linked: { __deferred: { uri: 'noise' } } },
          ],
        },
      });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);

    const c = new ExactOnlineConnector();
    const result = await c.sync(makeConfig(), { entities: ['Accounts'] }, ctx);

    expect(result.rowCounts).toEqual({ Accounts: 3 });
    expect(result.warnings).toEqual([]);

    // Token rotation persisted before any data fetching.
    expect(ctx.rotated).toBeTruthy();
    expect(ctx.rotated?.refreshToken).toBe('rtok-FRESH');

    // Verify Parquet contents — clean values, no __metadata, no __deferred.
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'Accounts', 'data.parquet').replace(/'/g, "''");
      const rows = await db.all(`SELECT * FROM read_parquet('${p}') ORDER BY ID`);
      expect(rows).toHaveLength(3);
      expect(rows[0].Name).toBe('Acme NV'); // trimmed
      // /Date(...)/ was converted to ISO string
      expect(typeof rows[1].Created).toBe('string');
      expect(rows[1].Created).toMatch(/^20\d\d-/);
      // __metadata + __deferred dropped
      expect(rows[0].__metadata).toBeUndefined();
      expect(rows[2].Linked).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it('appends $filter when an incremental cursor is provided', async () => {
    mockTokenRefresh();
    // We pass a prior cursor for Accounts. The connector should append
    // `$filter=Modified gt datetime'...'` to the request URL — that's the
    // entire point of incremental sync.
    const filterMock = nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
      .query((q) => typeof q.$filter === 'string' && q.$filter.includes("Modified gt datetime'2026-01-01T00:00:00'"))
      .reply(200, { d: { results: [{ ID: 'a1', Modified: '2026-02-01T10:00:00' }] } });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);

    const c = new ExactOnlineConnector();
    const result = await c.sync(
      makeConfig(),
      {
        entities: ['Accounts'],
        cursors: { Accounts: { type: 'timestamp', value: '2026-01-01T00:00:00' } },
      },
      ctx,
    );

    expect(result.rowCounts).toEqual({ Accounts: 1 });
    expect(filterMock.isDone()).toBe(true);
    // The connector also reports the new cursor it observed.
    expect(result.cursors).toEqual({ Accounts: { type: 'timestamp', value: '2026-02-01T10:00:00' } });
  });

  it('warns on unknown entity names and skips them', async () => {
    mockTokenRefresh();
    nock(BASE_URL).get(`/api/v1/${DIVISION}/crm/Accounts`).query(true).reply(200, { d: [] });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);
    const c = new ExactOnlineConnector();

    const result = await c.sync(
      makeConfig(),
      { entities: ['Accounts', 'NotAnEntity'] },
      ctx,
    );

    expect(result.rowCounts).toEqual({ Accounts: 0 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Unknown entity 'NotAnEntity'/)]),
    );
  });

  it('aborts cleanly when cancellation is requested between pages', async () => {
    mockTokenRefresh();
    nock(BASE_URL).get(`/api/v1/${DIVISION}/crm/Accounts`).query(true).reply(200, {
      d: {
        results: [{ ID: 'a1' }],
        __next: `${BASE_URL}/api/v1/${DIVISION}/crm/Accounts?$skiptoken=2`,
      },
    });
    // Second page mock — but we expect cancellation BEFORE this is hit.
    const secondPage = nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
      .query({ $skiptoken: '2' })
      .reply(200, { d: { results: [{ ID: 'a2' }] } });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);

    // Cancel after the first page is processed.
    const cancellation = ctx.cancellationToken as ReturnType<typeof createCancellationToken>;
    (ctx.progress as ReturnType<typeof vi.fn>).mockImplementation((msg) => {
      if (typeof msg === 'object' && msg.message?.includes('page 1')) {
        cancellation.cancel();
      }
    });

    const c = new ExactOnlineConnector();
    await expect(c.sync(makeConfig(), { entities: ['Accounts'] }, ctx)).rejects.toThrow(/cancelled/i);
    // The second-page request should never have fired.
    expect(secondPage.isDone()).toBe(false);
  });

  it('records HTTP 5xx as a per-entity warning and continues', async () => {
    mockTokenRefresh();
    // Persist 500s for every retry — connector's maxRetries=10, so we
    // need at least 11 attempts to exhaust the budget. .persist() means
    // nock matches indefinitely; whichever attempt count the connector
    // settles on, we don't have to keep this in sync.
    nock(BASE_URL)
      .persist()
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
      .query(true)
      .reply(500, { error: 'server fire' });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);
    const c = new ExactOnlineConnector();

    const result = await c.sync(makeConfig(), { entities: ['Accounts'] }, ctx);
    expect(result.rowCounts).toEqual({ Accounts: 0 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Entity 'Accounts' failed.*HTTP 500/)]),
    );
    // Failed entity → no new cursor emitted, so next sync resumes from
    // wherever the prior cursor was (or full sync on first try).
    expect(result.cursors?.Accounts).toBeUndefined();
  }, 30_000);

  it('tracks the highest Modified value across pages as the new cursor', async () => {
    mockTokenRefresh();
    // Two pages, three rows, with Modified out of order so we exercise
    // the "max across all rows" logic, not "last row wins".
    nock(BASE_URL).get(`/api/v1/${DIVISION}/crm/Accounts`).query(true).reply(200, {
      d: {
        results: [
          { ID: 'a1', Modified: '2026-03-15T08:00:00' },
          { ID: 'a2', Modified: '2026-05-01T14:30:00' }, // MAX
        ],
        __next: `${BASE_URL}/api/v1/${DIVISION}/crm/Accounts?$skiptoken=2`,
      },
    });
    nock(BASE_URL).get(`/api/v1/${DIVISION}/crm/Accounts`).query({ $skiptoken: '2' }).reply(200, {
      d: { results: [{ ID: 'a3', Modified: '2026-04-20T00:00:00' }] },
    });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);
    const c = new ExactOnlineConnector();

    const result = await c.sync(makeConfig(), { entities: ['Accounts'] }, ctx);
    expect(result.rowCounts).toEqual({ Accounts: 3 });
    expect(result.cursors).toEqual({
      Accounts: { type: 'timestamp', value: '2026-05-01T14:30:00' },
    });
  });

  it('non-incremental entities (e.g. AccountClassificationNames) emit no cursor', async () => {
    mockTokenRefresh();
    nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/AccountClassificationNames`)
      .reply(200, { d: { results: [{ ID: 'c1', Description: 'Segment A' }] } });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);
    const c = new ExactOnlineConnector();

    const result = await c.sync(makeConfig(), { entities: ['AccountClassificationNames'] }, ctx);
    expect(result.rowCounts).toEqual({ AccountClassificationNames: 1 });
    expect(result.cursors).toEqual({}); // no cursor for non-incremental entities
  });
});

describe('ExactOnlineConnector — probeEntities', () => {
  // probeEntities uses fetch() directly rather than nock-routable HttpClient,
  // so we stub global fetch for these tests. Each entity gets exactly one
  // call (the probe is bounded to one request per entity); the test sets
  // up a per-URL response map and asserts the categorisation logic.

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(responses: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>) {
    globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
      const s = typeof url === 'string' ? url : url.toString();
      // Strip query string; we match on the path-only key for readability.
      const noQuery = s.split('?')[0];
      const matched = responses[noQuery];
      if (!matched) {
        return new Response(JSON.stringify({ error: 'no mock' }), { status: 599 });
      }
      const body = matched.body === undefined ? '' : (typeof matched.body === 'string' ? matched.body : JSON.stringify(matched.body));
      return new Response(body, {
        status: matched.status,
        headers: { 'content-type': 'application/json', ...(matched.headers ?? {}) },
      });
    }) as typeof globalThis.fetch;
  }

  it('categorises 200 / 403 / 404 correctly', async () => {
    mockTokenRefresh();
    const root = `${BASE_URL}/api/v1/${DIVISION}`;
    stubFetch({
      [`${root}/crm/Accounts`]:                 { status: 200, body: { d: { results: [{ ID: 'a1' }] } } },
      [`${root}/payroll/Employees`]:            { status: 403, body: { error: { message: 'Forbidden' } } },
      [`${root}/logistics/SupplierItems`]:      { status: 404, body: { error: { message: 'Not found' } } },
    });

    const c = new ExactOnlineConnector();
    const results = await c.probeEntities(makeConfig(), { log: createNoopLogger(), onCredentialRotated: async () => {} });

    const accounts = results.find((r) => r.name === 'Accounts');
    const employees = results.find((r) => r.name === 'Employees');
    const supplierItems = results.find((r) => r.name === 'SupplierItems');

    expect(accounts).toMatchObject({ name: 'Accounts', state: 'available', rowCountSample: 1, httpStatus: 200 });
    expect(employees).toMatchObject({ name: 'Employees', state: 'forbidden', httpStatus: 403 });
    expect(employees!.reason).toContain('Module not licensed');
    expect(supplierItems).toMatchObject({ name: 'SupplierItems', state: 'not_found', httpStatus: 404 });
  });

  it('returns one result per catalogued entity', async () => {
    mockTokenRefresh();
    // Stub returns 200 by URL pattern so every probe matches.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ d: { results: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    ) as typeof globalThis.fetch;

    const c = new ExactOnlineConnector();
    const results = await c.probeEntities(makeConfig(), { log: createNoopLogger(), onCredentialRotated: async () => {} });

    // Should have one row per entity in the catalog (size enforced
    // separately in listEntities tests; here we just check the cardinality).
    expect(results.length).toBeGreaterThanOrEqual(40);
    // Every entry has a name + state.
    for (const r of results) {
      expect(r.name).toBeTruthy();
      expect(['available', 'forbidden', 'not_found', 'error']).toContain(r.state);
    }
    // Cardinality matches: one result per unique name.
    expect(new Set(results.map((r) => r.name)).size).toBe(results.length);
  });

  it('treats 429 + retry-after as retry once, then error', async () => {
    mockTokenRefresh();
    const root = `${BASE_URL}/api/v1/${DIVISION}`;
    let accountsCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
      const s = typeof url === 'string' ? url : url.toString();
      if (s.startsWith(`${root}/crm/Accounts`)) {
        accountsCallCount++;
        // First call returns 429, second call also returns 429 → final 'error'.
        return new Response(JSON.stringify({ error: 'rate limit' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      }
      return new Response(JSON.stringify({ d: { results: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const c = new ExactOnlineConnector();
    const results = await c.probeEntities(makeConfig(), { log: createNoopLogger(), onCredentialRotated: async () => {} });

    const accounts = results.find((r) => r.name === 'Accounts');
    expect(accounts).toMatchObject({ name: 'Accounts', state: 'error', httpStatus: 429 });
    expect(accountsCallCount).toBe(2);  // retried exactly once
  }, 15_000);
});
