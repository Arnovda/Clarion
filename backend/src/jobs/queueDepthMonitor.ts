/**
 * queueDepthMonitor.ts — queue-depth visibility (P1-6; deferred here from
 * P0-6, where `.ops/alerts` records why: Azure has no metric for BullMQ, so
 * depth needs an exporter on our side).
 *
 * Every minute (QUEUE_DEPTH_CHECK_MS) the API reads the waiting/delayed/
 * active counts of the work queues straight from BullMQ — Redis is the
 * truth, so ONE process must emit or every replica double-counts; this runs
 * beside the reapers under the same RUN_SCHEDULERS gate. Each sweep ships
 * the counts to App Insights (`queue_depth` metric, `queue` dimension) for
 * graphs, and when a queue's WAITING count reaches QUEUE_DEPTH_WARN it logs
 * one warn line the alert rule matches.
 *
 * Waiting — not delayed, not active — is the alarm signal on purpose:
 * delayed holds legitimate scheduled work and P1-1 fairness retries, and
 * active is bounded by concurrency. A deep WAITING list means consumers are
 * dead or drowning — the dead-consumer case is also covered by /api/health's
 * queue-listener probe, but that only fires when a deploy asks; this fires
 * while nobody is deploying.
 */

import type { Queue } from 'bullmq';
import { getRedisConnection } from './redis';
import {
  getSchemaProfilingQueue,
  getIngestionQueue,
  getTransformationQueue,
  getBusMatrixQueue,
  getEmailReportQueue,
} from './queues';
import { trackMetric } from '../utils/monitoring';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'queueDepthMonitor' });

export interface QueueDepth {
  queue: string;
  waiting: number;
  delayed: number;
  active: number;
  warn: boolean;
}

function warnThreshold(): number {
  const n = Number(process.env.QUEUE_DEPTH_WARN);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function checkIntervalMs(): number {
  const n = Number(process.env.QUEUE_DEPTH_CHECK_MS);
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000;
}

/** Just the part of a BullMQ queue this module reads — injectable for tests. */
export interface DepthReadableQueue {
  name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

/**
 * Read every provided queue's counts and decide which are worth a warning.
 * Pure aside from the queue reads; a queue that errors is SKIPPED (one dead
 * queue client must not hide the others' depths).
 */
export async function checkQueueDepths(
  queues: DepthReadableQueue[],
  warnAt: number = warnThreshold(),
): Promise<QueueDepth[]> {
  const out: QueueDepth[] = [];
  for (const q of queues) {
    try {
      const counts = await q.getJobCounts('wait', 'delayed', 'active');
      const waiting = Number(counts.wait ?? 0);
      out.push({
        queue: q.name,
        waiting,
        delayed: Number(counts.delayed ?? 0),
        active: Number(counts.active ?? 0),
        warn: waiting >= warnAt,
      });
    } catch (err) {
      log.debug({ err, queue: q.name }, 'queue depth read failed');
    }
  }
  return out;
}

function workQueues(): DepthReadableQueue[] {
  return [
    getSchemaProfilingQueue(),
    getIngestionQueue(),
    getTransformationQueue(),
    getBusMatrixQueue(),
    getEmailReportQueue(),
  ].filter((q): q is Queue => q != null);
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the periodic sweep. No-op without Redis (no queues to measure) or if
 * already started. Call from the ONE process that owns schedulers.
 */
export function startQueueDepthMonitor(): void {
  if (timer || !getRedisConnection()) return;
  const interval = checkIntervalMs();
  timer = setInterval(async () => {
    try {
      const depths = await checkQueueDepths(workQueues());
      for (const d of depths) {
        trackMetric('queue_depth', d.waiting, { queue: d.queue, delayed: String(d.delayed), active: String(d.active) });
        if (d.warn) {
          // LOAD-BEARING STRING: the .ops/alerts `clarion-queue-depth` rule
          // matches 'queue depth high' — reword it and the alert goes
          // silently blind (same covenant as requestLogger's
          // 'request failed' and SyncOrchestrator's 'sync run failed').
          log.warn(
            { queue: d.queue, waiting: d.waiting, delayed: d.delayed, active: d.active },
            'queue depth high',
          );
        }
      }
    } catch (err) {
      log.debug({ err }, 'queue depth sweep failed');
    }
  }, interval);
  timer.unref?.();
  log.info({ intervalMs: interval, warnAt: warnThreshold() }, 'queue depth monitor started');
}

export function stopQueueDepthMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
