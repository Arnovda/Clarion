/**
 * Security maintenance — daily cron that performs housekeeping on
 * security-relevant state:
 *
 *   - Cleanup expired+revoked refresh tokens (keeps the table small)
 *   - (Future) Rotate logs older than retention window
 *   - (Future) Stale-session warnings
 *
 * Mirrors the pattern of `morningBriefJob.ts` / `warehouseMaintenanceJob.ts`:
 * queue + worker + repeatable schedule. If Redis isn't configured the
 * worker doesn't start (dev / no-redis deployments). The pipeline is
 * also reachable manually via the worker's job name for ops debugging.
 *
 * Default cadence: daily at 03:30 UTC (off-peak, after warehouse
 * maintenance at 03:00). Override with `SECURITY_MAINTENANCE_CRON`.
 */

import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './redis';
import { shouldRunQueue } from './queueRoles';
import { logger } from '../utils/logger';
import { cleanupExpiredAndRevoked } from '../services/refreshTokenService';

const QUEUE_NAME = 'security-maintenance';
const DAILY_CRON = process.env.SECURITY_MAINTENANCE_CRON ?? '30 3 * * *';

const log = logger.child({ module: 'security-maintenance' });

interface JobData {
  triggeredBy: string;
}

let queue: Queue<JobData> | null = null;
let worker: Worker | null = null;

function getQueue(): Queue<JobData> | null {
  if (queue) return queue;
  const conn = getRedisConnection();
  if (!conn) return null;
  queue = new Queue<JobData>(QUEUE_NAME, { connection: conn });
  return queue;
}

export function startSecurityMaintenanceWorker(): Worker | null {
  // This queue may belong to the other container — see queueRoles.
  if (!shouldRunQueue('security-maintenance')) return null;
  if (worker) return worker;
  const conn = getRedisConnection();
  if (!conn) {
    log.info('Redis unavailable — skipping security maintenance worker');
    return null;
  }

  worker = new Worker<JobData>(
    QUEUE_NAME,
    async (job: Job<JobData>) => {
      log.info({ jobId: job.id, triggeredBy: job.data.triggeredBy }, 'security maintenance start');
      const result = await runSecurityMaintenance();
      log.info({ result }, 'security maintenance done');
      return result;
    },
    { connection: conn, concurrency: 1 },
  );

  worker.on('failed', (j, err) => {
    log.error({ jobId: j?.id, err: err.message }, 'security maintenance job failed');
  });

  return worker;
}

async function runSecurityMaintenance(): Promise<{
  refreshTokensDeleted: number;
}> {
  const refresh = await cleanupExpiredAndRevoked().catch((err) => {
    log.error({ err }, 'refresh-token cleanup failed (non-fatal)');
    return { deleted: 0 };
  });
  return { refreshTokensDeleted: refresh.deleted };
}

export async function registerSecurityMaintenance(): Promise<void> {
  const q = getQueue();
  if (!q) return;

  const jobId = 'security-maintenance-daily';

  // Replace any existing repeatable with this key (in case the cron changed).
  const repeatables = await q.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === jobId) {
      await q.removeRepeatableByKey(r.key);
    }
  }

  await q.add(
    'run',
    { triggeredBy: 'cron' },
    {
      repeat: { pattern: DAILY_CRON },
      jobId,
      removeOnComplete: { age: 14 * 24 * 60 * 60 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  );

  log.info({ cron: DAILY_CRON }, 'Daily security maintenance registered');
}

export async function stopSecurityMaintenanceWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
