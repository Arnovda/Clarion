/**
 * Schedule reconciler — re-registers BullMQ repeatable jobs after Redis loses
 * its state.
 *
 * Why this exists instead of Redis persistence: Postgres is already the source
 * of truth for every schedule (transformation, email, connection-sync,
 * pipeline), and each `load*Schedules()` re-registers idempotently at boot. So
 * losing Redis is self-healing — on the next backend start the repeatables come
 * back. The one gap is a Redis restart WITHOUT a backend restart: the
 * repeatables are gone but nothing re-adds them, so cron-driven work silently
 * stops until someone restarts the API.
 *
 * Enabling AOF on the Redis container would not fix this: Container Apps have
 * an ephemeral filesystem, so the AOF file dies with the container anyway
 * (and Redis fsync on an Azure Files mount is a known latency trap). Detecting
 * the reconnect and replaying from Postgres is both cheaper and more correct.
 *
 * IORedis emits 'ready' on the first connect too; we ignore that one because
 * startup already loads the schedules, and debounce the rest so a reconnect
 * storm triggers a single reconciliation.
 */

import { getRedisConnection } from './redis';
import { loadSchedules } from './scheduler';
import { loadEmailSchedules } from './emailScheduler';
import { loadConnectionSyncSchedules } from './connectionSyncScheduler';
import { loadPipelineSchedules } from './pipelineScheduler';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'schedule-reconciler' });

const DEBOUNCE_MS = 5_000;

let started = false;
let sawFirstReady = false;
let timer: NodeJS.Timeout | null = null;

/** Re-register every schedule type from Postgres. Idempotent. */
export async function reconcileSchedules(reason: string): Promise<void> {
  log.info({ reason }, 'Reconciling BullMQ repeatable jobs from Postgres');
  const results = await Promise.allSettled([
    loadSchedules(),
    loadEmailSchedules(),
    loadConnectionSyncSchedules(),
    loadPipelineSchedules(),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    for (const f of failed) {
      log.error({ err: (f as PromiseRejectedResult).reason }, 'Schedule reconciliation partially failed');
    }
  } else {
    log.info({ reason }, 'Schedule reconciliation complete');
  }
}

/**
 * Watch the shared Redis connection and reconcile after a reconnect.
 * No-op when Redis isn't configured (inline execution mode).
 */
export function startScheduleReconciler(): void {
  if (started) return;
  const conn = getRedisConnection();
  if (!conn) return;
  started = true;

  conn.on('ready', () => {
    if (!sawFirstReady) {
      // Startup path — index.ts already loaded the schedules.
      sawFirstReady = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reconcileSchedules('redis-reconnect').catch((err) =>
        log.error({ err }, 'Schedule reconciliation failed after Redis reconnect'),
      );
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
  });

  log.info('Schedule reconciler armed (re-registers repeatables after a Redis reconnect)');
}

/** For tests / shutdown. */
export function stopScheduleReconciler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
  sawFirstReady = false;
}
