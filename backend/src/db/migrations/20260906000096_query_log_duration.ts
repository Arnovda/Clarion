/**
 * `query_log.duration_ms` — how long a question actually took, end to end.
 *
 * Why (2026-09-06 functional-requirements evaluation, C12): the product
 * overview promises an answer "in under five seconds" and nothing in the
 * platform records how long one takes. Per-CALL durations exist in
 * `ai_call_log`, but a question is one to four calls plus a warehouse query
 * plus policy work, so a model-call duration cannot answer the question the
 * promise makes. This column is the measurement the claim has to be set
 * from — or dropped.
 *
 * Nullable on purpose: every row written before this migration is honestly
 * "not measured", and the percentile query ignores those rather than
 * treating them as zero.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('query_log', 'duration_ms');
  if (!has) {
    await knex.schema.alterTable('query_log', (t) => {
      t.integer('duration_ms');
    });
  }
  // The percentile read is always "this tenant, this window, measured rows".
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_query_log_duration
       ON query_log (tenant_id, created_at DESC)
       WHERE duration_ms IS NOT NULL`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_query_log_duration`);
  const has = await knex.schema.hasColumn('query_log', 'duration_ms');
  if (has) {
    await knex.schema.alterTable('query_log', (t) => {
      t.dropColumn('duration_ms');
    });
  }
}
