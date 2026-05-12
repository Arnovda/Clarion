/**
 * Filter dropdown options cache.
 *
 * Each dashboard filter dropdown asks the question "give me the distinct
 * values of column X in table Y so the user can pick one." That SQL is
 * cheap individually but slow on the user perception scale — every filter
 * dropdown open is a network round-trip + a DuckDB DISTINCT scan.
 *
 * Filter options change ONLY when underlying data refreshes, which we
 * already have a hook for (transformationRunner invalidates the widget
 * cache; we invalidate this too). Between refreshes the same dropdown
 * always returns the same list, so caching is correct.
 *
 * Storage model:
 *   - In-memory Map. No Postgres table needed; the cache rebuilds itself
 *     organically on backend restart from the first access.
 *   - Key: `<tenantId>:<connectionId>:<table>:<column>`.
 *   - TTL: 30 minutes (longer than widget cache because filter values
 *     change less often than aggregates). Refresh invalidation is the
 *     authoritative trigger; TTL is just defence-in-depth.
 *
 * NOT cached: high-cardinality (>=100 distinct values) lists where we
 *   already truncate at the query level. A typeahead surface should
 *   bypass this cache entirely — separate concern.
 */

const TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  options: string[];
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

function buildKey(tenantId: number, connectionId: number, table: string, column: string): string {
  return `${tenantId}:${connectionId}:${table}:${column}`;
}

export function getFilterOptionsCache(
  tenantId: number,
  connectionId: number,
  table: string,
  column: string,
): string[] | null {
  const k = buildKey(tenantId, connectionId, table, column);
  const entry = store.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(k);
    return null;
  }
  return entry.options;
}

export function putFilterOptionsCache(
  tenantId: number,
  connectionId: number,
  table: string,
  column: string,
  options: string[],
): void {
  store.set(buildKey(tenantId, connectionId, table, column), {
    options,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Drop every cached filter list for a tenant. Called from the
 * transformation runner after a successful refresh so the next filter
 * dropdown sees the new values.
 */
export function invalidateFilterOptionsCache(tenantId: number): void {
  const prefix = `${tenantId}:`;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

/** Test helper — current store size. */
export function _filterOptionsCacheSize(): number {
  return store.size;
}
