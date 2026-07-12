/**
 * Scheduler for pipeline cron triggers — registers BullMQ repeatable
 * jobs from `pipelines.triggers` (kind === 'cron'). The on-source-sync
 * trigger kind is handled separately, in-process, via
 * `firePipelineTriggersOnSourceSync()` (also exported here so the
 * SyncOrchestrator only imports one module).
 *
 * Mirrors `connectionSyncScheduler.ts` so the platform has one mental
 * model for "scheduled X" across the app.
 *
 * jobId convention: `pipeline-cron-${pipelineId}-${idx}` — a single
 * pipeline can carry multiple cron triggers (different schedules), so we
 * suffix with the trigger array index. The whole set is replaced on
 * every register call (idempotent).
 */

import { getPipelineScheduleQueue } from './queues';
import type { PipelineScheduleJobData } from './queues';
import { semanticDb } from '../db/knex';
import { enqueueSavedPipelineRun, type PipelineTrigger } from '../services/pipelineService';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'pipelineScheduler' });

interface PipelineRow {
  id: number;
  tenant_id: number;
  enabled: boolean;
  triggers: unknown; // JSONB — string OR parsed array depending on driver
}

function parseTriggers(raw: unknown): PipelineTrigger[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? (arr as PipelineTrigger[]) : [];
  } catch {
    return [];
  }
}

/**
 * Register or replace BullMQ repeatables for every cron trigger on a
 * pipeline. Always wipes the existing set first so updates take effect
 * cleanly (no stale repeatables left behind when triggers shrink or the
 * pipeline is disabled).
 */
export async function registerPipelineTriggers(pipeline: PipelineRow): Promise<void> {
  const q = getPipelineScheduleQueue();
  if (!q) return; // Redis not configured — silent no-op (manual runs still work)

  // Wipe-and-replace so updates / disables / shrinks work atomically.
  await unregisterPipelineTriggers(pipeline.id);

  if (!pipeline.enabled) return;

  const triggers = parseTriggers(pipeline.triggers);
  let cronIdx = 0;
  for (const t of triggers) {
    if (t.kind !== 'cron') continue;
    if (typeof t.cron !== 'string' || !t.cron.trim()) continue;
    const jobId = `pipeline-cron-${pipeline.id}-${cronIdx}`;
    cronIdx++;
    const data: PipelineScheduleJobData = { pipelineId: pipeline.id, tenantId: pipeline.tenant_id };
    await q.add(
      'run-pipeline-cron',
      data,
      {
        repeat: {
          pattern: t.cron,
          tz: t.tz || 'UTC',
        },
        jobId,
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 14 * 24 * 60 * 60 },
      },
    );
    log.info(`Registered cron ${jobId}: ${t.cron} (${t.tz || 'UTC'})`);
  }
}

/**
 * Remove every repeatable belonging to a pipeline, regardless of how
 * many cron triggers it had. Matches by id prefix so we don't have to
 * remember the exact count.
 */
export async function unregisterPipelineTriggers(pipelineId: number): Promise<void> {
  const q = getPipelineScheduleQueue();
  if (!q) return;
  const prefix = `pipeline-cron-${pipelineId}-`;
  const repeatables = await q.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id?.startsWith(prefix)) {
      await q.removeRepeatableByKey(r.key);
      log.info(`Removed ${r.id}`);
    }
  }
}

/**
 * Boot-time: load every enabled pipeline and register its cron triggers.
 * Called from `index.ts` startup alongside the other schedulers.
 */
export async function loadPipelineSchedules(): Promise<void> {
  const q = getPipelineScheduleQueue();
  if (!q) {
    log.info('Redis not available — pipeline triggers disabled');
    return;
  }
  const rows = await semanticDb('pipelines').where({ enabled: true }).select('id', 'tenant_id', 'enabled', 'triggers');
  let cronCount = 0;
  for (const r of rows) {
    const triggers = parseTriggers(r.triggers);
    cronCount += triggers.filter((t) => t.kind === 'cron').length;
    await registerPipelineTriggers(r as PipelineRow);
  }
  log.info(`Loaded ${rows.length} pipeline(s), ${cronCount} cron trigger(s)`);
}

/**
 * Fire-and-forget hook called by `SyncOrchestrator` when a source sync
 * succeeds. Finds every enabled pipeline with an
 * `on_source_sync_succeeded` trigger matching the connection and
 * enqueues a run for each.
 *
 * Runs in-process (no queue ping-pong) — the actual pipeline run still
 * goes through the bus-matrix queue, this hook just decides which
 * pipelines to enqueue.
 *
 * Errors are swallowed: a missing trigger or downstream queue failure
 * must not fail the source sync (which already succeeded). They're
 * logged to the console for diagnostics.
 */
export async function firePipelineTriggersOnSourceSync(opts: {
  connectionId: number;
  tenantId: number;
}): Promise<void> {
  try {
    await semanticDb.raw(`SET app.current_tenant = '${Number(opts.tenantId)}'`);
    const rows = await semanticDb('pipelines')
      .where({ tenant_id: opts.tenantId, enabled: true })
      .select<Array<{ id: number; triggers: unknown }>>('id', 'triggers');
    const matches: number[] = [];
    for (const r of rows) {
      const triggers = parseTriggers(r.triggers);
      const hit = triggers.some((t) =>
        t.kind === 'on_source_sync_succeeded' && t.sourceId === opts.connectionId,
      );
      if (hit) matches.push(r.id);
    }
    if (matches.length === 0) return;
    log.info(
      `Source ${opts.connectionId} synced — firing ${matches.length} pipeline(s): ${matches.join(', ')}`,
    );
    for (const pipelineId of matches) {
      await enqueueSavedPipelineRun({
        pipelineId,
        tenantId: opts.tenantId,
        triggeredBy: `on-source-sync:${opts.connectionId}`,
      });
    }
  } catch (err) {
    log.error({ err }, 'firePipelineTriggersOnSourceSync error');
  }
}
