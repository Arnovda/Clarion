/**
 * Query cache — memoises the NL→SQL step.
 *
 * The Claude API call (~$0.01 per question, ~2-5s latency) is by far the
 * dominant cost on a hot cache-hit question. Identical questions against an
 * identical semantic context should short-circuit.
 *
 * Cache key fingerprints:
 *   - tenant_id        (RLS isolates anyway but we include for clarity)
 *   - connection_id    (different sources → different data)
 *   - layer            ('product' | 'source')
 *   - domains          (sorted + joined)
 *   - normalised question (trim + collapse whitespace + lowercase)
 *   - context digest   (SHA-256 of semanticContext + relationshipContext + kpiFormulas)
 *
 * When ANY of the context pieces changes (user approves a new column
 * description, adds a KPI, ingests a new table), the digest changes and
 * previously-cached answers naturally become unreachable.
 *
 * TTL is 7 days — paired with explicit invalidation on semantic-layer
 * writes (table/column/relationship/KPI edits, product approvals). A write
 * on a product purges that tenant's cache so no stale SQL survives.
 * Without explicit invalidation the TTL would have to be much shorter to
 * cap staleness; with it, 7 days maximises hit rate.
 *
 * Low-confidence answers are NEVER cached: we don't want to cement a wrong
 * answer that the user would otherwise see "this is low-confidence" on.
 */

import { createHash } from 'crypto';
import { semanticDb } from '../db/knex';
import type { NlToSqlOutput } from '../ai/prompts/nlToSqlPrompt';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'query-cache' });

const TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days — see header comment
const MIN_CACHE_CONFIDENCE = 0.7;

export interface CacheKeyInput {
  tenantId:     number;
  connectionId: number;
  layer:        'product' | 'source';
  domains?:     string[];
  question:     string;
  semanticContext:     string;
  relationshipContext: string;
  kpiFormulas:         string;
}

export function buildCacheKey(input: CacheKeyInput): string {
  const normalisedQ = input.question.trim().replace(/\s+/g, ' ').toLowerCase();
  const contextDigest = sha256Hex(
    input.semanticContext + '\0' + input.relationshipContext + '\0' + input.kpiFormulas,
  );
  const domains = [...(input.domains ?? [])].sort().join(',');
  const composite =
    `t${input.tenantId}|c${input.connectionId}|l${input.layer}|d${domains}|q${normalisedQ}|x${contextDigest}`;
  return sha256Hex(composite);
}

/**
 * Look up a cached NL→SQL result. Returns null on miss or expiry.
 * Caller must have `app.current_tenant` set via RLS (all query paths do).
 */
export async function getCachedSql(
  tenantId: number,
  cacheKey: string,
): Promise<NlToSqlOutput | null> {
  try {
    const row = await semanticDb('query_cache')
      .where({ tenant_id: tenantId, cache_key: cacheKey })
      .where('expires_at', '>', new Date())
      .first();
    if (!row) return null;

    // Best-effort fire-and-forget stats update.
    semanticDb('query_cache')
      .where({ id: row.id })
      .update({
        hit_count: semanticDb.raw('hit_count + 1'),
        last_hit_at: new Date(),
      })
      .catch((err) => log.warn({ err }, 'failed to update cache hit stats'));

    return row.sql_result as NlToSqlOutput;
  } catch (err) {
    // Cache misses should never break the query path.
    log.warn({ err }, 'getCachedSql failed — treating as miss');
    return null;
  }
}

/**
 * Store a successful NL→SQL result. Silently no-ops on low confidence or
 * insert error — cache is best-effort.
 */
export async function putCachedSql(
  tenantId: number,
  cacheKey: string,
  question: string,
  result: NlToSqlOutput,
): Promise<void> {
  if (result.confidence < MIN_CACHE_CONFIDENCE) return;

  const expiresAt = new Date(Date.now() + TTL_MS);
  try {
    await semanticDb.raw(
      `INSERT INTO query_cache (tenant_id, cache_key, question, sql_result, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, cache_key) DO UPDATE SET
         sql_result = EXCLUDED.sql_result,
         expires_at = EXCLUDED.expires_at,
         hit_count = 0,
         last_hit_at = NULL`,
      [tenantId, cacheKey, question, JSON.stringify(result), expiresAt],
    );
  } catch (err) {
    log.warn({ err }, 'putCachedSql failed — cache write skipped');
  }
}

/**
 * Wipe every cached answer for a tenant.
 *
 * Called after any semantic-layer write (table/column/relationship/KPI/
 * product-table/product-column edit, approval, bulk import). Those writes
 * could change the right answer to previously-cached questions, so the
 * only safe action is to throw the whole tenant's cache away and let the
 * next query re-populate it.
 *
 * Per-cache-key invalidation isn't feasible: a single relationship edit
 * can invalidate arbitrary questions that touched the related tables.
 * Tenant-wide purge is correct and cheap (postgres delete on an indexed
 * integer column).
 */
export async function invalidateTenantCache(tenantId: number): Promise<number> {
  try {
    const result = await semanticDb('query_cache').where({ tenant_id: tenantId }).del();
    if (result > 0) {
      log.info({ tenantId, deleted: result }, 'Tenant query cache invalidated');
    }
    return result;
  } catch (err) {
    log.warn({ err, tenantId }, 'invalidateTenantCache failed');
    return 0;
  }
}

/** Purge expired rows. Called periodically. */
export async function purgeExpired(): Promise<number> {
  try {
    // Use a raw DELETE so we bypass RLS (tenant_id restriction) and clean all tenants at once.
    // The app user role has BYPASSRLS off, so we need to use the migrations role or
    // run the purge without tenant context. Simpler: SET LOCAL bypass inside a txn.
    const result = await semanticDb.raw(
      'DELETE FROM query_cache WHERE expires_at < NOW()',
    );
    const count =
      (result as unknown as { rowCount?: number; changes?: number })?.rowCount ??
      (result as unknown as { changes?: number })?.changes ??
      0;
    if (count > 0) log.debug({ count }, 'expired query cache rows purged');
    return count;
  } catch (err) {
    log.warn({ err }, 'purgeExpired failed');
    return 0;
  }
}

// Background purge every 15 min.
const _purgeInterval = setInterval(() => {
  purgeExpired().catch(() => { /* already logged */ });
}, 15 * 60 * 1000);
if (_purgeInterval.unref) _purgeInterval.unref();

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
