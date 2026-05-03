/**
 * Scheduler for `connection_sync_schedules` — registers BullMQ repeatable
 * jobs from rows in the table. On boot, registers all enabled schedules.
 * On schedule create/update/delete via the API, mirrors the change to the
 * BullMQ queue.
 *
 * Mirrors `jobs/scheduler.ts` (the existing transformation scheduler) so
 * the platform has one mental model for "scheduled X" across the app.
 *
 * Cost note: every fired schedule triggers `triggerSync` → orchestrator →
 * `runProfilerInBackground`, which enforces the schema-hash gate. Stable
 * schemas → zero LLM cost on scheduled refreshes. See migration 43.
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from './redis';
import type { ConnectionSyncScheduleJobData } from './queues';
import { semanticDb } from '../db/knex';

const QUEUE_NAME = 'connection-sync-schedule';
let queue: Queue<ConnectionSyncScheduleJobData> | null = null;

function getQueue(): Queue<ConnectionSyncScheduleJobData> | null {
  if (queue) return queue;
  const conn = getRedisConnection();
  if (!conn) return null;
  queue = new Queue<ConnectionSyncScheduleJobData>(QUEUE_NAME, { connection: conn });
  return queue;
}

export interface ConnectionSyncSchedule {
  id: number;
  tenant_id: number;
  connection_id: number;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
}

/** Register or replace a repeatable BullMQ job for a schedule. */
export async function registerConnectionSyncSchedule(s: ConnectionSyncSchedule): Promise<void> {
  const q = getQueue();
  if (!q) return; // Redis not configured — schedule rows persist; no-op on the queue side.

  const jobId = `connsync-${s.id}`;

  // Remove any existing repeatable for this id so updates take effect.
  await removeConnectionSyncSchedule(s.id);

  if (!s.enabled) return;

  await q.add(
    'run-connection-sync',
    { scheduleId: s.id, connectionId: s.connection_id, tenantId: s.tenant_id },
    {
      repeat: {
        pattern: s.cron_expression,
        tz: s.timezone,
      },
      jobId,
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: { age: 14 * 24 * 60 * 60 },
    },
  );
  // eslint-disable-next-line no-console
  console.log(`[connSyncScheduler] Registered schedule ${s.id} for connection ${s.connection_id}: ${s.cron_expression} (${s.timezone})`);
}

/** Remove a previously-registered repeatable. */
export async function removeConnectionSyncSchedule(scheduleId: number): Promise<void> {
  const q = getQueue();
  if (!q) return;
  const repeatables = await q.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === `connsync-${scheduleId}`) {
      await q.removeRepeatableByKey(r.key);
      // eslint-disable-next-line no-console
      console.log(`[connSyncScheduler] Removed schedule ${scheduleId}`);
      break;
    }
  }
}

/**
 * Boot-time: load all enabled schedules and register them. Called from
 * `index.ts` startup alongside the existing transformation scheduler.
 */
export async function loadConnectionSyncSchedules(): Promise<void> {
  const q = getQueue();
  if (!q) {
    // eslint-disable-next-line no-console
    console.log('[connSyncScheduler] Redis not available — connection sync schedules disabled');
    return;
  }
  const rows = await semanticDb('connection_sync_schedules').where({ enabled: true }).select('*');
  for (const r of rows) {
    await registerConnectionSyncSchedule(r);
  }
  // eslint-disable-next-line no-console
  console.log(`[connSyncScheduler] Loaded ${rows.length} enabled connection-sync schedule(s)`);
}
