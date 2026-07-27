/**
 * Morning brief job — daily repeatable that runs the brief pipeline
 * across every active tenant + user. Mirrors the pattern of
 * warehouseMaintenance.ts (queue + worker + register-on-startup), so
 * if Redis isn't configured the worker simply doesn't start and the
 * pipeline is reachable only via the manual `/api/briefs/run-now`
 * route.
 *
 * Cadence: daily at 06:00 UTC by default. Override with
 * MORNING_BRIEF_CRON. Phase: per-user time + timezone is a future
 * enhancement (today everyone gets the same UTC slot).
 */

import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from './redis';
import { shouldRunQueue } from './queueRoles';
import { runDailyBriefs } from '../services/morningBriefService';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'morning-brief';
const DAILY_CRON = process.env.MORNING_BRIEF_CRON ?? '0 6 * * *';

const log = logger.child({ module: 'morning-brief' });

interface BriefJobData {
  triggeredBy: string;
}

let briefQueue: Queue<BriefJobData> | null = null;
let briefWorker: Worker | null = null;

function getQueue(): Queue<BriefJobData> | null {
  if (briefQueue) return briefQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  briefQueue = new Queue<BriefJobData>(QUEUE_NAME, { connection: conn });
  return briefQueue;
}

export function startMorningBriefWorker(): Worker | null {
  // This queue may belong to the other container — see queueRoles.
  if (!shouldRunQueue('morning-brief')) return null;
  if (briefWorker) return briefWorker;
  const conn = getRedisConnection();
  if (!conn) {
    log.info('Redis unavailable — skipping morning brief worker');
    return null;
  }

  briefWorker = new Worker<BriefJobData>(
    QUEUE_NAME,
    async (job: Job<BriefJobData>) => {
      log.info({ jobId: job.id, triggeredBy: job.data.triggeredBy }, 'morning brief run start');
      const result = await runDailyBriefs();
      log.info({ result }, 'morning brief run done');
      return result;
    },
    { connection: conn, concurrency: 1 },
  );

  briefWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'morning brief job failed');
  });

  return briefWorker;
}

export async function registerDailyBrief(): Promise<void> {
  const queue = getQueue();
  if (!queue) return;

  const jobId = 'morning-brief-daily';

  // Replace any existing repeatable with this key (in case the cron changed).
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
      repeat: { pattern: DAILY_CRON },
      jobId,
      removeOnComplete: { age: 14 * 24 * 60 * 60 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  );

  log.info({ cron: DAILY_CRON }, 'Daily morning brief registered');
}

export async function stopMorningBriefWorker(): Promise<void> {
  if (briefWorker) {
    await briefWorker.close();
    briefWorker = null;
  }
  if (briefQueue) {
    await briefQueue.close();
    briefQueue = null;
  }
}
