/**
 * Scheduler — manages BullMQ repeatable jobs for transformation schedules.
 *
 * On startup, loads all enabled schedules from the DB and registers them
 * as repeatable jobs. When a schedule is created/updated/deleted via API,
 * the repeatable job is synced accordingly.
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from './redis';
import { TransformationJobData } from './queues';
import { semanticDb } from '../db/knex';
import { trackEvent } from '../utils/monitoring';

const QUEUE_NAME = 'scheduled-transformation';
let schedulerQueue: Queue<TransformationJobData> | null = null;

function getSchedulerQueue(): Queue<TransformationJobData> | null {
  if (schedulerQueue) return schedulerQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  schedulerQueue = new Queue<TransformationJobData>(QUEUE_NAME, { connection: conn });
  return schedulerQueue;
}

/**
 * Register a repeatable job for a schedule.
 * BullMQ uses the jobId as a unique key — updating with the same key replaces the old one.
 */
export async function registerSchedule(schedule: {
  id: number;
  product_id: number;
  tenant_id: number;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  created_by?: string;
}): Promise<void> {
  const queue = getSchedulerQueue();
  if (!queue) return;

  const jobId = `schedule-${schedule.id}`;

  // Remove any existing repeatable with this key first
  await removeSchedule(schedule.id);

  if (!schedule.enabled) return;

  await queue.add(
    'run-transformation',
    {
      productId: schedule.product_id,
      tenantId: schedule.tenant_id,
      triggeredBy: 'schedule',
    },
    {
      repeat: {
        pattern: schedule.cron_expression,
        tz: schedule.timezone,
      },
      jobId,
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: { age: 14 * 24 * 60 * 60 },
    },
  );

  console.log(`[scheduler] Registered schedule ${schedule.id} for product ${schedule.product_id}: ${schedule.cron_expression} (${schedule.timezone})`);
}

/**
 * Remove a repeatable job.
 */
export async function removeSchedule(scheduleId: number): Promise<void> {
  const queue = getSchedulerQueue();
  if (!queue) return;

  // Get all repeatable jobs and find the one matching this schedule
  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === `schedule-${scheduleId}`) {
      await queue.removeRepeatableByKey(r.key);
      console.log(`[scheduler] Removed schedule ${scheduleId}`);
      break;
    }
  }
}

/**
 * Load all enabled schedules from DB and register them.
 * Called once on startup.
 */
export async function loadSchedules(): Promise<void> {
  const queue = getSchedulerQueue();
  if (!queue) {
    console.log('[scheduler] Redis not available — scheduled transformations disabled');
    return;
  }

  const schedules = await semanticDb('transformation_schedules').where({ enabled: true });
  console.log(`[scheduler] Loading ${schedules.length} schedule(s)…`);

  for (const s of schedules) {
    await registerSchedule(s);
  }
}

/**
 * Close the scheduler queue.
 */
export async function closeScheduler(): Promise<void> {
  if (schedulerQueue) {
    await schedulerQueue.close();
    schedulerQueue = null;
  }
}
