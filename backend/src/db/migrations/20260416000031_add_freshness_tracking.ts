import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (t) => {
    t.timestamp('last_synced_at').defaultTo(null);     // when data was last ingested
    t.timestamp('last_profiled_at').defaultTo(null);    // when quality profiling last ran
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (t) => {
    t.dropColumn('last_synced_at');
    t.dropColumn('last_profiled_at');
  });
}
