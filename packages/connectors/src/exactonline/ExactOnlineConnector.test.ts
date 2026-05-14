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
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
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
    const result = await c.testConnection(makeConfig(), { log: createNoopLogger() });

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

    // Two-page response for Accounts.
    nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
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

  it('appends $filter for entities that declare a defaultFilter', async () => {
    mockTokenRefresh();
    const filterMock = nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/financialtransaction/TransactionLines`)
      .query((q) => typeof q.$filter === 'string' && q.$filter.includes("Date gt datetime"))
      .reply(200, { d: { results: [{ ID: 't1', Amount: 100 }] } });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);

    const c = new ExactOnlineConnector();
    const result = await c.sync(makeConfig(), { entities: ['TransactionLines'] }, ctx);

    expect(result.rowCounts).toEqual({ TransactionLines: 1 });
    expect(filterMock.isDone()).toBe(true);
  });

  it('warns on unknown entity names and skips them', async () => {
    mockTokenRefresh();
    nock(BASE_URL).get(`/api/v1/${DIVISION}/crm/Accounts`).reply(200, { d: [] });

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
    nock(BASE_URL).get(`/api/v1/${DIVISION}/crm/Accounts`).reply(200, {
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
    // Six 500s — exceeds default maxRetries=5. Per-entity error tolerance
    // means this entity gets warned + skipped, but sync() resolves
    // successfully so other entities (none here, but in real usage) keep
    // running.
    nock(BASE_URL)
      .get(`/api/v1/${DIVISION}/crm/Accounts`)
      .times(6)
      .reply(500, { error: 'server fire' });

    const root = await makeWarehouse();
    const ctx = makeCtx(root);
    const c = new ExactOnlineConnector();

    const result = await c.sync(makeConfig(), { entities: ['Accounts'] }, ctx);
    expect(result.rowCounts).toEqual({ Accounts: 0 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Entity 'Accounts' failed.*HTTP 500/)]),
    );
  }, 30_000);
});
