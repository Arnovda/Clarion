/**
 * Cross-process cache invalidation.
 *
 * Three read caches live in module memory and are invalidated from ONE place —
 * `transformationRunner`'s success block:
 *   • widgetCache          (5-min TTL)  — dashboard widget rows
 *   • filterOptionsCache   (30-min TTL) — filter dropdown values
 *   • DuckDBPool           (30-min TTL) — pooled sessions holding VIEWS over the
 *                                         pre-refresh file set
 *
 * Today the refresh runs in the same process as the API, so clearing them
 * locally is enough. Once transformations run in the jobs-worker container,
 * that same call clears the WORKER's caches — which nothing reads — while the
 * API keeps serving pre-refresh data. There is no error and no log: just stale
 * dashboards for up to the TTL, and (for the DuckDB pool, which caches
 * registered views rather than rows) possible hard query errors when a refresh
 * changed the schema.
 *
 * This module turns that single choke point into a broadcast. Redis pub/sub is
 * the right primitive here — unlike cancellation, there is no polling hook to
 * piggyback on and staleness must clear promptly. A subscriber connection can't
 * issue normal commands, so we `duplicate()` the shared client rather than
 * reusing it.
 *
 * No Redis (local dev) → publish is a no-op and the local invalidation that
 * already happens in-process remains correct.
 */

import { getRedisConnection } from './redis';
import { logger as rootLogger } from '../utils/logger';
import type IORedis from 'ioredis';

const log = rootLogger.child({ mod: 'cache-bus' });

const CHANNEL = 'clarion:cache-invalidate';

export interface InvalidationMessage {
  /** Tenant whose cached rows/options should be dropped. */
  tenantId?: number;
  /** Warehouse path prefix whose pooled DuckDB sessions must be rebuilt. */
  warehousePath?: string;
  /** Emitting process, for logging/debugging. */
  origin?: string;
}

let subscriber: IORedis | null = null;

/**
 * Broadcast an invalidation. Callers should ALSO invalidate locally — the
 * publisher does not receive its own message.
 */
export function publishInvalidation(msg: InvalidationMessage): void {
  const redis = getRedisConnection();
  if (!redis) return;
  const payload = JSON.stringify({ ...msg, origin: msg.origin ?? process.env.ROLE ?? 'all' });
  redis.publish(CHANNEL, payload).catch((err) => {
    log.error({ err, msg }, 'Failed to publish cache invalidation');
  });
}

/**
 * Listen for invalidations from other processes and apply them locally.
 * Idempotent; safe to call once at startup in every role.
 */
export function subscribeToInvalidations(): void {
  if (subscriber) return;
  const redis = getRedisConnection();
  if (!redis) return;

  subscriber = redis.duplicate();

  subscriber.on('error', (err) => log.error({ err }, 'Cache-bus subscriber error'));

  subscriber.subscribe(CHANNEL).catch((err) => {
    log.error({ err }, 'Failed to subscribe to cache invalidations');
  });

  subscriber.on('message', (_channel: string, raw: string) => {
    void (async () => {
      let msg: InvalidationMessage;
      try {
        msg = JSON.parse(raw) as InvalidationMessage;
      } catch {
        return;
      }
      try {
        // Imported lazily so this module stays dependency-light and avoids a
        // cycle with the connector layer.
        if (msg.tenantId != null) {
          const { invalidateWidgetCache } = await import('../services/widgetCache');
          const { invalidateFilterOptionsCache } = await import('../services/filterOptionsCache');
          invalidateWidgetCache(msg.tenantId);
          invalidateFilterOptionsCache(msg.tenantId);
        }
        if (msg.warehousePath) {
          const { DuckDBConnector } = await import('../connectors/DuckDBConnector');
          await DuckDBConnector.invalidateWarehouse(msg.warehousePath);
        }
        log.debug({ msg }, 'Applied remote cache invalidation');
      } catch (err) {
        log.error({ err, msg }, 'Failed to apply remote cache invalidation');
      }
    })();
  });

  log.info('Subscribed to cross-process cache invalidations');
}

/** For graceful shutdown. */
export async function closeCacheBus(): Promise<void> {
  if (!subscriber) return;
  try { await subscriber.quit(); } catch { /* ignore */ }
  subscriber = null;
}
