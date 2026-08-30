/**
 * Feature flags — the mechanism that separates DEPLOY from RELEASE.
 *
 * Deploy = the new code is running in production. Release = a particular
 * tenant can see it. Before this module those were the same event, so the only
 * available rollout was "everyone, now", and the only available withdrawal was
 * a rollback of every unrelated change shipped in the same revision.
 *
 * HOW A FLAG LIVES AND DIES
 *   1. Declare the key in `FEATURE_FLAGS` (shared/contract.ts). It is now 'off'
 *      for everyone, including you — no database row required.
 *   2. Write the feature behind `isFeatureEnabled(tenantId, key)` on the server
 *      and `useFeature(key)` on the client. Merge and deploy it dark.
 *   3. Roll it out to your own test tenant, then a friendly customer, then all.
 *   4. Once it is on 'all' and has stayed there, DELETE the flag and its checks.
 *      A permanent flag is a branch in the code that no longer means anything,
 *      and the cost of flags is entirely in how long they are left lying around.
 *
 * READ COST AND STALENESS
 * Flags are read on request paths, so the whole table (a handful of rows, ever)
 * is cached in module memory for a short TTL. A change therefore takes up to
 * `CACHE_TTL_MS` to reach every process — seconds, not a deploy, which is the
 * property we were buying. It is a TTL rather than a Redis broadcast on
 * purpose: the cache bus exists for warehouse invalidation where staleness
 * means WRONG NUMBERS, whereas a flag arriving 20 seconds late means a button
 * appears 20 seconds late. Writes clear the local cache immediately, so the
 * operator pressing the switch sees the effect at once; other processes catch
 * up on the TTL.
 *
 * An UNKNOWN key — a database row whose key is no longer in the registry, left
 * behind by a deleted flag — resolves to false and is reported by the console
 * as an orphan. It can never accidentally enable anything, because nothing in
 * the code asks about it any more.
 */

import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { platformOperatorEmails } from '../config';
import { CURRENT_RELEASE, FEATURE_KEYS, type FeatureKey, type FeatureRollout } from '../shared/contract';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'feature-flags' });

const TABLE = 'feature_flags';
const CACHE_TTL_MS = 20_000;

export interface FeatureFlagRow {
  key: string;
  rollout: FeatureRollout;
  tenant_ids: number[];
  updated_by: string | null;
  updated_at: string | null;
}

let cache: { at: number; rows: Map<string, FeatureFlagRow> } | null = null;

/**
 * `tenant_ids` arrives as parsed jsonb from `pg`, but a hand-edited row or a
 * driver difference could hand back a string. Coerce defensively and drop
 * anything non-numeric: a malformed array must degrade to "nobody sees it",
 * never throw on a request path shared by every route in the app.
 */
function normalizeTenantIds(raw: unknown): number[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function normalizeRollout(raw: unknown): FeatureRollout {
  return raw === 'all' || raw === 'tenants' ? raw : 'off';
}

async function loadRows(db: Knex | Knex.Transaction = semanticDb): Promise<Map<string, FeatureFlagRow>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;

  const rows = new Map<string, FeatureFlagRow>();
  try {
    const raw = await db(TABLE).select('key', 'rollout', 'tenant_ids', 'updated_by', 'updated_at');
    for (const r of raw as Array<Record<string, unknown>>) {
      const key = String(r.key);
      rows.set(key, {
        key,
        rollout: normalizeRollout(r.rollout),
        tenant_ids: normalizeTenantIds(r.tenant_ids),
        updated_by: r.updated_by == null ? null : String(r.updated_by),
        updated_at: r.updated_at == null ? null : new Date(r.updated_at as string).toISOString(),
      });
    }
    cache = { at: now, rows };
  } catch (err) {
    // The table is missing (migration not yet run) or the database is briefly
    // unreachable. Every flag reads 'off' and the app behaves exactly as it did
    // before flags existed. Deliberately NOT cached, so the next request retries.
    log.warn({ err }, 'feature flags unreadable — every flag resolves to off');
    return new Map();
  }
  return rows;
}

/** Drop the local cache so this process sees a write immediately. */
export function invalidateFeatureFlagCache(): void {
  cache = null;
}

function resolve(row: FeatureFlagRow | undefined, tenantId: number | undefined): boolean {
  if (!row) return false;                       // no row = never rolled out
  if (row.rollout === 'all') return true;
  if (row.rollout === 'off') return false;
  if (!tenantId) return false;                  // 'tenants' with no tenant = no
  return row.tenant_ids.includes(tenantId);
}

/**
 * Is `key` on for this tenant? The one function server code should call.
 * Unknown keys and unreachable databases both answer false.
 */
