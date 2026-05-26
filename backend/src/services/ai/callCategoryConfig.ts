/**
 * Per-category AI model override lookup with in-process cache.
 *
 * Reads from `ai_model_config` table. Each (tenant_id, call_category)
 * row can override the global routing mode with a specific provider +
 * model. Cache TTL is 15 seconds (matches tenant mode cache) so admin
 * changes take effect promptly without a restart.
 */

import { semanticDb } from '../../db/knex';

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
      const rows = await semanticDb('ai_model_config')
        .where({ tenant_id: tenantId })
        .select('call_category', 'provider', 'model_id');
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

export async function getAllCallCategoryConfigs(
  tenantId: number,
): Promise<Record<string, ModelOverride>> {
  const rows = await semanticDb('ai_model_config')
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
