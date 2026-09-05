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
import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { readAcrossTenants } from '../services/tenantQuery';
import { trackEvent } from '../utils/monitoring';
import { registerWeeklyMaintenance } from './warehouseMaintenance';
import { registerDailyBrief } from './morningBriefJob';
import { registerSecurityMaintenance } from './securityMaintenanceJob';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'scheduler' });

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

  log.info(`Registered schedule ${schedule.id} for product ${schedule.product_id}: ${schedule.cron_expression} (${schedule.timezone})`);
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
      log.info(`Removed schedule ${scheduleId}`);
      break;
    }
  }
}

/**
 * Every enabled transformation schedule across every active tenant, read
 * per tenant under tenant context (see `readAcrossTenants`). On the root
 * pool with no context the RLS predicate is `tenant_id = NULL` and the
 * production role sees NOTHING — which is what this loader did until
 * 2026-09-05 (assessment v2, P0-2). Exported so the suite can call it as
 * `databridge_app`.
 */
export async function listEnabledTransformationSchedules(db: Knex = semanticDb): Promise<TransformationScheduleRow[]> {
  return readAcrossTenants(db, (trx) =>
    trx('transformation_schedules').where({ enabled: true }).select('*'),
  );
}

export interface TransformationScheduleRow {
  id: number;
  product_id: number;
  tenant_id: number;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  created_by?: string;
}

/**
 * Load all enabled schedules from DB and register them.
 * Called once on startup.
 */
export async function loadSchedules(): Promise<void> {
  const queue = getSchedulerQueue();
  if (!queue) {
    log.info('Redis not available — scheduled transformations disabled');
    return;
  }

  const schedules = await listEnabledTransformationSchedules();
  log.info(`Loading ${schedules.length} schedule(s)…`);

  for (const s of schedules) {
    await registerSchedule(s);
  }

  // Weekly warehouse OPTIMIZE + VACUUM — prevents small-file accumulation
  // from incremental loads. Idempotent; replaces any existing entry.
  await registerWeeklyMaintenance();

  // Daily morning brief — runs the pulse-snapshot + brief-narration
  // pipeline at 06:00 UTC for every active tenant. Idempotent.
  await registerDailyBrief();

  // Daily security housekeeping — cleanup expired/revoked refresh
  // tokens at 03:30 UTC. Keeps the refresh_tokens table small.
  // Idempotent — replaces the existing repeatable if present.
  await registerSecurityMaintenance();
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
