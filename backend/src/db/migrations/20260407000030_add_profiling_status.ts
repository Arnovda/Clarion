import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (t) => {
    t.text('profiling_status').defaultTo(null);   // null | running | done | error
    t.text('profiling_message').defaultTo(null);   // latest progress message
    t.text('profiling_phase').defaultTo(null);     // schema | quality | ai_draft | storing | neo4j | done | error
    t.integer('profiling_progress').defaultTo(null); // 0-100
    t.timestamp('profiling_started_at').defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (t) => {
    t.dropColumn('profiling_status');
    t.dropColumn('profiling_message');
    t.dropColumn('profiling_phase');
    t.dropColumn('profiling_progress');
    t.dropColumn('profiling_started_at');
  });
}
