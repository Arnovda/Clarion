/**
 * Per-tenant single-flight on the AI queues (P1-1).
 *
 * schema-profiling and bus-matrix ran at GLOBAL concurrency 1 — one
 * tenant's Analyse or build blocked every other tenant's. Concurrency
 * goes to 2 so two TENANTS proceed in parallel, and this guard keeps one
 * tenant from taking both slots: a job whose tenant already has an
 * ACTIVE job on the same queue is pushed back into the delayed set and
 * retried shortly, so the freed slot goes to somebody else's work.
 *
 * The truth is read from BullMQ's own active set — no side lock to renew
 * or leak, which matters because a bus-matrix build legitimately runs
 * for many minutes (longer than any comfortable lock TTL). The race this
 * leaves open (two jobs of ONE tenant starting in the same instant) is
 * acceptable: this is a fairness mechanism, not an isolation one — the
 * enqueue-side dedupes (one build per tenant returns 409; one profiling
 * per connection) already prevent the duplicates that would corrupt
 * anything. Per-tenant AI spend stays bounded by the token budget either
 * way.
 *
 * BullMQ contract: `moveToDelayed` inside a processor needs the worker's
 * token, and the processor must then throw `DelayedError` so the worker
 * does not mark the job completed.
 */

import { DelayedError, type Job, type Queue } from 'bullmq';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'tenantFairness' });

export const FAIRNESS_RETRY_MS = 20_000;

/** How many active jobs to inspect — comfortably above any concurrency. */
const ACTIVE_SCAN = 25;

export async function deferWhenTenantBusy(
  job: Job<{ tenantId?: number }>,
  queue: Queue | null,
  token: string | undefined,
): Promise<void> {
  const tenantId = job.data?.tenantId;
  if (!queue || !tenantId || !token) return;

  let clash = false;
  try {
    const active = await queue.getActive(0, ACTIVE_SCAN);
    clash = active.some((j) => j.id !== job.id && j.data?.tenantId === tenantId);
  } catch (err) {
    // Fairness must never break the work itself — on any error, run.
    log.warn({ err, queue: queue.name }, 'fairness check failed — running the job anyway');
    return;
  }
  if (!clash) return;

  log.info(
    { queue: queue.name, jobId: job.id, tenantId, retryInMs: FAIRNESS_RETRY_MS },
    'tenant already has an active job on this queue — deferring so the slot goes to another tenant',
  );
  await job.moveToDelayed(Date.now() + FAIRNESS_RETRY_MS, token);
  throw new DelayedError();
}
