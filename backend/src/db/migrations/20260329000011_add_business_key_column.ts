import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (t) => {
    t.text('business_key_column').nullable();
  });
  await knex.schema.alterTable('dataset_profiles', (t) => {
    t.text('business_key_column').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_tables', (t) => {
    t.dropColumn('business_key_column');
  });
  await knex.schema.alterTable('dataset_profiles', (t) => {
    t.dropColumn('business_key_column');
  });
}
