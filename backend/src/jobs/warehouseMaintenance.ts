/**
 * Warehouse maintenance — weekly OPTIMIZE (file compaction) + VACUUM (purge
 * stale Parquet versions past retention) across every connection's Delta
 * warehouse. Keeps query latency from degrading as incremental loads
 * accumulate small files.
 *
 * Exposed two ways:
 *   - a repeatable BullMQ job (registered from scheduler.ts on startup)
 *   - a direct `runMaintenance(opts)` call (used by the on-demand admin
 *     endpoint and inline fallback when Redis is unavailable)
 *
 * The actual OPTIMIZE/VACUUM is executed by the Python ETL service
 * (`POST /optimize`) — this module is just orchestration.
 */

import axios from 'axios';
import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './redis';
import { shouldRunQueue } from './queueRoles';
import { semanticDb } from '../db/knex';
import { DuckDBConnector } from '../connectors/DuckDBConnector';
import { logger } from '../utils/logger';

const ETL_URL = process.env.ETL_URL || 'http://localhost:8000';
const QUEUE_NAME = 'warehouse-maintenance';

// Sunday 03:00 in whatever timezone the backend runs in.
// Conservative default — can be overridden via env.
const WEEKLY_CRON = process.env.WAREHOUSE_MAINTENANCE_CRON ?? '0 3 * * 0';

const log = logger.child({ module: 'warehouse-maintenance' });

interface MaintenanceJobData {
  triggeredBy: string;
  connectionId?: number; // optional: run for a single connection
}

interface TableResult {
  delta_path: string;
  compact?: unknown;
  vacuum_files_removed?: number | unknown;
  error?: string;
}

interface ConnectionResult {
  connectionId: number;
  tenantId: number;
  warehousePath: string;
  ok: boolean;
  tables?: number;
  errors?: number;
  results?: TableResult[];
  error?: string;
}

let maintenanceQueue: Queue<MaintenanceJobData> | null = null;
let maintenanceWorker: Worker | null = null;

function getQueue(): Queue<MaintenanceJobData> | null {
  if (maintenanceQueue) return maintenanceQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  maintenanceQueue = new Queue<MaintenanceJobData>(QUEUE_NAME, { connection: conn });
  return maintenanceQueue;
}

/**
 * Run maintenance over one or all connections. Always returns a per-connection
 * report — single connection failures do not abort the run.
 */
export async function runMaintenance(opts: {
  connectionId?: number;
  triggeredBy?: string;
} = {}): Promise<ConnectionResult[]> {
  const started = Date.now();

  const connsQuery = semanticDb('connections')
    .whereNotNull('warehouse_path')
    .where('ingestion_status', 'done')
    .select('id', 'tenant_id', 'warehouse_path');

  if (opts.connectionId) connsQuery.where({ id: opts.connectionId });

  const connections = await connsQuery;
  log.info({ connections: connections.length, triggeredBy: opts.triggeredBy }, 'warehouse maintenance start');

  const results: ConnectionResult[] = [];

  for (const conn of connections) {
    const tableNames: string[] = (
      await semanticDb('ingested_tables')
        .where({ connection_id: conn.id, status: 'done' })
        .select('table_name')
    ).map((r: { table_name: string }) => r.table_name);

    try {
      const etlRes = await axios.post(
        `${ETL_URL}/optimize`,
        {
          connection_id: conn.id,
          tenant_id: conn.tenant_id,
          table_names: tableNames,
        },
        { timeout: 10 * 60 * 1000 },
      );
      const payload = etlRes.data as { results?: TableResult[] };
      const tableResults = payload.results ?? [];
      const errors = tableResults.filter((t) => t.error).length;

      // After compaction, invalidate any pooled DuckDB instances so fresh
      // views pick up the consolidated files (and smaller file count).
      try {
        await DuckDBConnector.invalidateWarehouse(conn.warehouse_path);
      } catch (invErr) {
        log.warn({ err: invErr, connectionId: conn.id }, 'pool invalidation failed');
      }

      results.push({
        connectionId: conn.id,
        tenantId: conn.tenant_id,
        warehousePath: conn.warehouse_path,
        ok: true,
        tables: tableResults.length,
        errors,
        results: tableResults,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ connectionId: conn.id, err: msg }, 'maintenance failed for connection');
      results.push({
        connectionId: conn.id,
        tenantId: conn.tenant_id,
        warehousePath: conn.warehouse_path,
        ok: false,
        error: msg,
      });
    }
  }

  log.info({ durationMs: Date.now() - started, results: results.length }, 'warehouse maintenance done');
  return results;
}

/**
 * Start the worker. Called from startWorkers() in workers.ts. If Redis isn't
 * configured, we silently do nothing — the manual endpoint still works via
 * inline `runMaintenance()` and there's no scheduled cadence.
 */
export function startMaintenanceWorker(): Worker | null {
  // This queue may belong to the other container — see queueRoles.
  if (!shouldRunQueue('warehouse-maintenance')) return null;
  if (maintenanceWorker) return maintenanceWorker;
  const conn = getRedisConnection();
  if (!conn) {
    log.info('Redis unavailable — skipping warehouse maintenance worker');
    return null;
  }

  maintenanceWorker = new Worker<MaintenanceJobData>(
    QUEUE_NAME,
    async (job: Job<MaintenanceJobData>) => {
      return runMaintenance({
        connectionId: job.data.connectionId,
        triggeredBy: job.data.triggeredBy,
      });
    },
    { connection: conn, concurrency: 1 },
  );

  maintenanceWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'warehouse maintenance job failed');
  });

  return maintenanceWorker;
}

/**
 * Register the weekly repeatable. Called once from scheduler.ts loadSchedules().
 * Safe to call multiple times — BullMQ replaces the existing entry by jobId.
 */
export async function registerWeeklyMaintenance(): Promise<void> {
  const queue = getQueue();
  if (!queue) return;

  const jobId = 'warehouse-maintenance-weekly';

  // Clear stale repeatables with this key (if the cron string changed).
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === jobId) {
      await queue.removeRepeatableByKey(r.key);
    }
  }

  await queue.add(
    'run',
    { triggeredBy: 'cron' },
    {
      repeat: { pattern: WEEKLY_CRON },
      jobId,
      removeOnComplete: { age: 30 * 24 * 60 * 60 },
      removeOnFail: { age: 60 * 24 * 60 * 60 },
    },
  );

  log.info({ cron: WEEKLY_CRON }, 'Weekly warehouse maintenance registered');
}

/** Enqueue an immediate one-off run. Falls back to inline execution without Redis. */
export async function triggerMaintenanceNow(opts: {
  connectionId?: number;
  triggeredBy: string;
}): Promise<{ mode: 'queued' | 'inline'; results?: ConnectionResult[] }> {
  const queue = getQueue();
  if (queue) {
    await queue.add('run', opts, {
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    return { mode: 'queued' };
  }
  const results = await runMaintenance(opts);
  return { mode: 'inline', results };
}

export async function stopMaintenanceWorker(): Promise<void> {
  if (maintenanceWorker) {
    await maintenanceWorker.close();
    maintenanceWorker = null;
  }
  if (maintenanceQueue) {
    await maintenanceQueue.close();
    maintenanceQueue = null;
  }
}