export async function isFeatureEnabled(
  tenantId: number | undefined,
  key: FeatureKey,
  db?: Knex | Knex.Transaction,
): Promise<boolean> {
  const rows = await loadRows(db);
  return resolve(rows.get(key), tenantId);
}

/** Every registered flag resolved for one tenant — what `GET /api/features` returns. */
export async function getFeaturesForTenant(
  tenantId: number | undefined,
  db?: Knex | Knex.Transaction,
): Promise<Record<string, boolean>> {
  const rows = await loadRows(db);
  const out: Record<string, boolean> = {};
  for (const key of FEATURE_KEYS) out[key] = resolve(rows.get(key), tenantId);
  return out;
}

/** Raw rollout state for every registered key, for the operator console. */
export async function listFlagState(
  db?: Knex | Knex.Transaction,
): Promise<Array<{ key: string; rollout: FeatureRollout; tenantIds: number[]; updatedBy: string | null; updatedAt: string | null; known: boolean }>> {
  const rows = await loadRows(db);
  const known = FEATURE_KEYS.map((key) => {
    const row = rows.get(key);
    return {
      key: key as string,
      rollout: row?.rollout ?? ('off' as FeatureRollout),
      tenantIds: row?.tenant_ids ?? [],
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
      known: true,
    };
  });
  // Orphans: rows whose flag was deleted from the registry. Surfaced so they
  // can be cleaned up rather than lingering invisibly.
  const orphans = [...rows.values()]
    .filter((r) => !(FEATURE_KEYS as string[]).includes(r.key))
    .map((r) => ({
      key: r.key,
      rollout: r.rollout,
      tenantIds: r.tenant_ids,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      known: false,
    }));
  return [...known, ...orphans];
}

/**
 * Set a flag's rollout. Upserts — a flag with no row yet is created on first
 * change, which is why nothing needs seeding when a key is added to the code.
 *
 * `tenantIds` is only meaningful for rollout 'tenants'; it is stored regardless
 * so that flipping 'tenants' → 'all' → 'tenants' does not lose the audience the
 * operator built up.
 */
export async function setFlagRollout(
  db: Knex | Knex.Transaction,
  key: string,
  rollout: FeatureRollout,
  tenantIds: number[],
  updatedBy: string,
): Promise<void> {
  const clean = [...new Set(tenantIds.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  await db(TABLE)
    .insert({
      key,
      rollout,
      tenant_ids: JSON.stringify(clean),
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    })
    .onConflict('key')
    .merge(['rollout', 'tenant_ids', 'updated_by', 'updated_at']);
  invalidateFeatureFlagCache();
}

/** Remove a flag's row entirely — it reverts to 'off'. Used to clear orphans. */
export async function deleteFlagRow(db: Knex | Knex.Transaction, key: string): Promise<number> {
  const n = await db(TABLE).where({ key }).del();
  invalidateFeatureFlagCache();
  return n;
}

/**
 * Strip a tenant from every flag's audience. Called by the GDPR purge, which
 * enumerates tables by their `tenant_id` COLUMN and therefore cannot see this
 * one — the id would otherwise sit in the arrays forever.
 */
export async function removeTenantFromAllFlags(db: Knex | Knex.Transaction, tenantId: number): Promise<void> {
  const rows = await db(TABLE).select('key', 'tenant_ids');
  for (const r of rows as Array<{ key: string; tenant_ids: unknown }>) {
    const ids = normalizeTenantIds(r.tenant_ids);
    if (!ids.includes(tenantId)) continue;
    await db(TABLE)
      .where({ key: r.key })
      .update({ tenant_ids: JSON.stringify(ids.filter((id) => id !== tenantId)) });
  }
  invalidateFeatureFlagCache();
}

// ---------------------------------------------------------------------------
// Who may change a rollout
// ---------------------------------------------------------------------------

/**
 * Platform operators are listed in the environment, not the database, and not
 * derived from a tenant role — see the reasoning on `platformOperatorEmails`.
 * An empty allowlist means nobody, which is why a fresh deployment cannot have
 * its flag console opened by whoever registers first.
 */
export function isPlatformOperator(email: string | undefined): boolean {
  if (!email) return false;
  return platformOperatorEmails().includes(email.toLowerCase());
}

/**
 * Is the CURRENT release train switched on for this tenant?
 *
 * The one call site shape for gating new user-visible work. Naming the key
 * inline would mean every call site becomes stale the moment the next train
 * opens; this way opening one is a single edit to CURRENT_RELEASE.
 */
export async function isCurrentReleaseEnabled(
  tenantId: number | undefined,
  db?: Knex | Knex.Transaction,
): Promise<boolean> {
  return isFeatureEnabled(tenantId, CURRENT_RELEASE as FeatureKey, db);
}

/** True when the deployment has no operators configured at all. */
export function operatorsConfigured(): boolean {
  return platformOperatorEmails().length > 0;
}
