/**
 * Per-tenant schedule (un)registration — the runtime twin of the boot-time
 * loaders. The loaders read every ACTIVE tenant's enabled schedules at boot
 * (P0-2, 2026-09-05); a tenant suspended or resumed by the operator console
 * mid-flight must not have to wait for the next boot: suspend removes its
 * repeatables so a suspended customer's syncs and report emails stop firing,
 * resume puts them back. Every read runs under the tenant's own context.
 *
 * Best-effort by design: BullMQ is unavailable in inline mode and a Redis
 * blip must not fail the status change (Postgres is the source of truth and
 * the reconciler re-registers on reconnect).
 */
import { tenantQuery } from '../services/tenantQuery';
import { registerSchedule, removeSchedule } from './scheduler';
import { registerEmailSchedule, unregisterEmailSchedule } from './emailScheduler';
import { registerConnectionSyncSchedule, removeConnectionSyncSchedule } from './connectionSyncScheduler';
import { registerPipelineTriggers, unregisterPipelineTriggers } from './pipelineScheduler';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'tenant-schedules' });

interface TenantScheduleRows {
  transformation: Array<{ id: number; product_id: number; tenant_id: number; cron_expression: string; timezone: string; enabled: boolean }>;
  email: Array<{ id: number; tenant_id: number; cron_expression: string; enabled: boolean }>;
  connectionSync: Array<{ id: number; tenant_id: number; connection_id: number; cron_expression: string; timezone: string; enabled: boolean }>;
  pipelines: Array<{ id: number; tenant_id: number; enabled: boolean; triggers: unknown }>;
}

async function readTenantSchedules(tenantId: number, enabledOnly: boolean): Promise<TenantScheduleRows> {
  return tenantQuery(tenantId, async (trx) => {
    const where = enabledOnly ? { tenant_id: tenantId, enabled: true } : { tenant_id: tenantId };
    const [transformation, email, connectionSync, pipelines] = await Promise.all([
      trx('transformation_schedules').where(where).select('*'),
      trx('email_schedules').where(where).select('id', 'tenant_id', 'cron_expression', 'enabled'),
      trx('connection_sync_schedules').where(where).select('*'),
      trx('pipelines').where(where).select('id', 'tenant_id', 'enabled', 'triggers'),
    ]);
    return { transformation, email, connectionSync, pipelines };
  });
}

/** Register every ENABLED schedule of one tenant (resume, or a fresh onboarding). */
export async function registerSchedulesForTenant(tenantId: number): Promise<number> {
  const rows = await readTenantSchedules(tenantId, true);
  let n = 0;
  for (const s of rows.transformation) { await registerSchedule(s); n++; }
  for (const s of rows.email) { await registerEmailSchedule(s); n++; }
  for (const s of rows.connectionSync) { await registerConnectionSyncSchedule(s); n++; }
  for (const p of rows.pipelines) { await registerPipelineTriggers(p); n++; }
  log.info({ tenantId, registered: n }, 'tenant schedules registered');
  return n;
}

/** Remove every schedule of one tenant from the queues (suspend). Rows stay. */
export async function unregisterSchedulesForTenant(tenantId: number): Promise<number> {
  const rows = await readTenantSchedules(tenantId, false);
  let n = 0;
  for (const s of rows.transformation) { await removeSchedule(s.id); n++; }
  for (const s of rows.email) { await unregisterEmailSchedule(s.id); n++; }
  for (const s of rows.connectionSync) { await removeConnectionSyncSchedule(s.id); n++; }
  for (const p of rows.pipelines) { await unregisterPipelineTriggers(p.id); n++; }
  log.info({ tenantId, unregistered: n }, 'tenant schedules unregistered');
  return n;
}
