/**
 * cache.ts — In-memory TTL cache with optional Redis backing.
 *
 * Falls back to a simple in-process Map when REDIS_URL is not set.
 * Designed for hot-path reads: semantic context, connection metadata, etc.
 */

import { getRedisConnection } from '../jobs/redis';
import { logger } from './logger';

const log = logger.child({ module: 'cache' });

// ---------------------------------------------------------------------------
// In-memory fallback (LRU-ish with TTL expiry)
// ---------------------------------------------------------------------------

interface MemEntry {
  value: string;
  expiresAt: number;
}

const memCache = new Map<string, MemEntry>();
const MAX_MEM_ENTRIES = 500;

function memGet(key: string): string | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlMs: number): void {
  // Evict oldest entries if we hit the cap
  if (memCache.size >= MAX_MEM_ENTRIES) {
    const firstKey = memCache.keys().next().value;
    if (firstKey !== undefined) memCache.delete(firstKey);
  }
  memCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function memDel(pattern: string): number {
  let count = 0;
  // Simple prefix match (pattern ends with *)
  const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
  for (const key of memCache.keys()) {
    if (key.startsWith(prefix) || key === pattern) {
      memCache.delete(key);
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Unified cache API
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get a cached value. Returns null on miss.
 */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const redis = getRedisConnection();

  if (redis) {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      log.warn({ err, key }, 'Redis GET failed, falling back to memory');
    }
  }

  const raw = memGet(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

/**
 * Set a cached value with a TTL (default 5 min).
 */
export async function cacheSet(key: string, value: unknown, ttlMs = DEFAULT_TTL_MS): Promise<void> {
  const serialized = JSON.stringify(value);
  const redis = getRedisConnection();

  if (redis) {
    try {
      await redis.set(key, serialized, 'PX', ttlMs);
      return;
    } catch (err) {
      log.warn({ err, key }, 'Redis SET failed, falling back to memory');
    }
  }

  memSet(key, serialized, ttlMs);
}

/**
 * Invalidate cache entries matching a prefix pattern.
 * Pattern should end with * for prefix matching, e.g. "semantic:conn:5:*"
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  const redis = getRedisConnection();

  if (redis) {
    try {
      // Use SCAN to find matching keys (safe for production, unlike KEYS)
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
      return;
    } catch (err) {
      log.warn({ err, pattern }, 'Redis invalidation failed, clearing memory');
    }
  }

  const count = memDel(pattern);
  if (count > 0) log.debug({ pattern, count }, 'Memory cache entries invalidated');
}

/**
 * Cache-through helper: returns cached value or calls loader, caches the result.
 */
export async function cacheThrough<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;

  const value = await loader();
  await cacheSet(key, value, ttlMs);
  return value;
}

// ---------------------------------------------------------------------------
// Cache key builders — centralised to avoid typos
// ---------------------------------------------------------------------------

export const CacheKeys = {
  semanticContext: (connectionId: number, domains?: string[]) => {
    const domainSuffix = domains?.length ? `:d=${domains.sort().join(',')}` : '';
    return `semantic:ctx:${connectionId}${domainSuffix}`;
  },
  connectionMeta: (connectionId: number) => `conn:meta:${connectionId}`,
  connectionAll: (tenantId: number) => `conn:all:${tenantId}`,
  dimensionColumns: (connectionId: number) => `semantic:dims:${connectionId}`,
  joinPaths: (connectionId: number) => `semantic:joins:${connectionId}`,
  /** Pattern to invalidate everything for a connection */
  connectionPattern: (connectionId: number) => `*:${connectionId}*`,
  semanticPattern: (connectionId: number) => `semantic:*:${connectionId}*`,
};
