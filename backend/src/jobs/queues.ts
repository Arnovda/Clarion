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

import { Queue } from 'bullmq';
import { getRedisConnection } from './redis';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface SchemaProfilingJobData {
  connectionId: number;
  tenantId: number;
  triggeredBy: string; // user email
}

export interface IngestionJobData {
  connectionId: number;
  tenantId: number;
  tables: string[];     // table names to ingest
  triggeredBy: string;
}

export interface TransformationJobData {
  productId: number;
  tenantId: number;
  triggeredBy: string;
}

export interface EmailReportJobData {
  scheduleId: number;
  tenantId: number;
}

export interface BusMatrixJobData {
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
   */
  mode?: 'design' | 'refresh' | 'pipeline';
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
}

export interface ConnectionSyncScheduleJobData {
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
export interface PipelineScheduleJobData {
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
  schemaProfilingQueue = new Queue<SchemaProfilingJobData>('schema-profiling', { connection: conn });
  return schemaProfilingQueue;
}

export function getIngestionQueue(): Queue<IngestionJobData> | null {
  if (ingestionQueue) return ingestionQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  ingestionQueue = new Queue<IngestionJobData>('ingestion', { connection: conn });
  return ingestionQueue;
}

export function getTransformationQueue(): Queue<TransformationJobData> | null {
  if (transformationQueue) return transformationQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  transformationQueue = new Queue<TransformationJobData>('transformation', { connection: conn });
  return transformationQueue;
}

export function getEmailReportQueue(): Queue<EmailReportJobData> | null {
  if (emailReportQueue) return emailReportQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  emailReportQueue = new Queue<EmailReportJobData>('email-report', { connection: conn });
  return emailReportQueue;
}

export function getBusMatrixQueue(): Queue<BusMatrixJobData> | null {
  if (busMatrixQueue) return busMatrixQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  busMatrixQueue = new Queue<BusMatrixJobData>('bus-matrix', { connection: conn });
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
  connectionSyncScheduleQueue = new Queue<ConnectionSyncScheduleJobData>('connection-sync-schedule', { connection: conn });
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
  pipelineScheduleQueue = new Queue<PipelineScheduleJobData>('pipeline-schedule', { connection: conn });
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
