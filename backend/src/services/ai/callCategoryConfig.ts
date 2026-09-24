/**
 * Per-category AI model override lookup with in-process cache.
 *
 * Reads from `ai_model_config` table. Each (tenant_id, call_category)
 * row can override the global routing mode with a specific provider +
 * model. Cache TTL is 15 seconds (matches tenant mode cache) so admin
 * changes take effect promptly without a restart.
 *
 * The read runs under the tenant's own context (tenantQuery). It used to
 * go to the bare root pool, where under the production role the policy
 * has no tenant to compare with: the read errored or matched nothing, the
 * catch below returned null, and every override silently fell back to the
 * default — the P0-2 shape once more. The explicit tenant_id filter is the
 * authorisation statement; RLS is the second line.
 */

import type { Knex } from 'knex';
import { tenantQuery } from '../tenantQuery';

export interface ModelOverride {
  provider: 'anthropic' | 'azure-openai' | 'azure-foundry';
  model_id: string;
}

const TTL_MS = 15_000;

interface CacheEntry {
  overrides: Map<string, ModelOverride>;
  expiresAt: number;
}

const store = new Map<number, CacheEntry>();

export async function getCallCategoryConfig(
  tenantId: number,
  category: string,
): Promise<ModelOverride | null> {
  let entry = store.get(tenantId);
  if (!entry || Date.now() >= entry.expiresAt) {
    try {
      const rows = await tenantQuery(tenantId, (db) => db('ai_model_config')
        .where({ tenant_id: tenantId })
        .select('call_category', 'provider', 'model_id'));
      const overrides = new Map<string, ModelOverride>();
      for (const r of rows) {
        overrides.set(r.call_category, {
          provider: r.provider as ModelOverride['provider'],
          model_id: r.model_id,
        });
      }
      entry = { overrides, expiresAt: Date.now() + TTL_MS };
      store.set(tenantId, entry);
    } catch {
      return null;
    }
  }
  return entry.overrides.get(category) ?? null;
}

/**
 * Every override of one tenant. `db` is the caller's tenant-scoped handle
 * (reqDb(req) in a route) — never a second pool connection inside a
 * request (the 2026-09-24 AI-usage deadlock).
 */
export async function getAllCallCategoryConfigs(
  db: Knex,
  tenantId: number,
): Promise<Record<string, ModelOverride>> {
  const rows = await db('ai_model_config')
    .where({ tenant_id: tenantId })
    .select('call_category', 'provider', 'model_id');
  const result: Record<string, ModelOverride> = {};
  for (const r of rows) {
    result[r.call_category] = {
      provider: r.provider as ModelOverride['provider'],
      model_id: r.model_id,
    };
  }
  return result;
}

export function invalidateCallCategoryCache(tenantId: number): void {
  store.delete(tenantId);
}
