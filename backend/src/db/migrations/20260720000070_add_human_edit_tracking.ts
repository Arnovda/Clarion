import type { Knex } from 'knex';

/**
 * Human-edit tracking — the missing top rung of the semantic precedence
 * ladder (docs/SOURCE_ONBOARDING.md: human > declared/curated > ai_verified
 * > ai_draft; docs/backlog/semantic-enrichment-plan.md Phase 2).
 *
 * `edited_by_user` marks rows whose SEMANTICS a human authored (description,
 * display name, dim/measure role) — a plain confirm of an AI draft does NOT
 * set it. `confirmed_by_user` marks relationships a human explicitly
 * confirmed. The schema profiler snapshots flagged rows before its
 * wipe-and-reinsert and re-applies them afterwards, so curation survives
 * re-profiling.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (t) => {
    t.boolean('edited_by_user').notNullable().defaultTo(false);
  });
  await knex.schema.alterTable('source_columns', (t) => {
    t.boolean('edited_by_user').notNullable().defaultTo(false);
  });
  await knex.schema.alterTable('table_relationships', (t) => {
    t.boolean('confirmed_by_user').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (t) => {
    t.dropColumn('edited_by_user');
  });
  await knex.schema.alterTable('source_columns', (t) => {
    t.dropColumn('edited_by_user');
  });
  await knex.schema.alterTable('table_relationships', (t) => {
    t.dropColumn('confirmed_by_user');
  });
}
