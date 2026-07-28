/**
 * BullMQ workers — process background jobs.
 *
 * Each worker picks jobs from its queue, executes the task, and
 * reports progress via BullMQ's built-in job.updateProgress().
 *
 * Workers are started from index.ts via startWorkers().
 *
 * TENANT CONTEXT — never use a session-level `SET app.current_tenant` here.
 *
 * Every job used to open with `semanticDb.raw("SET app.current_tenant = …")`.
 * That is a SESSION-level setting on a POOLED connection, and BullMQ runs these
 * workers at concurrency 2–4, so jobs from different tenants interleave: job A
 * sets its tenant on connection X, job B sets its own on connection Y, and A's
 * next query can be handed Y — which still carries B's tenant. RLS then filters
 * to the WRONG tenant and the job silently reads and writes someone else's rows.
 * It is fail-OPEN, which is the dangerous direction.
 *
 * The jobs-worker split made this sharper, not softer: it concentrated all the
 * multi-tenant batch work into one process.
 *
 * Every query is therefore wrapped in `tenantQuery(tenantId, …)`, which opens a
 * short transaction and uses `set_config('app.current_tenant', …, true)` —
 * transaction-local, so it cannot leak to another job or outlive its connection.
 * Long-running work is NOT wrapped in one transaction (that would pin a pool
 * connection for the whole job); each query gets its own.
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from './redis';
import { SchemaProfilingJobData, IngestionJobData, TransformationJobData, EmailReportJobData, BusMatrixJobData, ConnectionSyncScheduleJobData, PipelineScheduleJobData } from './queues';
import { registerJobAbortController, unregisterJob, isJobCancelled, watchForCancellation } from './cancellation';
import { shouldRunQueue } from './queueRoles';
import { runSchemaProfiler } from '../semantic/SchemaProfiler';
import { notify } from '../services/notificationService';
import { createSourceConnector } from '../connectors/ConnectorFactory';
import { tenantQuery } from '../services/tenantQuery';
import { trackEvent, trackException } from '../utils/monitoring';
import { startMaintenanceWorker, stopMaintenanceWorker } from './warehouseMaintenance';
import { startMorningBriefWorker, stopMorningBriefWorker } from './morningBriefJob';
import { startSecurityMaintenanceWorker, stopSecurityMaintenanceWorker } from './securityMaintenanceJob';
import { withTenantAiContext } from '../services/aiBudget';
import type { OrchestratorEvent } from '../services/busMatrixOrchestrator';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'workers' });

const workers: Worker[] = [];

// ---------------------------------------------------------------------------
// Schema Profiling Worker
// ---------------------------------------------------------------------------

async function processSchemaProfilingJob(job: Job<SchemaProfilingJobData>): Promise<{ tablesInserted: number; columnsInserted: number; relationshipsInserted: number }> {
  const { connectionId, tenantId } = job.data;

  await job.updateProgress({ phase: 'starting', message: 'Starting schema profiling…' });

  // Every DB read in a worker is tenant-scoped through a short transaction —
  // see the note on startWorkers() for why the session-level SET is gone.
  const connection = await tenantQuery(tenantId, (trx) =>
    trx('connections').where({ id: connectionId }).first(),
  );
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const connector = createSourceConnector(connection);
  await connector.connect();

  try {
    const result = await runSchemaProfiler(
      connectionId,
      (p) => {
        job.updateProgress(p).catch(() => {});
      },
      connector,
      { connection },
    );

    trackEvent('schema_profiling_complete', {
      connectionId: String(connectionId),
      tenantId: String(tenantId),
    }, {
      tables: result.tablesInserted,
      columns: result.columnsInserted,
      relationships: result.relationshipsInserted,
    });

    return result;
  } finally {
    connector.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Ingestion Worker
// ---------------------------------------------------------------------------

async function processIngestionJob(job: Job<IngestionJobData>): Promise<{ ingested: number }> {
  const { connectionId, tenantId, tables } = job.data;

  await job.updateProgress({ phase: 'starting', message: `Ingesting ${tables.length} tables…` });

  // Ingestion calls the ETL service — reuse the existing route logic
  const axios = (await import('axios')).default;
  const etlUrl = process.env.ETL_URL ?? 'http://localhost:8000';

  const connection = await tenantQuery(tenantId, (trx) =>
    trx('connections').where({ id: connectionId }).first(),
  );
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const config = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
  let ingested = 0;

  for (let i = 0; i < tables.length; i++) {
    const tableName = tables[i];
    await job.updateProgress({
      phase: 'ingesting',
      message: `Ingesting ${tableName}…`,
      tableIndex: i,
      tableCount: tables.length,
    });

    try {
      await axios.post(`${etlUrl}/ingest`, {
        source_type: connection.type,
        source_config: config,
        table_name: tableName,
        connection_id: connectionId,
      }, { timeout: 300_000 });
      ingested++;
    } catch (err) {
      log.error({ err }, `Failed to ingest ${tableName}`);
      // Continue with remaining tables
    }
  }

  trackEvent('ingestion_complete', {
    connectionId: String(connectionId),
    tenantId: String(tenantId),
  }, { tables: ingested });

  return { ingested };
}

// ---------------------------------------------------------------------------
// Transformation Worker
// ---------------------------------------------------------------------------

async function processTransformationJob(job: Job<TransformationJobData>): Promise<{ tablesTransformed: number }> {
  const { productId, tenantId } = job.data;

  await job.updateProgress({ phase: 'starting', message: 'Running transformations…' });

  // Dynamic import to avoid circular deps
  const { runProductTransformation } = await import('../services/transformationRunner');

  // Load product + tables from DB
  const product = await tenantQuery(tenantId, (trx) =>
    trx('data_products').where({ id: productId }).first(),
  );
  if (!product) throw new Error(`Product ${productId} not found`);
  const tables = await tenantQuery(tenantId, (trx) =>
    trx('product_tables').where({ product_id: productId }),
  );

  const results = await runProductTransformation(product, tables, tenantId);

  trackEvent('transformation_complete', {
    productId: String(productId),
    tenantId: String(tenantId),
  }, { tables: results.length });

  return { tablesTransformed: results.length };
}

// ---------------------------------------------------------------------------
// Bus Matrix Worker — design + build + transform, all in one job.
// ---------------------------------------------------------------------------

async function processBusMatrixJob(job: Job<BusMatrixJobData>): Promise<{ products: number; allOk: boolean }> {
  const { connectionId, tenantId, triggeredBy, mode, productId, syncSource } = job.data;
  const jobId = String(job.id);

  const controller = new AbortController();
  registerJobAbortController(jobId, controller);

  if (await isJobCancelled(jobId)) {
    unregisterJob(jobId);
    throw new Error('Cancelled before start');
  }

  // Cancellation may be requested from the API process, which cannot reach this
  // controller. Checkpoints catch it between steps; this poll is what aborts an
  // in-flight AI stream. No-op without Redis (single-process dev).
  const stopCancelWatch = watchForCancellation(jobId);

  // Shared event emitter — both refresh + design orchestrators use the same
  // OrchestratorEvent union, so the type is imported at the top of the file.
  const emitToJob = (event: OrchestratorEvent) => {
    job.log(JSON.stringify({ ts: Date.now(), ...event })).catch(() => { /* non-fatal */ });
    if (event.type === 'phase' && event.text) {
      job.updateProgress({ phase: event.text }).catch(() => {});
    }
  };

  try {
    // ── Pipeline mode — run a saved or built-in pipeline scope ──────
    if (mode === 'pipeline') {
      const { pipelineScope, pipelineRunId, pipelineName } = job.data;
      if (!pipelineScope) throw new Error('pipelineScope required for pipeline mode');
      await job.updateProgress({ phase: 'starting', message: `Starting pipeline${pipelineName ? ` "${pipelineName}"` : ''}…` });
      const { runPipelineWorkflow } = await import('../services/busMatrixOrchestrator');
      const result = await runPipelineWorkflow({
        scope: pipelineScope,
        pipelineRunId,
        tenantId: Number(tenantId),
        userEmail: triggeredBy,
        abortSignal: controller.signal,
        isCancelled: () => isJobCancelled(jobId),
        emit: emitToJob,
      });
      trackEvent('pipeline_run_complete', {
        tenantId: String(tenantId),
        allOk: String(result.allOk),
        sources: String(result.sourceResults.length),
        products: String(result.productResults.length),
      });
      return { products: result.productResults.length, allOk: result.allOk };
    }

    // ── Refresh mode — single product, optional source sync upstream ──
    if (mode === 'refresh') {
      if (!productId) throw new Error('productId required for refresh mode');
      await job.updateProgress({ phase: 'starting', message: 'Starting product refresh…' });
      const { runProductRefreshWorkflow } = await import('../services/busMatrixOrchestrator');
      const result = await runProductRefreshWorkflow({
        productId,
        tenantId,
        userEmail: triggeredBy,
        syncSource: !!syncSource,
        abortSignal: controller.signal,
        isCancelled: () => isJobCancelled(jobId),
        emit: emitToJob,
      });
      trackEvent('product_refresh_complete', {
        productId: String(productId),
        tenantId: String(tenantId),
        allOk: String(result.allOk),
        syncSource: String(!!syncSource),
      });
      // Refresh jobs return the same shape ({ products, allOk }) to keep
      // the queue's return-value schema uniform — products=1 when refreshing.
      return { products: 1, allOk: result.allOk };
    }

    // ── Design mode (legacy default) — full bus-matrix workflow ──────
    await job.updateProgress({ phase: 'starting', message: 'Starting bus matrix workflow…' });
    const { runBusMatrixWorkflow } = await import('../services/busMatrixOrchestrator');
    const result = await runBusMatrixWorkflow({
      connectionId,
      tenantId,
      userEmail: triggeredBy,
      abortSignal: controller.signal,
      isCancelled: () => isJobCancelled(jobId),
      emit: emitToJob,
    });

    trackEvent('bus_matrix_complete', {
      connectionId: String(connectionId),
      tenantId: String(tenantId),
      allOk: String(result.allOk),
    }, { products: result.products.length });

    return { products: result.products.length, allOk: result.allOk };
  } finally {
    stopCancelWatch();
    unregisterJob(jobId);
  }
}

