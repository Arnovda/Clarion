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
import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { readAcrossTenants } from '../services/tenantQuery';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'connSyncScheduler' });

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
  log.info(`Registered schedule ${s.id} for connection ${s.connection_id}: ${s.cron_expression} (${s.timezone})`);
}

/** Remove a previously-registered repeatable. */
export async function removeConnectionSyncSchedule(scheduleId: number): Promise<void> {
  const q = getQueue();
  if (!q) return;
  const repeatables = await q.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === `connsync-${scheduleId}`) {
      await q.removeRepeatableByKey(r.key);
      log.info(`Removed schedule ${scheduleId}`);
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
    log.info('Redis not available — connection sync schedules disabled');
    return;
  }
  const rows = await listEnabledConnectionSyncSchedules();
  for (const r of rows) {
    await registerConnectionSyncSchedule(r);
  }
  // Load-bearing line: the production check for P0-2 (assessment v2 §8)
  // compares N here with the enabled rows in the table.
  log.info(`Loaded ${rows.length} enabled connection-sync schedule(s)`);
}

/**
 * Every enabled connection-sync schedule across every active tenant, read
 * per tenant under tenant context (P0-2, 2026-09-05 — the root-pool read
 * returned zero rows under `databridge_app`).
 */
export async function listEnabledConnectionSyncSchedules(db: Knex = semanticDb): Promise<ConnectionSyncSchedule[]> {
  return readAcrossTenants(db, (trx) =>
    trx('connection_sync_schedules').where({ enabled: true }).select('*'),
  );
}
