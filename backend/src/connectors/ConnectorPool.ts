/**
 * ConnectorPool — Reuse source database connectors instead of creating new ones
 * for every request.
 *
 * Connectors are cached by connection ID. Each entry has an idle timeout;
 * if not used within that window the connector is disconnected and removed.
 *
 * Thread-safe for single-process Node.js (no mutex needed).
 */

import { BaseConnector } from './BaseConnector';
import { createConnector } from './ConnectorFactory';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'connector-pool' });

interface PoolEntry {
  connector: BaseConnector;
  lastUsed: number;
  connectionId: number;
}

const pool = new Map<number, PoolEntry>();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_POOL_SIZE = 20;

/**
 * Get or create a connector for the given connection row.
 * The connector is connected and ready to use.
 */
export async function getPooledConnector(conn: {
  id: number;
  type: string;
  config: string | Record<string, unknown>;
  query_engine?: string;
  warehouse_path?: string | null;
  ingestion_status?: string | null;
}): Promise<BaseConnector> {
  const existing = pool.get(conn.id);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.connector;
  }

  // Evict oldest if pool is full
  if (pool.size >= MAX_POOL_SIZE) {
    let oldestId = -1;
    let oldestTime = Infinity;
    for (const [id, entry] of pool) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId >= 0) {
      await evict(oldestId);
    }
  }

  const connector = await createConnector(conn);
  await connector.connect();

  pool.set(conn.id, {
    connector,
    lastUsed: Date.now(),
    connectionId: conn.id,
  });

  log.debug({ connectionId: conn.id, poolSize: pool.size }, 'Connector added to pool');
  return connector;
}

/**
 * Remove a connector from the pool and disconnect it.
 */
export async function evict(connectionId: number): Promise<void> {
  const entry = pool.get(connectionId);
  if (!entry) return;

  pool.delete(connectionId);
  try {
    entry.connector.disconnect();
  } catch (err) {
    log.warn({ err, connectionId }, 'Error disconnecting pooled connector');
  }
}

/**
 * Evict all idle connectors that haven't been used recently.
 * Called periodically from a timer.
 */
function evictIdle(): void {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, entry] of pool) {
    if (entry.lastUsed < cutoff) {
      pool.delete(id);
      try {
        entry.connector.disconnect();
        log.debug({ connectionId: id }, 'Idle connector evicted');
      } catch {
        // Ignore disconnect errors during cleanup
      }
    }
  }
}

/**
 * Disconnect all pooled connectors. Call on shutdown.
 */
export async function drainPool(): Promise<void> {
  for (const [id, entry] of pool) {
    try {
      entry.connector.disconnect();
    } catch {
      // Ignore
    }
  }
  pool.clear();
  log.info('Connector pool drained');
}

// Periodic idle cleanup every 60 seconds
const _cleanupInterval = setInterval(evictIdle, 60_000);
// Don't let the timer keep the process alive
if (_cleanupInterval.unref) _cleanupInterval.unref();
