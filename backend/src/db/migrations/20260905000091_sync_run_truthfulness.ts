import type { Knex } from 'knex';

/**
 * P0-6 (2026-09-05 market-readiness assessment v2) — the sync tells the truth.
 *
 * Two columns on `source_sync_runs`:
 *   • `mode`            — 'incremental' (the default, what every run was) or
 *                         'full': cursors reset, every table REPLACED. Lets
 *                         the history say why a run took an hour and why the
 *                         row counts jumped.
 *   • `failed_entities` — JSON map entity → error for a run whose worker
 *                         exited cleanly while one or more entities failed.
 *                         Such a run is now persisted with status 'partial'
 *                         (status is free text — no constraint to widen).
 *                         Before: the failure was one line among the
 *                         warnings, the status said 'succeeded', and the
 *                         table held last week's rows under a green badge.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.string('mode', 16).notNullable().defaultTo('incremental');
    t.jsonb('failed_entities').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.dropColumn('failed_entities');
    t.dropColumn('mode');
  });
}
