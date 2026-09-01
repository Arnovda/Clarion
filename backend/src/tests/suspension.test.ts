/**
 * P1-3 — fast suspension.
 *
 * Suspending a tenant (or deactivating a user) must bite on the NEXT
 * request, not when the access token happens to expire. These tests pin
 * the two enforcement points:
 *
 *   1. requireAuth re-validates tenants.status + users.is_active behind a
 *      short-TTL cache — a live access token stops working the moment the
 *      account does.
 *   2. /auth/refresh refuses a suspended tenant — before this, the refresh
 *      endpoint checked users.is_active but NEVER tenants.status, so a
 *      suspended tenant's users could mint fresh access tokens for 30 days.
 *
 * AUTH_STATUS_TTL_MS=0 disables the cache so every request re-reads the
 * database — the TTL behaviour itself is unit-tested in the service suite
 * below; these route tests pin enforcement, not caching.
 */

process.env.AUTH_STATUS_TTL_MS = '0';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser } from './helpers';
import { cleanTestDb, closeTestDb } from './db-helpers';
import { semanticDb } from '../db/knex';
import { checkAccountStatus, _clearAccountStatusCache } from '../services/accountStatus';

const getDb = () => semanticDb;

beforeAll(async () => {
  await cleanTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('fast suspension (P1-3)', () => {
  it('a suspended tenant is refused on the next authenticated request, and again on refresh', async () => {
    const { token, refreshToken, user } = await registerUser({
      companyName: 'Suspend Me BV',
      email: `suspend-${Date.now()}@test.com`,
    });
    const agent = await request();

    // Baseline: the token works.
    const ok = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    // Operator suspends the tenant (P1-5's console will do this; today it
    // is a direct column update — the enforcement must not care which).
    await getDb()('tenants').where({ id: user.tenantId }).update({ status: 'suspended' });

    // The SAME still-valid access token is refused now.
    const refused = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(refused.status).toBe(401);

    // And the refresh token cannot mint a fresh access token either.
    const refresh = await agent.post('/api/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('reactivating the tenant restores access without new tokens', async () => {
    const { token, user } = await registerUser({
      companyName: 'Reactivate BV',
      email: `reactivate-${Date.now()}@test.com`,
    });
    const agent = await request();

    await getDb()('tenants').where({ id: user.tenantId }).update({ status: 'suspended' });
    const refused = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(refused.status).toBe(401);

    await getDb()('tenants').where({ id: user.tenantId }).update({ status: 'active' });
    const restored = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(restored.status).toBe(200);
  });

  it('a deactivated user is refused on the next request and on refresh', async () => {
    const { token, refreshToken, user } = await registerUser({
      companyName: 'Deactivate BV',
      email: `deactivate-${Date.now()}@test.com`,
    });
    const agent = await request();

    // Deliberately NOT /auth/me — that handler re-reads the user row with
    // an is_active filter itself, so it refuses a deactivated user even
    // with no middleware check and would pass this test for the wrong
    // reason. /dashboards never touches the users table: only the
    // middleware can refuse it.
    const ok = await agent.get('/api/dashboards').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    await getDb()('users').where({ id: user.id }).update({ is_active: false });

    const refused = await agent.get('/api/dashboards').set('Authorization', `Bearer ${token}`);
    expect(refused.status).toBe(401);

    // Refresh already checked is_active before this work — pinned so it
    // cannot regress while the tenant check is added beside it.
    const refresh = await agent.post('/api/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Service-level: cache + failure semantics (injected fetcher, no routes)
// ---------------------------------------------------------------------------

describe('checkAccountStatus', () => {
  const withTtl = async (ttl: string, fn: () => Promise<void>) => {
    const prev = process.env.AUTH_STATUS_TTL_MS;
    process.env.AUTH_STATUS_TTL_MS = ttl;
    _clearAccountStatusCache();
    try {
      await fn();
    } finally {
      process.env.AUTH_STATUS_TTL_MS = prev;
      _clearAccountStatusCache();
    }
  };

  it('caches the verdict within the TTL — one read per user per window', async () => {
    await withTtl('60000', async () => {
      let calls = 0;
      const fetcher = async () => { calls++; return { is_active: true, status: 'active' }; };
      expect(await checkAccountStatus(1, 1, fetcher)).toBe('active');
      expect(await checkAccountStatus(1, 1, fetcher)).toBe('active');
      expect(await checkAccountStatus(1, 1, fetcher)).toBe('active');
      expect(calls).toBe(1);
      // A different user is a different cache entry.
      expect(await checkAccountStatus(1, 2, fetcher)).toBe('active');
      expect(calls).toBe(2);
    });
  });

  it('refuses a suspended tenant, an inactive user, and a missing row alike', async () => {
    await withTtl('0', async () => {
      expect(await checkAccountStatus(1, 1, async () => ({ is_active: true, status: 'suspended' }))).toBe('refused');
      expect(await checkAccountStatus(1, 1, async () => ({ is_active: false, status: 'active' }))).toBe('refused');
      expect(await checkAccountStatus(1, 1, async () => undefined)).toBe('refused');
    });
  });

  it('fails OPEN on a query error, and does not cache the error', async () => {
    await withTtl('60000', async () => {
      let calls = 0;
      const failing = async (): Promise<{ is_active: boolean; status: string }> => {
        calls++;
        throw new Error('connection refused');
      };
      // A DB blip must not 401 the product — 'unknown' lets the request
      // proceed to fail (or succeed) honestly downstream.
      expect(await checkAccountStatus(1, 1, failing)).toBe('unknown');
      // NOT cached: the next call retries instead of trusting a blip.
      expect(await checkAccountStatus(1, 1, failing)).toBe('unknown');
      expect(calls).toBe(2);
    });
  });

  it('a cached verdict expires — suspension bites within one TTL', async () => {
    await withTtl('30', async () => {
      let active = true;
      const fetcher = async () => ({ is_active: true, status: active ? 'active' : 'suspended' });
      expect(await checkAccountStatus(1, 1, fetcher)).toBe('active');
      active = false;
      // Still inside the TTL: the stale pass is served (that is the deal).
      expect(await checkAccountStatus(1, 1, fetcher)).toBe('active');
      await new Promise((r) => setTimeout(r, 40));
      expect(await checkAccountStatus(1, 1, fetcher)).toBe('refused');
    });
  });
});
