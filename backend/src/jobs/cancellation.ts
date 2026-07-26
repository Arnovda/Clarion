/**
 * Job cancellation registry — lets an HTTP handler tell an active worker to
 * abort, whether or not that worker runs in the same process.
 *
 * Pattern:
 *   - Worker calls registerJobAbortController(jobId, controller) at start.
 *   - Worker checks isJobCancelled(jobId) at safe checkpoints AND passes
 *     controller.signal into long-running primitives (AI streams, etc).
 *   - HTTP cancel endpoint calls cancelJob(jobId) which flips the flag locally,
 *     aborts a local controller if present, AND records the intent in Redis.
 *   - Worker calls unregisterJob(jobId) on completion (success or failure).
 *
 * CROSS-PROCESS: the in-memory Set/Map alone only works when the API and the
 * worker share a process. Once BullMQ workers run in their own container, the
 * API's `cancelJob` writes a flag the worker never reads, so a running job
 * becomes uncancellable while the UI reports success. Redis is therefore the
 * authoritative channel: `cancelJob` SETs a key, and `isJobCancelled` reads it.
 *
 * A plain key (not pub/sub) is deliberate: the orchestrator's `isCancelled`
 * hook is already `() => boolean | Promise<boolean>` and is awaited at every
 * checkpoint, so a key read drops in with no subscriber connection to manage.
 * For aborting an in-flight AI stream (which no checkpoint can interrupt) the
 * worker runs a short poll — see `watchForCancellation`.
 *
 * Degrades to the previous in-memory behaviour when REDIS_URL is unset (local
 * dev inline execution), so nothing regresses there.
 */

import { getRedisConnection } from './redis';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'cancellation' });

const controllers = new Map<string, AbortController>();
const cancelledFlags = new Set<string>();

/** Cancellation intent outlives the job long enough to be seen, then expires. */
const CANCEL_TTL_SECONDS = 24 * 60 * 60;

function cancelKey(jobId: string): string {
  return `job-cancel:${jobId}`;
}

export function registerJobAbortController(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

export function unregisterJob(jobId: string): void {
  controllers.delete(jobId);
  cancelledFlags.delete(jobId);
  // Best-effort cleanup so a re-used job id can't inherit a stale flag.
  const redis = getRedisConnection();
  if (redis) {
    redis.del(cancelKey(jobId)).catch(() => { /* non-fatal */ });
  }
}

/**
 * Request cancellation. Returns true when a controller in THIS process was
 * aborted (i.e. the job is running here). A false return no longer means
 * "nothing happened" — with Redis configured the intent is recorded and the
 * owning worker will pick it up at its next checkpoint or poll.
 */
export function cancelJob(jobId: string): boolean {
  cancelledFlags.add(jobId);

  const redis = getRedisConnection();
  if (redis) {
    redis.set(cancelKey(jobId), '1', 'EX', CANCEL_TTL_SECONDS).catch((err) => {
      log.error({ err, jobId }, 'Failed to record cancellation intent in Redis');
    });
  }

  const controller = controllers.get(jobId);
  if (controller) {
    try { controller.abort(); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Whether cancellation has been requested. Checks the local flag first (cheap,
 * and covers the no-Redis path), then Redis so a request made in another
 * process is honoured.
 */
export async function isJobCancelled(jobId: string): Promise<boolean> {
  if (cancelledFlags.has(jobId)) return true;
  const redis = getRedisConnection();
  if (!redis) return false;
  try {
    const v = await redis.get(cancelKey(jobId));
    if (v) {
      // Cache locally so subsequent checkpoints don't re-hit Redis.
      cancelledFlags.add(jobId);
      return true;
    }
  } catch (err) {
    // A Redis blip must not look like "cancelled" — fail open.
    log.warn({ err, jobId }, 'Cancellation check failed; treating as not cancelled');
  }
  return false;
}

/** Synchronous local-only check (no Redis round-trip). */
export function isJobCancelledLocal(jobId: string): boolean {
  return cancelledFlags.has(jobId);
}

/**
 * Poll Redis for a cancellation request and abort the local controller when one
 * arrives. Checkpoints alone can't interrupt an in-flight AI stream — only
 * `AbortController.abort()` can — and after the split the abort must be driven
 * by the worker itself. Returns a stop function; call it in a `finally`.
 */
export function watchForCancellation(jobId: string, intervalMs = 3000): () => void {
  const redis = getRedisConnection();
  if (!redis) return () => { /* nothing to watch without Redis */ };

  const timer = setInterval(() => {
    void (async () => {
      try {
        const v = await redis.get(cancelKey(jobId));
        if (!v) return;
        cancelledFlags.add(jobId);
        const controller = controllers.get(jobId);
        if (controller && !controller.signal.aborted) {
          log.info({ jobId }, 'Cancellation requested elsewhere — aborting local job');
          try { controller.abort(); } catch { /* ignore */ }
        }
      } catch { /* transient — try again next tick */ }
    })();
  }, intervalMs);
  if (timer.unref) timer.unref();

  return () => clearInterval(timer);
}
