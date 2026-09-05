/**
 * BullMQ queue definitions for all background jobs.
 *
 * Three queues:
 *   - schema-profiling: AI-powered schema analysis
 *   - ingestion: ETL data ingestion into Delta Lake
 *   - transformation: Star schema transformation runs
 *
 * If Redis is not available, queues are null and callers should
 * fall back to inline execution.
 */

import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import { getRedisConnection } from './redis';
import { getCorrelation } from '../utils/requestScope';

/**
 * CORRELATION (assessment 6-1): every job carries the `requestId` of the
 * HTTP request that enqueued it, stamped HERE at `add()` so no enqueue site
 * has to remember. A job enqueued from a scheduler (no request) simply has
 * none. Workers re-enter the scope from this field (jobs/workers.ts).
 */
function stampCorrelation<Q extends Queue>(queue: Q): Q {
  const original = queue.add.bind(queue) as (name: string, data: unknown, opts?: JobsOptions) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (queue as any).add = (name: string, data: unknown, opts?: JobsOptions) => {
    const { requestId } = getCorrelation();
    const stamped = (requestId && data && typeof data === 'object' && !(data as { requestId?: unknown }).requestId)
      ? { ...(data as object), requestId }
      : data;
    return original(name, stamped, opts);
  };
  return queue;
}

/**
 * RETRY POLICY (assessment 6-6). No queue had one: a transient Redis or
 * Postgres blip during a transformation was a permanent failure. Two
 * classes, on purpose:
 *
 *  - RETRIED (3 attempts, exponential from 15 s): work that is idempotent
 *    by construction — a transformation overwrites its tables, profiling
 *    rebuilds its rows, a schedule tick re-checks before acting, ingestion
 *    merges. Re-running after a blip is exactly right.
 *  - NOT RETRIED (1 attempt): bus-matrix design (a second AI design costs
 *    real money and the first may have half-persisted), report emails (a
 *    retry after a send that then threw sends the mail twice). The failed
 *    job stays in the failed set — the dead-letter view on /admin/ops —
 *    where an operator retries it deliberately.
 *
 * Retention is COUNT-capped as well as age-capped (5-5): an age-only rule
 * lets a busy fortnight fill Redis, and Redis runs with `noeviction`.
 */
const RETAINED: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 14 * 24 * 60 * 60, count: 2000 },
};
export const RETRIED_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 15_000 },
  ...RETAINED,
};
export const UNRETRIED_JOB_OPTIONS: JobsOptions = { attempts: 1, ...RETAINED };

function queueOptions(conn: NonNullable<ReturnType<typeof getRedisConnection>>, retried: boolean): QueueOptions {
  return { connection: conn, defaultJobOptions: retried ? RETRIED_JOB_OPTIONS : UNRETRIED_JOB_OPTIONS };
}

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

/** Stamped by stampCorrelation at add() — the request a job descends from (6-1). */
export interface CorrelatedJobData {
  requestId?: string;
}

export interface SchemaProfilingJobData extends CorrelatedJobData {
  connectionId: number;
  tenantId: number;
  triggeredBy: string; // user email
}

export interface IngestionJobData extends CorrelatedJobData {
  connectionId: number;
  tenantId: number;
  tables: string[];     // table names to ingest
  triggeredBy: string;
}

export interface TransformationJobData extends CorrelatedJobData {
  productId: number;
  tenantId: number;
  triggeredBy: string;
}

export interface EmailReportJobData extends CorrelatedJobData {
  scheduleId: number;
  tenantId: number;
}

export interface BusMatrixJobData extends CorrelatedJobData {
  connectionId: number;
  tenantId: number;
  triggeredBy: string; // user email
  /**
   * What this job does:
   *   • 'design'   (default, legacy) — full bus-matrix design + transformation
   *   • 'refresh'  — re-run a single product's transformations, optionally
   *                  syncing the source connection upstream first.
   *   • 'pipeline' — run a saved-or-builtin pipeline (sources + products in
   *                  topo order). Reuses the same SSE / cancel / active-job
   *                  endpoints; the worker dispatches on `mode`.
   *   • 'extend'   — design + build ONE additional subject next to the
   *                  existing build (additive; never touches existing
   *                  products — see runTopicExtensionWorkflow).
   */
  mode?: 'design' | 'refresh' | 'pipeline' | 'extend';
  /** Required when mode='refresh' — which product to rebuild. */
  productId?: number;
  /**
   * When mode='refresh' and syncSource=true, the worker triggers the
   * connection's source sync first and waits for it to complete before
   * running the product's transformations. Gives users a single click for
   * the full upstream → downstream pipeline.
   */
  syncSource?: boolean;
  /** Required when mode='pipeline' — the resolved scope to execute. */
  pipelineScope?: { sourceIds: number[]; productIds: number[]; shouldSyncSources: boolean };
  /** Optional pipeline_runs.id for history persistence (mode='pipeline'). */
  pipelineRunId?: number;
  /** Optional pipeline name for display in events. */
  pipelineName?: string;
  /** Required when mode='extend' — the user-approved subject to add. */
  extendRequest?: { name: string; description: string; focus?: string; entities: string[] };
}

