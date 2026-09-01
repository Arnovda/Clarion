/**
 * Stale-work reapers (P1-1) — extracted from index.ts and re-keyed on
 * LIVENESS instead of age.
 *
 * The old rules failed anything 'running' for more than 30 minutes. That
 * conflates two states age cannot separate: an ORPHANED row (the process
 * died without a terminal write — the thing a reaper exists for) and a
 * perfectly healthy long run (a large source's first sync, a 60-entity
 * profiling with its AI passes). Reproduced red before this change: a
 * running sync started 31 minutes ago, with activity seconds old, was
 * failed by the verbatim old rule.
 *
 * New rule, per kind of work:
 *   - stale when the HEARTBEAT is old (`HEARTBEAT_STALE_MINUTES`, 10) —
 *     the worker stamps it as it makes progress (the sync orchestrator's
 *     existing periodic flush; the profiler's phase persists), so a dead
 *     process stops stamping within seconds of dying;
 *   - OR when an absolute ceiling passes (`WORK_CEILING_HOURS`, 4) —
 *     the backstop for a process that is alive but wedged in a loop that
 *     still stamps. (Syncs also have the orchestrator's own
 *     SYNC_MAX_DURATION_MS wall-clock cancel, which stays the deliberate
 *     per-run limit; this ceiling only catches the orchestrator itself
 *     being gone or wedged.)
 *   Rows written before the heartbeat columns existed COALESCE back to
 *   their start stamps, so the old behaviour degrades gracefully rather
 *   than never reaping them.
 *
 * This re-keying is also what unpins the platform's scaling: the
 * "jobs-worker stays at one replica" rule existed because age-only
 * reapers plus more parallel long work meant more healthy work reaped.
 * With liveness-based reaping, parallel long runs are safe.
 *
 * Runs from index.ts's 5-minute tick, in the process that owns the
 * schedulers (RUN_SCHEDULERS gating unchanged).
 */

import type { Knex } from 'knex';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'reapers' });

export const HEARTBEAT_STALE_MINUTES = 10;
export const WORK_CEILING_HOURS = 4;

export interface ReapCounts {
  ingestion: number;
  profiling: number;
  syncRuns: number;
}

export async function reapStaleWork(db: Knex): Promise<ReapCounts> {
  const beat = `${HEARTBEAT_STALE_MINUTES} minutes`;
  const ceiling = `${WORK_CEILING_HOURS} hours`;

  // Legacy ETL ingestion — superseded by the source-connector flow and it
  // shows: the old rule keyed on connections.created_at, which is when the
  // CONNECTION was made, so any ingestion on a connection older than 30
  // minutes was reaped within one tick of starting. There is no ingestion
  // start stamp to do better with, so this now reaps only at the absolute
  // ceiling — a stuck legacy ingestion lingers longer, a fresh one is no
  // longer killed at birth.
  const ingestion = await db('connections')
    .where('ingestion_status', 'running')
    .whereRaw(`created_at < NOW() - INTERVAL '${ceiling}'`)
    .update({
      ingestion_status: 'error',
      ingestion_error: `Ingestion timed out (>${WORK_CEILING_HOURS} hours)`,
    });

  const profiling = await db('connections')
    .where('profiling_status', 'running')
    .whereNotNull('profiling_started_at')
    .whereRaw(
      `(COALESCE(profiling_heartbeat_at, profiling_started_at) < NOW() - INTERVAL '${beat}'
        OR profiling_started_at < NOW() - INTERVAL '${ceiling}')`,
    )
    .update({
      profiling_status: 'error',
      profiling_phase: 'error',
      profiling_message: `Profiling appears dead (no progress for ${HEARTBEAT_STALE_MINUTES} minutes)`,
      profiling_progress: 0,
    });

  // 'queued' rows have no heartbeat by construction (nothing is running
  // yet); the launch follows the insert within seconds, so a queued row
  // that is minutes old IS orphaned and ages out on its queued_at.
  const syncRuns = await db('source_sync_runs')
    .whereIn('status', ['queued', 'running'])
    .whereRaw(
      `(COALESCE(heartbeat_at, started_at, queued_at) < NOW() - INTERVAL '${beat}'
        OR COALESCE(started_at, queued_at) < NOW() - INTERVAL '${ceiling}')`,
    )
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: `Sync appears dead (no progress heartbeat for ${HEARTBEAT_STALE_MINUTES} minutes)`,
    });

  if (syncRuns > 0) {
    // Keep the denormalised connection status truthful, same as before.
    await db('connections')
      .whereIn('last_sync_status', ['queued', 'running'])
      .whereRaw(`NOT EXISTS (
        SELECT 1 FROM source_sync_runs s
        WHERE s.connection_id = connections.id
          AND s.status IN ('queued','running')
      )`)
      .update({ last_sync_status: 'failed' });
  }

  if (ingestion > 0) log.info({ count: ingestion }, '[cleanup] reaped stale legacy ingestion(s)');
  if (profiling > 0) log.info({ count: profiling }, '[cleanup] reaped dead profiling run(s)');
  if (syncRuns > 0) log.info({ count: syncRuns }, '[cleanup] reaped dead sync run(s)');

  return { ingestion, profiling, syncRuns };
}
