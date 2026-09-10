import type { Knex } from 'knex';

/**
 * Ingestion chain, phase 2 (docs/backlog/ingestion-chain-assessment.md §7):
 * per-entity state, resumable loads, reconcile runs.
 *
 * `entity_sync_cursors` becomes the per-(connection, entity) STATE row, not
 * only the watermark (B6): `cursor_type` / `cursor_value` turn nullable so
 * an always-full entity, or one whose first pull failed, can carry a status
 * and a row count without inventing a cursor; `rows_total` is what the table
 * HOLDS after the last write (soft-deleted rows excluded) — the number the
 * catalog shows; `last_status` gains 'incomplete' for an entity a run
 * stopped at its time budget after a checkpoint (B3).
 *
 * `source_sync_runs` gains `resumed_from_run_id` (a continuation run names
 * the run it continues, so the history reads as one load in several parts)
 * and `incomplete_entities` (what that continuation still has to do). `mode`
 * may now also be 'reconcile' (B2; free text, no constraint to widen).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE entity_sync_cursors ALTER COLUMN cursor_type DROP NOT NULL`);
  await knex.raw(`ALTER TABLE entity_sync_cursors ALTER COLUMN cursor_value DROP NOT NULL`);
  await knex.schema.alterTable('entity_sync_cursors', (t) => {
    t.bigInteger('rows_total').nullable();
  });
  await knex.raw(`ALTER TABLE entity_sync_cursors DROP CONSTRAINT IF EXISTS entity_sync_cursors_last_status_check`);
  await knex.raw(`
    ALTER TABLE entity_sync_cursors
      ADD CONSTRAINT entity_sync_cursors_last_status_check
      CHECK (last_status IN ('success', 'failed', 'incomplete'))
  `);
  // A cursor is either fully described or absent — never half.
  await knex.raw(`ALTER TABLE entity_sync_cursors DROP CONSTRAINT IF EXISTS entity_sync_cursors_cursor_pair_check`);
  await knex.raw(`
    ALTER TABLE entity_sync_cursors
      ADD CONSTRAINT entity_sync_cursors_cursor_pair_check
      CHECK ((cursor_type IS NULL) = (cursor_value IS NULL))
  `);

  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.integer('resumed_from_run_id').nullable().references('id').inTable('source_sync_runs').onDelete('SET NULL');
    t.jsonb('incomplete_entities').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.dropColumn('incomplete_entities');
    t.dropColumn('resumed_from_run_id');
  });
  await knex.raw(`ALTER TABLE entity_sync_cursors DROP CONSTRAINT IF EXISTS entity_sync_cursors_cursor_pair_check`);
  await knex.raw(`ALTER TABLE entity_sync_cursors DROP CONSTRAINT IF EXISTS entity_sync_cursors_last_status_check`);
  // Rows that only carry state (no cursor) cannot survive the NOT NULL; they
  // are re-derived from the next sync.
  await knex('entity_sync_cursors').whereNull('cursor_value').del();
  await knex.raw(`UPDATE entity_sync_cursors SET last_status = 'failed' WHERE last_status = 'incomplete'`);
  await knex.raw(`
    ALTER TABLE entity_sync_cursors
      ADD CONSTRAINT entity_sync_cursors_last_status_check
      CHECK (last_status IN ('success', 'failed'))
  `);
  await knex.schema.alterTable('entity_sync_cursors', (t) => {
    t.dropColumn('rows_total');
  });
  await knex.raw(`ALTER TABLE entity_sync_cursors ALTER COLUMN cursor_value SET NOT NULL`);
  await knex.raw(`ALTER TABLE entity_sync_cursors ALTER COLUMN cursor_type SET NOT NULL`);
}