export interface ConnectionSyncScheduleJobData extends CorrelatedJobData {
  scheduleId: number;
  connectionId: number;
  tenantId: number;
}

/**
 * Job data for the `pipeline-schedule` queue — fired by BullMQ repeatable
 * jobs configured in `pipelineScheduler.ts` from cron triggers persisted
 * on the `pipelines.triggers` JSONB column. The worker resolves the
 * pipeline + enqueues a `pipeline-run` on the bus-matrix queue.
 */
export interface PipelineScheduleJobData extends CorrelatedJobData {
  pipelineId: number;
  tenantId: number;
}

// ---------------------------------------------------------------------------
// Queue instances (null if Redis not configured)
// ---------------------------------------------------------------------------

let schemaProfilingQueue: Queue<SchemaProfilingJobData> | null = null;
let ingestionQueue: Queue<IngestionJobData> | null = null;
let transformationQueue: Queue<TransformationJobData> | null = null;
let emailReportQueue: Queue<EmailReportJobData> | null = null;
let busMatrixQueue: Queue<BusMatrixJobData> | null = null;
let connectionSyncScheduleQueue: Queue<ConnectionSyncScheduleJobData> | null = null;
let pipelineScheduleQueue: Queue<PipelineScheduleJobData> | null = null;

export function getSchemaProfilingQueue(): Queue<SchemaProfilingJobData> | null {
  if (schemaProfilingQueue) return schemaProfilingQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  schemaProfilingQueue = stampCorrelation(new Queue<SchemaProfilingJobData>('schema-profiling', queueOptions(conn, true)));
  return schemaProfilingQueue;
}

export function getIngestionQueue(): Queue<IngestionJobData> | null {
  if (ingestionQueue) return ingestionQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  ingestionQueue = stampCorrelation(new Queue<IngestionJobData>('ingestion', queueOptions(conn, true)));
  return ingestionQueue;
}

export function getTransformationQueue(): Queue<TransformationJobData> | null {
  if (transformationQueue) return transformationQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  transformationQueue = stampCorrelation(new Queue<TransformationJobData>('transformation', queueOptions(conn, true)));
  return transformationQueue;
}

export function getEmailReportQueue(): Queue<EmailReportJobData> | null {
  if (emailReportQueue) return emailReportQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  emailReportQueue = stampCorrelation(new Queue<EmailReportJobData>('email-report', queueOptions(conn, false)));
  return emailReportQueue;
}

export function getBusMatrixQueue(): Queue<BusMatrixJobData> | null {
  if (busMatrixQueue) return busMatrixQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  busMatrixQueue = stampCorrelation(new Queue<BusMatrixJobData>('bus-matrix', queueOptions(conn, false)));
  return busMatrixQueue;
}

/**
 * Queue for scheduled connection syncs. Holds repeatable jobs registered
 * via cron expression on each enabled `connection_sync_schedules` row.
 * The worker drains these by calling `triggerSync()` on the orchestrator,
 * which in turn enforces the schema-hash cost gate (no LLM cost when
 * structure is unchanged).
 */
export function getConnectionSyncScheduleQueue(): Queue<ConnectionSyncScheduleJobData> | null {
  if (connectionSyncScheduleQueue) return connectionSyncScheduleQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  connectionSyncScheduleQueue = stampCorrelation(new Queue<ConnectionSyncScheduleJobData>('connection-sync-schedule', queueOptions(conn, true)));
  return connectionSyncScheduleQueue;
}

/**
 * Queue for scheduled pipeline cron triggers. Holds repeatable jobs
 * registered via `pipelineScheduler.registerPipelineTriggers()` from
 * cron-kind entries on `pipelines.triggers`. The worker enqueues a
 * `pipeline-run` job on the bus-matrix queue (same flow as the manual
 * /run-pipeline endpoint).
 */
export function getPipelineScheduleQueue(): Queue<PipelineScheduleJobData> | null {
  if (pipelineScheduleQueue) return pipelineScheduleQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  pipelineScheduleQueue = stampCorrelation(new Queue<PipelineScheduleJobData>('pipeline-schedule', queueOptions(conn, true)));
  return pipelineScheduleQueue;
}

/**
 * Close all queues gracefully.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    schemaProfilingQueue?.close(),
    ingestionQueue?.close(),
    transformationQueue?.close(),
    emailReportQueue?.close(),
    busMatrixQueue?.close(),
  ]);
  schemaProfilingQueue = null;
  ingestionQueue = null;
  transformationQueue = null;
  emailReportQueue = null;
  busMatrixQueue = null;
}