// ---------------------------------------------------------------------------
// Start all workers
// ---------------------------------------------------------------------------

/**
 * Create a worker only if this process is meant to run that queue (see
 * `queueRoles`). Returns null when the queue belongs to the other container, so
 * call sites use `worker?.on(...)`. Registers the worker for shutdown.
 */
function makeWorker<T = unknown>(
  name: string,
  processor: ConstructorParameters<typeof Worker<T>>[1],
  opts: ConstructorParameters<typeof Worker<T>>[2],
): Worker<T> | null {
  if (!shouldRunQueue(name)) {
    log.info({ queue: name }, 'Queue not assigned to this process — worker not started');
    return null;
  }
  const w = new Worker<T>(name, processor, opts);
  workers.push(w as Worker);
  return w;
}

export function startWorkers(): void {
  const conn = getRedisConnection();
  if (!conn) {
    log.info('Redis not available — workers not started');
    return;
  }

  const defaultOpts = {
    connection: conn,
    concurrency: 2,
    removeOnComplete: { age: 7 * 24 * 60 * 60 }, // 7 days
    removeOnFail: { age: 14 * 24 * 60 * 60 },     // 14 days
  };

  // Schema profiling worker
  const schemaWorker = makeWorker<SchemaProfilingJobData>(
    'schema-profiling',
    async (job) => withTenantAiContext(job.data.tenantId, () => processSchemaProfilingJob(job)),
    { ...defaultOpts, concurrency: 1 }, // AI calls are expensive, limit to 1
  );
  schemaWorker?.on('failed', (job, err) => {
    log.error({ err }, `schema-profiling job ${job?.id} failed`);
    trackException(err, { queue: 'schema-profiling', jobId: job?.id ?? 'unknown' });
  });

  // Ingestion worker
  const ingestionWorker = makeWorker<IngestionJobData>(
    'ingestion',
    async (job) => withTenantAiContext(job.data.tenantId, () => processIngestionJob(job)),
    defaultOpts,
  );
  ingestionWorker?.on('failed', (job, err) => {
    log.error({ err }, `ingestion job ${job?.id} failed`);
    trackException(err, { queue: 'ingestion', jobId: job?.id ?? 'unknown' });
  });

  // Transformation worker
  const transformationWorker = makeWorker<TransformationJobData>(
    'transformation',
    async (job) => withTenantAiContext(job.data.tenantId, () => processTransformationJob(job)),
    defaultOpts,
  );
  transformationWorker?.on('failed', (job, err) => {
    log.error({ err }, `transformation job ${job?.id} failed`);
    trackException(err, { queue: 'transformation', jobId: job?.id ?? 'unknown' });
  });

  // Scheduled transformation worker (same logic, separate queue for repeatable jobs)
  const scheduledTransWorker = makeWorker<TransformationJobData>(
    'scheduled-transformation',
    async (job) => withTenantAiContext(job.data.tenantId, async () => {
      // Record run start
      const { productId, tenantId } = job.data;

      const [runRow] = await tenantQuery(tenantId, async (trx) => {
        const schedule = await trx('transformation_schedules')
          .where({ product_id: productId }).first();
        return trx('transformation_runs').insert({
          product_id: productId,
          schedule_id: schedule?.id ?? null,
          triggered_by: 'schedule',
          status: 'running',
        }).returning('id');
      });
      const runId = typeof runRow === 'object' ? (runRow as { id: number }).id : runRow;

      try {
        const result = await processTransformationJob(job);

        await tenantQuery(tenantId, (trx) =>
          trx('transformation_runs').where({ id: runId }).update({
            status: 'completed',
            tables_transformed: result.tablesTransformed,
            finished_at: new Date(),
          }),
        );

        // Notify the user who triggered the job
        if (tenantId && job.data.triggeredBy) {
          notify({
            tenantId,
            userId: Number(job.data.triggeredBy),
            type: 'job_complete',
            title: 'Transformation complete',
            message: `Product transformation finished: ${result.tablesTransformed} tables transformed`,
            link: '/products',
          }).catch(() => {});
        }

        return result;
      } catch (err) {
        await tenantQuery(tenantId, (trx) =>
          trx('transformation_runs').where({ id: runId }).update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'Unknown error',
            finished_at: new Date(),
          }),
        );

        // Notify on failure
        if (tenantId && job.data.triggeredBy) {
          notify({
            tenantId,
            userId: Number(job.data.triggeredBy),
            type: 'job_complete',
            title: 'Transformation failed',
            message: err instanceof Error ? err.message : 'Unknown error',
            link: '/products',
          }).catch(() => {});
        }

        // Log failure for alerting
        log.error({ err }, `scheduled transformation for product ${productId} failed`);
        trackEvent('scheduled_transformation_failed', {
          productId: String(productId),
          tenantId: String(tenantId),
          error: err instanceof Error ? err.message : 'Unknown',
        });

        throw err;
      }
    }),
    { ...defaultOpts, concurrency: 1 },
  );
  scheduledTransWorker?.on('failed', (job, err) => {
    log.error({ err }, `scheduled-transformation job ${job?.id} failed`);
    trackException(err, { queue: 'scheduled-transformation', jobId: job?.id ?? 'unknown' });
  });

  // Bus matrix worker — long-running (AI design + DB build + transformations).
  // Concurrency 1: AI calls are expensive and the transformation phase already
  // serialises product builds; running multiple in parallel offers no win.
  const busMatrixWorker = makeWorker<BusMatrixJobData>(
    'bus-matrix',
    async (job) => withTenantAiContext(job.data.tenantId, () => processBusMatrixJob(job)),
    {
      ...defaultOpts,
      concurrency: 1,
      // Allow long-running jobs without lock loss. Bus matrix builds can take
      // many minutes on large schemas (AI design + N transformations).
      lockDuration: 5 * 60 * 1000,        // 5 min lock
      lockRenewTime: 60 * 1000,            // renew every 60s
      stalledInterval: 60 * 1000,
    },
  );
  busMatrixWorker?.on('failed', (job, err) => {
    log.error({ err }, `bus-matrix job ${job?.id} failed`);
    trackException(err, { queue: 'bus-matrix', jobId: job?.id ?? 'unknown' });
  });

  // Email report worker
  const emailReportWorker = makeWorker<EmailReportJobData>(
    'email-report',
    async (job) => {
      const { scheduleId } = job.data;
      const { sendScheduledReport } = await import('../services/reportEmailService');
      await sendScheduledReport(scheduleId);
    },
    { ...defaultOpts, concurrency: 3 },
  );
  emailReportWorker?.on('failed', (job, err) => {
    log.error({ err }, `email-report job ${job?.id} failed`);
    trackException(err, { queue: 'email-report', jobId: job?.id ?? 'unknown' });
  });

  // Connection sync schedule worker — fires `triggerSync` for each
  // connection_sync_schedules cron tick. The orchestrator's schema-hash
  // gate makes scheduled refreshes near-zero-cost when the schema is
  // stable (no LLM call), so hourly schedules are economically viable.
  const connSyncWorker = makeWorker<ConnectionSyncScheduleJobData>(
    'connection-sync-schedule',
    async (job) => {
      const { connectionId, tenantId } = job.data;
      const { triggerSync } = await import('../orchestrator/SyncOrchestrator');
      const result = await triggerSync({ connectionId, tenantId });
      // triggerSync is fire-and-forget — the BullMQ job completes once
      // the run is QUEUED. The actual sync runs in the orchestrator's
      // background; status surfaces via source_sync_runs.
      return result;
    },
    { connection: conn, concurrency: 4 },
  );
  connSyncWorker?.on('failed', (job, err) => {
    trackException(err, { queue: 'connection-sync-schedule', jobId: job?.id ?? 'unknown' });
  });

  // pipeline-schedule worker — drains cron-fired pipeline triggers.
  // Each fire enqueues a `pipeline-run` on the bus-matrix queue (same
  // path as the manual /run-pipeline endpoint), so SSE attach + cancel
  // + active-job all keep working without changes.
  const pipelineSchedWorker = makeWorker<PipelineScheduleJobData>(
    'pipeline-schedule',
    async (job) => {
      const { pipelineId, tenantId } = job.data;
      const { enqueueSavedPipelineRun } = await import('../services/pipelineService');
      const result = await enqueueSavedPipelineRun({ pipelineId, tenantId, triggeredBy: 'cron' });
      // null result means the pipeline was disabled, scope was empty, or
      // Redis is unavailable. Not worth failing the cron job over —
      // pipeline_runs already records the failed state when applicable.
      return result;
    },
    { connection: conn, concurrency: 4 },
  );
  pipelineSchedWorker?.on('failed', (job, err) => {
    trackException(err, { queue: 'pipeline-schedule', jobId: job?.id ?? 'unknown' });
  });

  // Warehouse maintenance — weekly OPTIMIZE + VACUUM
  const maintenanceWorker = startMaintenanceWorker();
  if (maintenanceWorker) {
    maintenanceWorker?.on('failed', (job, err) => {
      trackException(err, { queue: 'warehouse-maintenance', jobId: job?.id ?? 'unknown' });
    });
  }

  // Morning brief — daily snapshot + narration. Telemetry on failure.
  const briefWorker = startMorningBriefWorker();
  if (briefWorker) {
    briefWorker?.on('failed', (job, err) => {
      trackException(err, { queue: 'morning-brief', jobId: job?.id ?? 'unknown' });
    });
  }

  // Security maintenance — daily cleanup of expired refresh tokens etc.
  // Keeps the refresh_tokens table from growing unboundedly. Cheap;
  // non-critical if it skips a day.
  const secWorker = startSecurityMaintenanceWorker();
  if (secWorker) {
    secWorker?.on('failed', (job, err) => {
      trackException(err, { queue: 'security-maintenance', jobId: job?.id ?? 'unknown' });
    });
  }

  log.info(`Started ${workers.length} workers`);
}

/**
 * Gracefully shut down all workers.
 */
export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers.length = 0;
  await stopMaintenanceWorker();
  await stopMorningBriefWorker();
}
