/**
 * tenantRequestStats.ts — per-tenant rolling request statistics (P1-6).
 *
 * The operator console (/admin/tenants) answers "whose experience is broken?"
 * from Postgres for syncs and AI spend, but HTTP error rate and latency lived
 * only in logs nobody aggregates by tenant. This service keeps a 24-hour
 * rolling window of per-tenant request counts, server-error counts and a
 * coarse latency histogram in Redis, fed by requestLogger on every authed
 * request and read back by the console in one round trip.
 *
 * SHAPE: one Redis hash per HOUR (`obs:req:<hourIndex>`), fields namespaced
 * by tenant (`<tid>:n`, `<tid>:err`, `<tid>:dur`, `<tid>:b<i>`). One hash per
 * hour — not per tenant-hour — so reading the whole window is 24 HGETALLs
 * regardless of tenant count, and replicas share the same counters the same
 * way the P1-2 rate-limit store does (HINCRBY is atomic).
 *
 * FAILURE SEMANTICS, deliberate both ways (the rateLimitStore pattern):
 *  - No Redis configured (dev/CI) → both functions no-op; the console shows
 *    "no data" instead of zeros pretending to be measurements.
 *  - Redis ERROR → the sample is dropped / the read returns empty, logged at
 *    debug. Observability must never break serving or the console.
 *
 * `err` counts HTTP 5xx ONLY: a 4xx is the caller's behaviour (bad password,
 * rate limit, validation), not the platform failing the tenant.
 */

import type IORedis from 'ioredis';
import { getRedisConnection } from '../jobs/redis';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'tenantRequestStats' });

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;
/** Buckets outlive the window by 2h so a read at :59 still sees a full 24h. */
const KEY_TTL_SECONDS = (WINDOW_HOURS + 2) * 3600;

/**
 * Histogram upper bounds in ms. The reported p95 is the upper bound of the
 * bucket holding the 95th percentile — an upper-bound APPROXIMATION, which is
 * exactly what a "which tenant is hurting?" console needs (the difference
 * between 480ms and 500ms changes no decision; the difference between 500ms
 * and 10s does). Anything beyond the last bound reports as that bound,
 * i.e. "at least 30s".
 */
export const LATENCY_BOUNDS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const OVERFLOW_BUCKET = LATENCY_BOUNDS_MS.length; // index of the ">last bound" bucket

export interface TenantRequestStats {
  /** Requests in the last 24h. */
  requests: number;
  /** HTTP 5xx responses in the last 24h. */
  errors: number;
  /** Mean latency in ms (rounded). */
  avgMs: number;
  /** Upper bound of the histogram bucket holding the 95th percentile. */
  p95Ms: number;
}

function hourIndex(now: number): number {
  return Math.floor(now / HOUR_MS);
}

function bucketKey(hour: number): string {
  return `obs:req:${hour}`;
}

function latencyBucket(durationMs: number): number {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) {
    if (durationMs <= LATENCY_BOUNDS_MS[i]) return i;
  }
  return OVERFLOW_BUCKET;
}

/**
 * Record one finished request. Fire-and-forget: resolves (never rejects)
 * whatever Redis does — call sites must not need a try/catch.
 * Anonymous requests (no tenant on the token) are deliberately not recorded:
 * this window exists to compare TENANTS, and the unauthenticated surface is
 * already covered by the global 5xx alert.
 */
export async function recordTenantRequest(
  tenantId: number | undefined,
  statusCode: number,
  durationMs: number,
  redis: IORedis | null = getRedisConnection(),
  now: number = Date.now(),
): Promise<void> {
  if (!redis || !tenantId) return;
  try {
    const key = bucketKey(hourIndex(now));
    const p = redis.pipeline();
    p.hincrby(key, `${tenantId}:n`, 1);
    if (statusCode >= 500) p.hincrby(key, `${tenantId}:err`, 1);
    p.hincrby(key, `${tenantId}:dur`, Math.max(0, Math.round(durationMs)));
    p.hincrby(key, `${tenantId}:b${latencyBucket(durationMs)}`, 1);
    p.expire(key, KEY_TTL_SECONDS);
    await p.exec();
  } catch (err) {
    log.debug({ err }, 'tenant request stat dropped');
  }
}

/**
 * Read the merged last-24h window for every tenant that served a request.
 * One pipeline of 24 HGETALLs however many tenants exist. Empty map when
 * Redis is absent or unreachable — "no data", never fabricated zeros.
 */
export async function readTenantRequestStats(
  redis: IORedis | null = getRedisConnection(),
  now: number = Date.now(),
): Promise<Map<number, TenantRequestStats>> {
  const out = new Map<number, TenantRequestStats>();
  if (!redis) return out;

  try {
    const currentHour = hourIndex(now);
    const p = redis.pipeline();
    for (let h = currentHour - (WINDOW_HOURS - 1); h <= currentHour; h++) {
      p.hgetall(bucketKey(h));
    }
    const results = (await p.exec()) ?? [];

    // Accumulate raw sums + histograms per tenant across the hourly hashes.
    const acc = new Map<number, { n: number; err: number; dur: number; hist: number[] }>();
    for (const [, fields] of results as Array<[unknown, Record<string, string> | null]>) {
      if (!fields) continue;
      for (const [field, raw] of Object.entries(fields)) {
        const sep = field.indexOf(':');
        if (sep <= 0) continue;
        const tenantId = Number(field.slice(0, sep));
        if (!Number.isFinite(tenantId)) continue;
        const metric = field.slice(sep + 1);
        const value = Number(raw) || 0;
        let a = acc.get(tenantId);
        if (!a) {
          a = { n: 0, err: 0, dur: 0, hist: new Array(OVERFLOW_BUCKET + 1).fill(0) };
          acc.set(tenantId, a);
        }
        if (metric === 'n') a.n += value;
        else if (metric === 'err') a.err += value;
        else if (metric === 'dur') a.dur += value;
        else if (metric.startsWith('b')) {
          const idx = Number(metric.slice(1));
          if (idx >= 0 && idx <= OVERFLOW_BUCKET) a.hist[idx] += value;
        }
      }
    }

    for (const [tenantId, a] of acc) {
      if (a.n <= 0) continue;
      // p95 from the histogram: smallest bound whose cumulative count covers
      // the 95th percentile; the overflow bucket reports the last bound
      // ("at least 30s").
      const rank = Math.ceil(a.n * 0.95);
      let cum = 0;
      let p95 = LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
      for (let i = 0; i <= OVERFLOW_BUCKET; i++) {
        cum += a.hist[i];
        if (cum >= rank) {
          p95 = i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
          break;
        }
      }
      out.set(tenantId, {
        requests: a.n,
        errors: a.err,
        avgMs: Math.round(a.dur / a.n),
        p95Ms: p95,
      });
    }
    return out;
  } catch (err) {
    log.debug({ err }, 'tenant request stats read failed');
    return new Map();
  }
}
