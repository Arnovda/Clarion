/**
 * Job cancellation registry — lets HTTP handlers tell active workers
 * (running in the same process) to abort.
 *
 * Pattern:
 *   - Worker calls registerJobAbortController(jobId, controller) at start.
 *   - Worker checks isJobCancelled(jobId) at safe checkpoints AND passes
 *     controller.signal into long-running primitives (AI streams, etc).
 *   - HTTP cancel endpoint calls cancelJob(jobId) which both flips the flag
 *     and aborts the controller.
 *   - Worker calls unregisterJob(jobId) on completion (success or failure).
 *
 * Single-process only — sufficient for the current Azure single-replica
 * deployment. For multi-replica, replace the in-memory Map with Redis
 * pub/sub (e.g. SUBSCRIBE bus-matrix:cancel:<jobId>).
 */

const controllers = new Map<string, AbortController>();
const cancelledFlags = new Set<string>();

export function registerJobAbortController(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

export function unregisterJob(jobId: string): void {
  controllers.delete(jobId);
  cancelledFlags.delete(jobId);
}

export function cancelJob(jobId: string): boolean {
  cancelledFlags.add(jobId);
  const controller = controllers.get(jobId);
  if (controller) {
    try { controller.abort(); } catch { /* ignore */ }
    return true;
  }
  // Job not yet started (still waiting in queue). The flag will be picked up
  // when the worker first calls isJobCancelled().
  return false;
}

export function isJobCancelled(jobId: string): boolean {
  return cancelledFlags.has(jobId);
}
