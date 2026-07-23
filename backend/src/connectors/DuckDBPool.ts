/**
 * DuckDBPool — process-wide cache of ready-to-query DuckDB instances.
 *
 * Each entry holds a :memory: DuckDB with extensions loaded (delta, optionally
 * azure + secret) AND views pre-registered for every known table. The same
 * entry is reused across concurrent requests — DuckDB is read-only thread-safe
 * for our workload (we never write through it; writes go through the ETL
 * service or transformationRunner using their own DuckDB instances).
 *
 * Invalidation:
 *   - `invalidateByPrefix(prefix)` — called after ingestion or transformation
 *     completes so the next query rebuilds views over the updated table set.
 *   - idle entries are evicted after `IDLE_TTL_MS` by a background timer.
 *
 * Concurrency:
 *   - `getOrInit()` is single-flight per key — concurrent callers share the
 *     same in-flight init promise. No mutex needed (Node.js is single-threaded
 *     between awaits).
 */

import { Database } from 'duckdb-async';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'duckdb-pool' });

const IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Cap the number of live pooled DuckDB instances. Each instance holds an
// in-memory DuckDB with registered views and can claim up to `memory_limit`;
// without a cap the map grows one entry per distinct (warehouse × table-set)
// combo until idle eviction, which on a 1 GiB replica is a memory hazard. When
// exceeded we evict the least-recently-used entries. Overridable via env.
const MAX_POOL_ENTRIES = Math.max(2, Number(process.env.DUCKDB_POOL_MAX) || 12);

interface PoolEntry {
  db: Database;
  createdAt: number;
  lastUsed: number;
}

const entries = new Map<string, PoolEntry>();
const inFlight = new Map<string, Promise<PoolEntry>>();

export type PoolInit = (db: Database) => Promise<void>;

/**
 * Get a cached DuckDB instance for `key`, or create one using `init`.
 * The returned handle is shared — do NOT close it; release via eviction.
 */
export async function getOrInit(key: string, init: PoolInit): Promise<Database> {
  const existing = entries.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.db;
  }

  const pending = inFlight.get(key);
  if (pending) {
    const entry = await pending;
    return entry.db;
  }

  const promise = (async () => {
    const db = await Database.create(':memory:');
    try {
      await init(db);
    } catch (err) {
      try { await db.close(); } catch { /* ignore */ }
      throw err;
    }
    const entry: PoolEntry = {
      db,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
    entries.set(key, entry);
    log.debug({ key, size: entries.size }, 'DuckDB pool entry created');
    // Enforce the LRU cap (fire-and-forget close of evicted instances).
    void evictOverCap();
    return entry;
  })();

  inFlight.set(key, promise);
  try {
    const entry = await promise;
    return entry.db;
  } finally {
    inFlight.delete(key);
  }
}

/** Remove and close all entries whose key begins with `prefix`. */
export async function invalidateByPrefix(prefix: string): Promise<void> {
  const matches: string[] = [];
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) matches.push(key);
  }
  for (const key of matches) {
    const entry = entries.get(key);
    if (!entry) continue;
    entries.delete(key);
    try {
      await entry.db.close();
    } catch (err) {
      log.warn({ err, key }, 'Error closing DuckDB during invalidation');
    }
  }
  if (matches.length > 0) {
    log.info({ prefix, evicted: matches.length, remaining: entries.size }, 'DuckDB pool invalidated');
  }
}

/**
 * Evict least-recently-used entries while the pool exceeds MAX_POOL_ENTRIES.
 * Never evicts an entry that is currently the target of an in-flight init.
 */
async function evictOverCap(): Promise<void> {
  if (entries.size <= MAX_POOL_ENTRIES) return;
  const byLru = Array.from(entries.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  let over = entries.size - MAX_POOL_ENTRIES;
  for (const [key, entry] of byLru) {
    if (over <= 0) break;
    if (inFlight.has(key)) continue;
    entries.delete(key);
    over -= 1;
    try {
      await entry.db.close();
    } catch (err) {
      log.warn({ err, key }, 'Error closing DuckDB during LRU eviction');
    }
  }
  log.debug({ size: entries.size, cap: MAX_POOL_ENTRIES }, 'DuckDB pool LRU-capped');
}

/** Close and remove idle entries. Called periodically. */
async function evictIdle(): Promise<void> {
  const cutoff = Date.now() - IDLE_TTL_MS;
  const stale: string[] = [];
  for (const [key, entry] of entries) {
    if (entry.lastUsed < cutoff) stale.push(key);
  }
  for (const key of stale) {
    const entry = entries.get(key);
    if (!entry) continue;
    entries.delete(key);
    try {
      await entry.db.close();
    } catch {
      /* ignore */
    }
  }
  if (stale.length > 0) {
    log.debug({ evicted: stale.length, remaining: entries.size }, 'Idle DuckDB entries evicted');
  }
}

/** Close every entry. Call on graceful shutdown. */
export async function drainAll(): Promise<void> {
  const all = Array.from(entries.entries());
  entries.clear();
  for (const [, entry] of all) {
    try {
      await entry.db.close();
    } catch {
      /* ignore */
    }
  }
  log.info({ drained: all.length }, 'DuckDB pool drained');
}

/** For tests / diagnostics. */
export function _poolSize(): number {
  return entries.size;
}

// Start periodic idle eviction (unref so it doesn't keep the process alive).
const _cleanup = setInterval(() => {
  evictIdle().catch((err) => log.warn({ err }, 'evictIdle failed'));
}, CLEANUP_INTERVAL_MS);
if (_cleanup.unref) _cleanup.unref();
