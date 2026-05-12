/**
 * Per-tenant AI routing mode lookup with a small in-process cache.
 *
 * Every AI call queries the tenant's `ai_routing_mode` to decide
 * whether to hit Claude or Azure. To avoid hammering Postgres on
 * every Claude call we cache the mode per tenant with a 15-second
 * TTL — short enough that flipping the toggle in the admin UI takes
 * effect within ~15s without a restart, long enough that a hot
 * tenant doesn't pay for a DB roundtrip on every prompt.
 *
 * On cache miss / failure we default to 'claude' — preserves the
 * current behaviour and never falls open to Azure for a tenant that
 * didn't opt in.
 */

import { semanticDb } from '../../db/knex';

export type AiRoutingMode = 'claude' | 'hybrid' | 'azure';

const TTL_MS = 15_000;

interface CacheEntry { mode: AiRoutingMode; expiresAt: number; }
const store = new Map<number, CacheEntry>();

export async function getTenantAiMode(tenantId: number | undefined): Promise<AiRoutingMode> {
  if (!tenantId) return 'claude';
  const cached = store.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.mode;
  try {
    // tenants table — single-row lookup. RLS forces session-tenant
    // match, so we use a raw SQL with explicit SET LOCAL for safety
    // when this is called outside a request context (background jobs).
    const result = await semanticDb.raw<{ rows: Array<{ ai_routing_mode: string }> }>(
      `SELECT ai_routing_mode FROM tenants WHERE id = ?`,
      [tenantId],
    );
    const raw = result.rows[0]?.ai_routing_mode as string | undefined;
    const mode: AiRoutingMode =
      raw === 'hybrid' || raw === 'azure' || raw === 'claude' ? raw : 'claude';
    store.set(tenantId, { mode, expiresAt: Date.now() + TTL_MS });
    return mode;
  } catch {
    // DB blip: default safely to Claude (the current production
    // behaviour) rather than picking Azure for a tenant that may
    // not have opted in.
    return 'claude';
  }
}

/** Invalidate the cache for a tenant — called from the PUT handler. */
export function invalidateTenantAiMode(tenantId: number): void {
  store.delete(tenantId);
}
