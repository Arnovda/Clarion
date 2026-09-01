/**
 * P1-2 — Redis-backed, caller-keyed rate limiting.
 *
 * The defect is architectural and cannot fire inside one test process:
 * express-rate-limit's MemoryStore is per-replica, so max_replicas=3
 * multiplied every published limit ~3× (verified by reading — the store
 * held no shared state anywhere). What CAN be pinned is the fix: two
 * store instances (two "replicas") sharing one Redis count as ONE
 * window, plus the key generators and the deliberate failure semantics.
 */

import { describe, it, expect } from 'vitest';
import type { Options } from 'express-rate-limit';
import { redisRateLimitStore, tenantOrIpKey, accountKey } from '../middleware/rateLimitStore';
import { signToken } from '../middleware/auth';

/** Just enough of ioredis for the store: INCR/PEXPIRE/PTTL/DECR/DEL. */
function fakeRedis() {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  return {
    counts,
    expiries,
    async incr(k: string) { const v = (counts.get(k) ?? 0) + 1; counts.set(k, v); return v; },
    async pexpire(k: string, ms: number) { expiries.set(k, Date.now() + ms); return 1; },
    async pttl(k: string) { const e = expiries.get(k); return e == null ? -1 : Math.max(0, e - Date.now()); },
    async decr(k: string) { const v = (counts.get(k) ?? 0) - 1; counts.set(k, v); return v; },
    async del(k: string) { counts.delete(k); expiries.delete(k); return 1; },
  } as never;
}

const opts = { windowMs: 60_000 } as Options;

describe('redisRateLimitStore', () => {
  it('two store instances (two replicas) share ONE counter — the per-replica multiplication is gone', async () => {
    const redis = fakeRedis();
    const replicaA = redisRateLimitStore('t', redis)!;
    const replicaB = redisRateLimitStore('t', redis)!;
    replicaA.init?.(opts);
    replicaB.init?.(opts);

    const a = await replicaA.increment('ip:1.2.3.4');
    const b = await replicaB.increment('ip:1.2.3.4');
    // Under the old MemoryStore each replica would report totalHits 1 here.
    expect(a.totalHits).toBe(1);
    expect(b.totalHits).toBe(2);
  });

  it('sets the window once and reports a real resetTime', async () => {
    const redis = fakeRedis();
    const store = redisRateLimitStore('w', redis)!;
    store.init?.(opts);
    const first = await store.increment('k');
    await store.increment('k');
    expect(first.resetTime).toBeInstanceOf(Date);
    // Exactly one expiry recorded for the key — the second hit reuses it.
    expect((redis as { expiries: Map<string, number> }).expiries.size).toBe(1);
  });

  it('decrement refunds (skipSuccessfulRequests), resetKey clears', async () => {
    const redis = fakeRedis();
    const store = redisRateLimitStore('r', redis)!;
    store.init?.(opts);
    await store.increment('k');
    await store.increment('k');
    await store.decrement?.('k');
    const after = await store.increment('k');
    expect(after.totalHits).toBe(2);
    await store.resetKey('k');
    const fresh = await store.increment('k');
    expect(fresh.totalHits).toBe(1);
  });

  it('fails OPEN when Redis errors — a blip must not 429 the product', async () => {
    const broken = {
      async incr() { throw new Error('redis gone'); },
      async pexpire() { return 1; }, async pttl() { return -1; },
      async decr() { return 0; }, async del() { return 1; },
    } as never;
    const store = redisRateLimitStore('b', broken)!;
    store.init?.(opts);
    const res = await store.increment('k');
    expect(res.totalHits).toBe(1);
  });

  it('returns undefined without Redis — dev falls back to the MemoryStore', () => {
    expect(redisRateLimitStore('x', null)).toBeUndefined();
  });
});

describe('key generators', () => {
  const reqWith = (over: Record<string, unknown>) =>
    ({ headers: {}, ip: '203.0.113.9', body: {}, ...over }) as never;

  it('a VALID token buckets by tenant; a forged one falls back to IP', () => {
    const token = signToken({ sub: 1, tenantId: 42, email: 'a@b.c', displayName: 'A', role: 'admin' });
    expect(tenantOrIpKey(reqWith({ headers: { authorization: `Bearer ${token}` } }))).toBe('t:42');
    // Unverifiable token: the caller must NOT get to choose their bucket.
    expect(tenantOrIpKey(reqWith({ headers: { authorization: 'Bearer not-a-token' } }))).toMatch(/^ip:/);
    expect(tenantOrIpKey(reqWith({}))).toMatch(/^ip:/);
  });

  it('accountKey buckets by the email under attack, case-folded; no email → IP', () => {
    expect(accountKey(reqWith({ body: { email: '  Victim@Test.com ' } }))).toBe('acct:victim@test.com');
    expect(accountKey(reqWith({ body: {} }))).toMatch(/^ip:/);
    expect(accountKey(reqWith({ body: { email: 42 } }))).toMatch(/^ip:/);
  });
});
