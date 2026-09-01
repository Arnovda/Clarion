/**
 * Account-status re-validation (P1-3) — the fast-suspension check.
 *
 * requireAuth calls this on every authenticated request AFTER the JWT
 * signature verifies: a token proves who the caller was when it was
 * signed, not that the account is still in good standing. Before this
 * check, `tenants.status` and `users.is_active` were read only at login,
 * so suspending a customer took effect whenever their access token
 * happened to expire — up to 8 hours in production.
 *
 * Cached per (tenantId, userId) with a short TTL (`AUTH_STATUS_TTL_MS`,
 * default 30s) so the cost is one indexed read per user per TTL, not per
 * request. The TTL bounds suspension latency per replica — 30s keeps the
 * wave-2 exit gate ("suspended within a minute") with slack. TTL=0
 * disables caching entirely (tests use this). The env var is read per
 * call, not frozen at import, for the same reason as
 * `platformOperatorEmails`: a value captured at import cannot be varied
 * by a test, which is the wrong trade for an auth control.
 *
 * Failure semantics — the two directions are deliberately different:
 * - A DEFINITIVE negative (the row says suspended/inactive, or the rows
 *   are gone) refuses, and the refusal is cached like a pass. Fail
 *   closed: refusing is this control's whole job.
 * - A query ERROR allows and is NOT cached. Fail open: a database blip
 *   must not turn into a 401 for every user of the product — the request
 *   hits the same database an instant later and fails honestly there,
 *   and RLS still guards the data either way. Logged loudly so a
 *   systematically failing check cannot pass silently.
 */

import { unauthQuery } from '../db/unauthQuery';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'accountStatus' });

export type AccountStatus = 'active' | 'refused' | 'unknown';

interface StatusRow {
  is_active: boolean | null;
  status: string | null;
}

/**
 * Runs before any tenant context exists, hence `unauthQuery`: `users` is
 * readable under the `auth_lookup` RLS carve-out (empty tenant context),
 * and `tenants` carries no RLS at all.
 */
async function fetchStatusRow(tenantId: number, userId: number): Promise<StatusRow | undefined> {
  return unauthQuery((trx) =>
    trx('users')
      .join('tenants', 'tenants.id', 'users.tenant_id')
      .where({ 'users.id': userId, 'users.tenant_id': tenantId })
      .select('users.is_active', 'tenants.status')
      .first(),
  );
}

const cache = new Map<string, { verdict: 'active' | 'refused'; expiresAt: number }>();

/** Opportunistic bound — expired entries are pruned when the map grows. */
const CACHE_PRUNE_THRESHOLD = 10_000;

function ttlMs(): number {
  const raw = Number(process.env.AUTH_STATUS_TTL_MS ?? 30_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

export async function checkAccountStatus(
  tenantId: number,
  userId: number,
  fetchRow: typeof fetchStatusRow = fetchStatusRow,
): Promise<AccountStatus> {
  const ttl = ttlMs();
  const key = `${tenantId}:${userId}`;

  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.verdict;
  }

  let row: StatusRow | undefined;
  try {
    row = await fetchRow(tenantId, userId);
  } catch (err) {
    log.warn({ err, tenantId, userId }, 'account status check failed — allowing request (fail open)');
    return 'unknown';
  }

  // No row = the user (or the whole tenant) is gone — as definitive a
  // negative as an explicit suspension.
  const verdict: 'active' | 'refused' =
    row && row.is_active === true && row.status === 'active' ? 'active' : 'refused';

  if (ttl > 0) {
    if (cache.size > CACHE_PRUNE_THRESHOLD) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    }
    cache.set(key, { verdict, expiresAt: Date.now() + ttl });
  }
  return verdict;
}

/** Test hook — drops every cached verdict. */
export function _clearAccountStatusCache(): void {
  cache.clear();
}
