/**
 * A page's parallel requests must not deadlock the connection pool.
 *
 * `requireAuth` holds one pool connection per request for its tenant-scoped
 * transaction. A handler that then asks `tenantQuery` for a SECOND connection
 * deadlocks as soon as a page fires more parallel requests than the pool has
 * connections: each waits for a connection another holds, until the acquire
 * timeout. That was /admin/ai-usage in production on 2026-09-24 — seven
 * parallel calls against a pool of 6, every one a KnexTimeoutError at 10 s.
 *
 * The pool here is 2 and the acquire timeout 3 s, so the old code fails in
 * seconds; `withRequestDb` (db/reqDb.ts) keeps every call on its request's
 * own connection and they all answer. The env is set BEFORE db/knex.ts is
 * imported, which reads it once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.KNEX_POOL_MAX = '2';
process.env.KNEX_POOL_MIN = '0';
process.env.KNEX_POOL_ACQUIRE_TIMEOUT_MS = '3000';

let token: string;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const dbh = await import('./db-helpers');
  closeDb = dbh.closeTestDb;
  await dbh.cleanTestDb();
  const h = await import('./helpers');
  const admin = await h.registerUser({ email: 'pool-admin@test.com', companyName: 'PoolCo' });
  token = admin.token;
  await dbh.getTestDb()('ai_call_log').insert({
    tenant_id: admin.user.tenantId, user_id: admin.user.id,
    model: 'm', call_label: 'x', category: 'c', cost_usd: 0.01,
  });
});

afterAll(async () => { await closeDb(); });

describe('parallel requests on a small pool', () => {
  it('the AI usage page\'s seven calls all answer, with a pool of two', async () => {
    const h = await import('./helpers');
    const paths = [
      'summary', 'daily?days=30', 'by-category?days=30', 'by-user?days=30',
      'by-call-label?days=30', 'recent?limit=100', 'answer-latency?days=30',
    ];
    const results = await Promise.all(paths.map(async (p) =>
      (await h.request()).get(`/api/admin/ai-usage/${p}`).set('Authorization', `Bearer ${token}`),
    ));
    expect(results.map((r) => r.status)).toEqual(paths.map(() => 200));
    // The data is the tenant's own: the one seeded call is counted.
    const summary = results[0].body.data;
    expect(summary.month_calls).toBe(1);
    const daily = results[1].body.data as Array<{ calls: number }>;
    expect(daily.reduce((n, d) => n + d.calls, 0)).toBe(1);
  }, 30_000);
});
