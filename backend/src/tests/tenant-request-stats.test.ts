/**
 * P1-6 — per-tenant request stats (the /admin/tenants error-rate and latency
 * columns) and the queue-depth check. Like the P1-2 rate-limit store, the
 * cross-replica property is pinned on a shared fake Redis: two writers, one
 * window; and the failure semantics are the deliberate part — no Redis or a
 * broken Redis must degrade to "no data", never to a 500 or fabricated zeros.
 */

import { describe, it, expect } from 'vitest';
import type IORedis from 'ioredis';
import {
  recordTenantRequest,
  readTenantRequestStats,
  LATENCY_BOUNDS_MS,
} from '../services/tenantRequestStats';
import { checkQueueDepths, type DepthReadableQueue } from '../jobs/queueDepthMonitor';

/** Just enough of ioredis for this service: pipeline of hincrby/expire/hgetall. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, number>>();
  function hash(k: string) {
    let h = hashes.get(k);
    if (!h) { h = new Map(); hashes.set(k, h); }
    return h;
  }
  function makePipeline() {
    const ops: Array<() => [null, unknown]> = [];
    const p = {
      hincrby(k: string, f: string, by: number) {
        ops.push(() => { const h = hash(k); h.set(f, (h.get(f) ?? 0) + by); return [null, h.get(f)]; });
        return p;
      },
      expire(_k: string, _s: number) { ops.push(() => [null, 1]); return p; },
      hgetall(k: string) {
        ops.push(() => {
          const h = hashes.get(k);
          const out: Record<string, string> = {};
          if (h) for (const [f, v] of h) out[f] = String(v);
          return [null, out];
        });
        return p;
      },
      async exec() { return ops.map((op) => op()); },
    };
    return p;
  }
  return { hashes, pipeline: makePipeline } as unknown as IORedis & { hashes: Map<string, Map<string, number>> };
}

const T0 = 1_756_800_000_000; // fixed "now" so bucket indices are deterministic

describe('tenantRequestStats', () => {
  it('two writers (two replicas) land in ONE shared window, and the read merges it', async () => {
    const redis = fakeRedis();
    await recordTenantRequest(7, 200, 80, redis, T0);
    await recordTenantRequest(7, 200, 90, redis, T0);
    await recordTenantRequest(7, 503, 4000, redis, T0);
    await recordTenantRequest(9, 200, 30, redis, T0);

    const stats = await readTenantRequestStats(redis, T0);
    expect(stats.get(7)).toMatchObject({ requests: 3, errors: 1 });
    expect(stats.get(9)).toMatchObject({ requests: 1, errors: 0 });
    // avg of 80+90+4000 ≈ 1390
    expect(stats.get(7)!.avgMs).toBe(Math.round((80 + 90 + 4000) / 3));
  });

  it('counts only 5xx as errors — a 4xx is the caller, not the platform', async () => {
    const redis = fakeRedis();
    await recordTenantRequest(1, 404, 10, redis, T0);
    await recordTenantRequest(1, 429, 10, redis, T0);
    await recordTenantRequest(1, 500, 10, redis, T0);
    const stats = await readTenantRequestStats(redis, T0);
    expect(stats.get(1)).toMatchObject({ requests: 3, errors: 1 });
  });

  it('p95 reports the histogram bucket bound holding the 95th percentile', async () => {
    const redis = fakeRedis();
    // 20 fast requests, 1 slow: rank ceil(21*0.95)=20 → still in the fast bucket.
    for (let i = 0; i < 20; i++) await recordTenantRequest(2, 200, 80, redis, T0);
    await recordTenantRequest(2, 200, 4000, redis, T0);
    let stats = await readTenantRequestStats(redis, T0);
    expect(stats.get(2)!.p95Ms).toBe(100); // 80ms falls in the ≤100 bucket

    // Half slow: rank lands among the 4s requests → the ≤5000 bucket.
    for (let i = 0; i < 19; i++) await recordTenantRequest(2, 200, 4000, redis, T0);
    stats = await readTenantRequestStats(redis, T0);
    expect(stats.get(2)!.p95Ms).toBe(5000);
  });

  it('beyond the last bound the p95 reports that bound ("at least")', async () => {
    const redis = fakeRedis();
    await recordTenantRequest(3, 200, 120_000, redis, T0);
    const stats = await readTenantRequestStats(redis, T0);
    expect(stats.get(3)!.p95Ms).toBe(LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]);
  });

  it('a bucket older than the 24h window is excluded from the read', async () => {
    const redis = fakeRedis();
    await recordTenantRequest(4, 500, 50, redis, T0 - 25 * 3_600_000); // 25h ago
    await recordTenantRequest(4, 200, 50, redis, T0);
    const stats = await readTenantRequestStats(redis, T0);
    expect(stats.get(4)).toMatchObject({ requests: 1, errors: 0 });
  });

  it('anonymous requests are not recorded; no Redis and broken Redis both degrade to "no data"', async () => {
    const redis = fakeRedis();
    await recordTenantRequest(undefined, 200, 10, redis, T0);
    expect((await readTenantRequestStats(redis, T0)).size).toBe(0);

    // No Redis configured → no-ops, empty map, no throw.
    await expect(recordTenantRequest(1, 200, 10, null, T0)).resolves.toBeUndefined();
    expect((await readTenantRequestStats(null, T0)).size).toBe(0);

    // Redis that ERRORS → the sample drops / the read is empty, never a throw.
    const broken = { pipeline() { throw new Error('redis down'); } } as unknown as IORedis;
    await expect(recordTenantRequest(1, 200, 10, broken, T0)).resolves.toBeUndefined();
    expect((await readTenantRequestStats(broken, T0)).size).toBe(0);
  });
});

describe('checkQueueDepths', () => {
  const q = (name: string, wait: number, fail = false): DepthReadableQueue => ({
    name,
    async getJobCounts() {
      if (fail) throw new Error('queue client dead');
      return { wait, delayed: 2, active: 1 };
    },
  });

  it('flags only queues at/above the threshold, on WAITING alone', async () => {
    const depths = await checkQueueDepths([q('calm', 3), q('busy', 25)], 25);
    expect(depths).toHaveLength(2);
    expect(depths.find((d) => d.queue === 'calm')!.warn).toBe(false);
    expect(depths.find((d) => d.queue === 'busy')!.warn).toBe(true);
  });

  it('one dead queue client must not hide the others', async () => {
    const depths = await checkQueueDepths([q('dead', 0, true), q('alive', 30)], 25);
    expect(depths).toHaveLength(1);
    expect(depths[0]).toMatchObject({ queue: 'alive', warn: true });
  });
});
