/**
 * BullMQ workers — process background jobs.
 *
 * Each worker picks jobs from its queue, executes the task, and
 * reports progress via BullMQ's built-in job.updateProgress().
 *
 * Workers are started from index.ts via startWorkers().
 */

import { Worker, Job } from 'bullmq';
import { getRedisConnection } from './redis';
import { SchemaProfilingJobData, IngestionJobData, TransformationJobData, EmailReportJobData } from './queues';
import { semanticDb } from '../db/knex';
import { runSchemaProfiler } from '../semantic/SchemaProfiler';
import { notify } from '../services/notificationService';
import { createSourceConnector } from '../connectors/ConnectorFactory';
import { trackEvent, trackException } from '../utils/monitoring';
import { startMaintenanceWorker, stopMaintenanceWorker } from './warehouseMaintenance';
import { withTenantAiContext } from '../services/aiBudget';

const workers: Worker[] = [];

// ---------------------------------------------------------------------------
// Schema Profiling Worker
// ---------------------------------------------------------------------------

async function processSchemaProfilingJob(job: Job<SchemaProfilingJobData>): Promise<{ tablesInserted: number; columnsInserted: number; relationshipsInserted: number }> {
  const { connectionId, tenantId } = job.data;

  // Set tenant context for this worker's DB operations
  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  await job.updateProgress({ phase: 'starting', message: 'Starting schema profiling…' });

  const connection = await semanticDb('connections').where({ id: connectionId }).first();
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const connector = createSourceConnector(connection);
  await connector.connect();

  try {
    const result = await runSchemaProfiler(
      connectionId,
      null,
      (p) => {
        job.updateProgress(p).catch(() => {});
      },
      connector,
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

  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
  await job.updateProgress({ phase: 'starting', message: `Ingesting ${tables.length} tables…` });

  // Ingestion calls the ETL service — reuse the existing route logic
  const axios = (await import('axios')).default;
  const etlUrl = process.env.ETL_URL ?? 'http://localhost:8000';

  const connection = await semanticDb('connections').where({ id: connectionId }).first();
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
      console.error(`[ingestion-worker] Failed to ingest ${tableName}:`, err);
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

  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
  await job.updateProgress({ phase: 'starting', message: 'Running transformations…' });

  // Dynamic import to avoid circular deps
  const { runProductTransformation } = await import('../services/transformationRunner');

  // Load product + tables from DB
  const product = await semanticDb('data_products').where({ id: productId }).first();
  if (!product) throw new Error(`Product ${productId} not found`);
  const tables = await semanticDb('product_tables').where({ product_id: productId });

  const results = await runProductTransformation(product, tables, tenantId);

  trackEvent('transformation_complete', {
    productId: String(productId),
    tenantId: String(tenantId),
  }, { tables: results.length });

  return { tablesTransformed: results.length };
}

// ---------------------------------------------------------------------------
// Start all workers
// ---------------------------------------------------------------------------

export function startWorkers(): void {
  const conn = getRedisConnection();
  if (!conn) {
    console.log('[workers] Redis not available — workers not started');
    return;
  }

  const defaultOpts = {
    connection: conn,
    concurrency: 2,
    removeOnComplete: { age: 7 * 24 * 60 * 60 }, // 7 days
    removeOnFail: { age: 14 * 24 * 60 * 60 },     // 14 days
  };

  // Schema profiling worker
  const schemaWorker = new Worker<SchemaProfilingJobData>(
    'schema-profiling',
    async (job) => withTenantAiContext(job.data.tenantId, () => processSchemaProfilingJob(job)),
    { ...defaultOpts, concurrency: 1 }, // AI calls are expensive, limit to 1
  );
  schemaWorker.on('failed', (job, err) => {
    console.error(`[worker] schema-profiling job ${job?.id} failed:`, err.message);
    trackException(err, { queue: 'schema-profiling', jobId: job?.id ?? 'unknown' });
  });
  workers.push(schemaWorker);

  // Ingestion worker
  const ingestionWorker = new Worker<IngestionJobData>(
    'ingestion',
    async (job) => withTenantAiContext(job.data.tenantId, () => processIngestionJob(job)),
    defaultOpts,
  );
  ingestionWorker.on('failed', (job, err) => {
    console.error(`[worker] ingestion job ${job?.id} failed:`, err.message);
    trackException(err, { queue: 'ingestion', jobId: job?.id ?? 'unknown' });
  });
  workers.push(ingestionWorker);

  // Transformation worker
  const transformationWorker = new Worker<TransformationJobData>(
    'transformation',
    async (job) => withTenantAiContext(job.data.tenantId, () => processTransformationJob(job)),
    defaultOpts,
  );
  transformationWorker.on('failed', (job, err) => {
    console.error(`[worker] transformation job ${job?.id} failed:`, err.message);
    trackException(err, { queue: 'transformation', jobId: job?.id ?? 'unknown' });
  });
  workers.push(transformationWorker);

  // Scheduled transformation worker (same logic, separate queue for repeatable jobs)
  const scheduledTransWorker = new Worker<TransformationJobData>(
    'scheduled-transformation',
    async (job) => withTenantAiContext(job.data.tenantId, async () => {
      // Record run start
      const { productId, tenantId } = job.data;
      await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

      const schedule = await semanticDb('transformation_schedules')
        .where({ product_id: productId }).first();

      const [runRow] = await semanticDb('transformation_runs').insert({
        product_id: productId,
        schedule_id: schedule?.id ?? null,
        triggered_by: 'schedule',
        status: 'running',
      }).returning('id');
      const runId = typeof runRow === 'object' ? (runRow as { id: number }).id : runRow;

      try {
        const result = await processTransformationJob(job);

        await semanticDb('transformation_runs').where({ id: runId }).update({
          status: 'completed',
          tables_transformed: result.tablesTransformed,
          finished_at: new Date(),
        });

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
        await semanticDb('transformation_runs').where({ id: runId }).update({
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'Unknown error',
          finished_at: new Date(),
        });

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
        console.error(`[scheduled-transformation] Product ${productId} failed:`, err);
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
  scheduledTransWorker.on('failed', (job, err) => {
    console.error(`[worker] scheduled-transformation job ${job?.id} failed:`, err.message);
    trackException(err, { queue: 'scheduled-transformation', jobId: job?.id ?? 'unknown' });
  });
  workers.push(scheduledTransWorker);

  // Email report worker
  const emailReportWorker = new Worker<EmailReportJobData>(
    'email-report',
    async (job) => {
      const { scheduleId } = job.data;
      const { sendScheduledReport } = await import('../services/reportEmailService');
      await sendScheduledReport(scheduleId);
    },
    { ...defaultOpts, concurrency: 3 },
  );
  emailReportWorker.on('failed', (job, err) => {
    console.error(`[worker] email-report job ${job?.id} failed:`, err.message);
    trackException(err, { queue: 'email-report', jobId: job?.id ?? 'unknown' });
  });
  workers.push(emailReportWorker);

  // Warehouse maintenance — weekly OPTIMIZE + VACUUM
  const maintenanceWorker = startMaintenanceWorker();
  if (maintenanceWorker) {
    maintenanceWorker.on('failed', (job, err) => {
      trackException(err, { queue: 'warehouse-maintenance', jobId: job?.id ?? 'unknown' });
    });
    workers.push(maintenanceWorker);
  }

  console.log(`[workers] Started ${workers.length} workers`);
}

/**
 * Gracefully shut down all workers.
 */
export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers.length = 0;
  await stopMaintenanceWorker();
}
