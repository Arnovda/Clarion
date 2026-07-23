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
  /** In-flight queries currently executing against this shared instance. An
   *  entry with active > 0 must never be closed — doing so aborts every
   *  concurrent query on it. */
  active: number;
  /** Set when the entry has been removed from the pool (invalidated) while a
   *  query was still running; its db is closed once `active` returns to 0. */
  retired?: boolean;
}

const entries = new Map<string, PoolEntry>();
const inFlight = new Map<string, Promise<PoolEntry>>();
// Entries removed from the pool while still executing a query — closed later by
// endQuery() when their last in-flight query settles.
const retiring = new Set<PoolEntry>();

/** Mark the start of a query against a pooled entry. Returns the entry (so the
 *  caller can pass it back to endQuery) or null if the key isn't pooled. */
export function beginQuery(key: string): PoolEntry | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.active += 1;
  entry.lastUsed = Date.now();
  return entry;
}

/** Mark the end of a query. Closes the db if the entry was retired mid-flight
 *  and this was its last in-flight query. */
export function endQuery(entry: PoolEntry | null): void {
  if (!entry) return;
  entry.active -= 1;
  if (entry.retired && entry.active <= 0) {
    retiring.delete(entry);
    entry.db.close().catch(() => { /* ignore */ });
  }
}

/** Close an entry now if idle, or defer the close until its queries finish. */
function closeOrDefer(entry: PoolEntry): void {
  if (entry.active > 0) {
    entry.retired = true;
    retiring.add(entry);
  } else {
    entry.db.close().catch((err) => log.warn({ err }, 'Error closing DuckDB'));
  }
}

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
      active: 0,
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
    // Remove from the pool immediately so the next query rebuilds fresh views,
    // but defer closing the db if a query is still running on it.
    closeOrDefer(entry);
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
    // Never evict an entry that is initialising or executing a query — closing
    // it would abort every concurrent query on the shared instance. The pool
    // may briefly exceed the cap when all entries are busy; that's acceptable.
    if (inFlight.has(key) || entry.active > 0) continue;
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
    // Skip entries with a query still running (lastUsed is bumped at query
    // start, so a long-running query keeps its entry fresh anyway).
    if (entry.lastUsed < cutoff && entry.active === 0) stale.push(key);
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
