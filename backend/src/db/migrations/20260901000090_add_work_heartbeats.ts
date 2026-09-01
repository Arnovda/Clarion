import type { Knex } from 'knex';

/**
 * P1-1 — heartbeats for long-running work.
 *
 * The reapers marked work stale on AGE alone: a running sync or profiling
 * older than 30 minutes was failed, whether its process was dead or
 * mid-way through a perfectly healthy first sync of a large source
 * (reproduced at SQL level before this migration: a running row started
 * 31 minutes ago with activity seconds old was failed by the verbatim
 * reaper rule). Age cannot distinguish "orphaned" from "big"; liveness
 * can. The process doing the work now stamps a heartbeat as it goes —
 * the sync orchestrator already flushes progress to the run row
 * periodically, this just adds a timestamp to the same write — and the
 * reaper keys on heartbeat staleness, with a high absolute ceiling as
 * the backstop.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.timestamp('heartbeat_at', { useTz: true }).nullable();
  });
  await knex.schema.alterTable('connections', (t) => {
    t.timestamp('profiling_heartbeat_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.dropColumn('heartbeat_at');
  });
  await knex.schema.alterTable('connections', (t) => {
    t.dropColumn('profiling_heartbeat_at');
  });
}
