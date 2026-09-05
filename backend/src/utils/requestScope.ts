/**
 * requestScope.ts — the one AsyncLocalStorage every request and every job
 * runs inside, and the CORRELATION ID that rides it (assessment 6-1).
 *
 * `requestId` is minted (or forwarded from X-Request-ID) by requestLogger
 * for every HTTP request. Until 2026-09-05 it stopped at the route: a job
 * enqueued by that request, the worker that ran it, and the sync child
 * process it launched knew nothing of it, so "my sync failed at 14:02"
 * meant guessing which of N jobs was theirs. Now:
 *
 *  - requireAuth puts `requestId` in this scope;
 *  - every Queue stamps it into job data at `add()` (jobs/queues.ts);
 *  - every worker re-enters the scope from job data (jobs/workers.ts), with
 *    `jobId` beside it;
 *  - the pino logger's `mixin` writes both onto EVERY log line emitted
 *    inside the scope — request path and job path alike — with no per-site
 *    change;
 *  - the sync orchestrator records it on `source_sync_runs.request_id` and
 *    hands it to the worker child as WORKER_REQUEST_ID.
 *
 * So one id, read off a customer's error on the operator console, finds
 * the request, the job, the worker log lines and the sync run.
 *
 * This module has NO imports on purpose: utils/logger.ts reads it from its
 * mixin, and everything imports the logger.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestScope {
  tenantId: number;
  /** User attribution — optional so background jobs can run without a user. */
  userId?: number | null;
  /** The HTTP request this work descends from, if any. */
  requestId?: string;
  /** The BullMQ job this work runs as, if any. */
  jobId?: string;
  /** Queue name, beside jobId. */
  queue?: string;
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

/** The correlation fields of the current scope — for logs, job data, run rows. */
export function getCorrelation(): { requestId?: string; jobId?: string; queue?: string } {
  const s = requestScope.getStore();
  if (!s) return {};
  const out: { requestId?: string; jobId?: string; queue?: string } = {};
  if (s.requestId) out.requestId = s.requestId;
  if (s.jobId) out.jobId = s.jobId;
  if (s.queue) out.queue = s.queue;
  return out;
}
