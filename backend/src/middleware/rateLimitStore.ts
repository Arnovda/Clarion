/**
 * Rate limiting that survives replicas, and keys that name the caller
 * (P1-2).
 *
 * Every limiter used express-rate-limit's default MemoryStore keyed by
 * IP. Two structural problems:
 *
 *  - MEMORY IS PER-REPLICA. With `max_replicas = 3` on the backend, a
 *    load-balanced attacker gets every published limit ~3× — including
 *    brute-force (5/15min became ~15). The counter has to live where all
 *    replicas can see it, which is the Redis this platform already runs.
 *  - IP IS NOT A TENANT. An office NAT shares one IP across a whole
 *    company; a botnet spreads one attack across many. Authenticated
 *    traffic is now keyed by TENANT, and the brute-force surface gains a
 *    second limiter keyed by the ACCOUNT under attack — closing the
 *    distributed-single-account hole the old comment conceded to.
 *
 * Degradation is deliberate in both directions:
 *  - No Redis configured (local dev, CI) → `redisRateLimitStore` returns
 *    undefined and express-rate-limit falls back to its MemoryStore —
 *    single-process environments were never wrong.
 *  - Redis ERRORS at runtime → fail OPEN (count as the first hit): a
 *    Redis blip must not 429 the whole product, and the blip is logged
 *    loudly rather than silently absorbed.
 */

import type { Request } from 'express';
import type { Store, Options, IncrementResponse } from 'express-rate-limit';
import { ipKeyGenerator } from 'express-rate-limit';
import { getRedisConnection } from '../jobs/redis';
import { verifyToken } from './auth';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'rateLimit' });

/**
 * Fixed-window counter on the shared Redis. One INCR per request, the
 * window set on the first hit — the same semantics as the MemoryStore it
 * replaces, just visible to every replica.
 */
/** `redis` is injectable for tests (the healthCheck pattern); production
 * callers use the shared connection. */
/**
 * What a limiter does when Redis ERRORS mid-request (it is configured, but a
 * call fails):
 *
 *  - 'open'   — allow the request (the default). A Redis blip must not 429
 *               the product for the ordinary limiters.
 *  - 'memory' — count in THIS process for the rest of the window (5-5). For
 *               the brute-force limiters "open" meant the one protection
 *               that matters most was OFF during exactly the outage an
 *               attacker would pick; "closed" would refuse every login while
 *               Redis blinks. A per-process window is the middle: ~3× weaker
 *               at three replicas, still a wall, and no one locked out for
 *               a blip. The fallback counters expire with the window.
 */
export type OnStoreError = 'open' | 'memory';

export function redisRateLimitStore(
  prefix: string,
  redis: ReturnType<typeof getRedisConnection> = getRedisConnection(),
  opts: { onError?: OnStoreError } = {},
): Store | undefined {
  if (!redis) return undefined;

  let windowMs = 60_000;
  const keyOf = (key: string) => `rl:${prefix}:${key}`;
  const onError: OnStoreError = opts.onError ?? 'open';
  // The in-process fallback (only ever touched when onError === 'memory').
  const local = new Map<string, { hits: number; resetAt: number }>();
  const localHit = (key: string): IncrementResponse => {
    const now = Date.now();
    const cur = local.get(key);
    if (!cur || cur.resetAt <= now) {
      const fresh = { hits: 1, resetAt: now + windowMs };
      local.set(key, fresh);
      if (local.size > 10_000) {
        // Bounded: sweep expired entries rather than grow without limit.
        for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
      }
      return { totalHits: 1, resetTime: new Date(fresh.resetAt) };
    }
    cur.hits += 1;
    return { totalHits: cur.hits, resetTime: new Date(cur.resetAt) };
  };

  return {
    init(options: Options): void {
      windowMs = options.windowMs;
    },
    async increment(key: string): Promise<IncrementResponse> {
      try {
        const k = keyOf(key);
        const totalHits = await redis.incr(k);
        if (totalHits === 1) {
          await redis.pexpire(k, windowMs);
        }
        let ttl = await redis.pttl(k);
        if (ttl < 0) {
          // The key somehow has no expiry (a crash between INCR and
          // PEXPIRE) — set one rather than counting forever.
          await redis.pexpire(k, windowMs);
          ttl = windowMs;
        }
        return { totalHits, resetTime: new Date(Date.now() + ttl) };
      } catch (err) {
        if (onError === 'memory') {
          log.warn({ err, prefix }, 'rate-limit store error — counting in-process for this window');
          return localHit(key);
        }
        log.warn({ err, prefix }, 'rate-limit store error — failing open for this request');
        return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
      }
    },
    // skipSuccessfulRequests refunds the hit on success — the brute-force
    // limiter depends on this, so it must reach Redis too.
    async decrement(key: string): Promise<void> {
      try { await redis.decr(keyOf(key)); } catch {
        const cur = local.get(key);
        if (cur && cur.hits > 0) cur.hits -= 1; // refund the in-process count too
      }
    },
    async resetKey(key: string): Promise<void> {
      try { await redis.del(keyOf(key)); } catch { /* best-effort */ }
    },
  };
}

/**
 * Tenant when the request carries a VALID access token, IP otherwise.
 * Verified, not merely decoded, on purpose: an unverified decode would let
 * any caller CHOOSE their bucket — including another tenant's, turning the
 * limiter into a denial-of-service lever against that tenant. HMAC verify
 * costs microseconds and requireAuth would reject a bad token later
 * anyway, so an invalid token simply falls back to the IP bucket.
 */
export function tenantOrIpKey(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      if (payload?.tenantId) return `t:${payload.tenantId}`;
    } catch { /* invalid token → IP bucket */ }
  }
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * The ACCOUNT under attack, for the brute-force surface. The per-IP
 * limiter stops one machine spraying many accounts; this one stops many
 * machines converging on ONE account — each dimension catches what the
 * other cannot. Requests without an email (malformed probes) fall back
 * to the IP bucket rather than sharing one global key.
 */
export function accountKey(req: Request): string {
  const email = typeof (req.body as { email?: unknown } | undefined)?.email === 'string'
    ? (req.body as { email: string }).email.trim().toLowerCase()
    : '';
  return email ? `acct:${email}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * When a brute limiter actually FIRES, say so in the logs (P1-6). The 429
 * itself is visible only to the attacker; this line is what the
 * `clarion-brute-force` alert rule in .ops/alerts matches, closing the
 * "lockout/alerting on rl:brute-acct bursts" gap the P1-2 PR parked here.
 *
 * LOAD-BEARING STRING: 'brute force limit hit' — reword it and that alert
 * goes silently blind (the requestLogger 'request failed' covenant).
 *
 * Deliberately NO email in the line: the limiter name + IP + path identify
 * the attack, and the account under it is readable from the audit trail —
 * an address in an alertable log line is a disclosure nothing here needs.
 * The response mirrors express-rate-limit's default handler (status +
 * configured message) so switching handlers changes nothing on the wire.
 */
export function bruteLimitHandler(limiter: string) {
  return (
    req: Request,
    res: { status(code: number): { json(body: unknown): unknown } },
    _next: unknown,
    options: { statusCode: number; message: unknown },
  ): void => {
    log.warn({ limiter, ip: req.ip, path: req.path }, 'brute force limit hit');
    res.status(options.statusCode).json(options.message);
  };
}
