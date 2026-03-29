import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (table) => {
    table.jsonb('domains').defaultTo('[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (table) => {
    table.dropColumn('domains');
  });
}
