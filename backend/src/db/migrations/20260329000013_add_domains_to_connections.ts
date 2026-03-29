import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (table) => {
    table.jsonb('domains').defaultTo('[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connections', (table) => {
    table.dropColumn('domains');
  });
}
