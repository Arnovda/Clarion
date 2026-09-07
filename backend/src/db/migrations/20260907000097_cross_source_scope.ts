import type { Knex } from 'knex';

/**
 * Let a notebook — and a saved question — reach every source the tenant has.
 *
 * Cross-source is opt-in everywhere, and each surface needs somewhere to
 * remember the choice. Ask AI carries it per question (a request field) and a
 * dashboard carries it in its `spec` JSONB — neither needs a column. A
 * notebook is a durable artefact with no spec blob, so it gets one.
 *
 * Nullable with no default rather than `false`: NULL means "never asked",
 * which is exactly right for every notebook that exists today, and it keeps
 * the column honest if the default ever changes. Only `true` widens.
 *
 * `down` drops it, so the whole chain still rolls back — the `migration-rollback`
 * CI job proves that on every push.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('notebooks', (table) => {
    table.boolean('cross_source').nullable();
  });
  // A saved question needs it for the same reason: its stored SQL was written
  // against a particular set of registered tables. Replayed in a narrower
  // scope, a cross-source question's SQL names a table that is not there — so
  // the verified fast path would silently never fire for exactly the questions
  // that took the most work to get right.
  await knex.schema.alterTable('saved_questions', (table) => {
    table.boolean('cross_source').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('notebooks', (table) => {
    table.dropColumn('cross_source');
  });
  await knex.schema.alterTable('saved_questions', (table) => {
    table.dropColumn('cross_source');
  });
}
