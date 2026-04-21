/**
 * BullMQ repeatable job management for email report schedules.
 *
 * On startup: reads all enabled email_schedules rows and registers
 * a repeatable BullMQ job for each. The job key is `email-report:<scheduleId>`.
 *
 * When a schedule is created/updated/deleted via the API, the caller
 * re-registers or removes the repeatable job via registerEmailSchedule /
 * unregisterEmailSchedule.
 */

import { getEmailReportQueue } from './queues';
import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

function jobName(scheduleId: number): string {
  return `email-report:${scheduleId}`;
}

export async function registerEmailSchedule(schedule: {
  id: number;
  tenant_id: number;
  cron_expression: string;
  enabled: boolean;
}): Promise<void> {
  const q = getEmailReportQueue();
  if (!q) return; // Redis not available — schedules run inline on send-now only

  if (!schedule.enabled) return;

  await q.add(
    jobName(schedule.id),
    { scheduleId: schedule.id, tenantId: schedule.tenant_id },
    {
      repeat: { pattern: schedule.cron_expression, tz: 'UTC' },
      jobId: jobName(schedule.id),
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail:    { age: 14 * 24 * 60 * 60 },
    },
  );

  logger.info({ scheduleId: schedule.id, cron: schedule.cron_expression }, '[email-scheduler] registered');
}

export async function unregisterEmailSchedule(scheduleId: number): Promise<void> {
  const q = getEmailReportQueue();
  if (!q) return;

  try {
    await q.removeRepeatable(jobName(scheduleId), { pattern: '' });
  } catch {
    // BullMQ throws if the job doesn't exist — ignore
  }

  logger.info({ scheduleId }, '[email-scheduler] unregistered');
}

export async function loadEmailSchedules(): Promise<void> {
  const q = getEmailReportQueue();
  if (!q) {
    logger.info('[email-scheduler] Redis not available — email schedules disabled');
    return;
  }

  try {
    const schedules = await semanticDb('email_schedules').where({ enabled: true });

    for (const s of schedules) {
      await registerEmailSchedule(s);
    }

    logger.info({ count: schedules.length }, '[email-scheduler] loaded schedules');
  } catch (err) {
    logger.error({ err }, '[email-scheduler] failed to load schedules on startup');
  }
}
