import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('product_tables', (t) => {
    t.integer('neo4j_pg_id').nullable().unique();
  });
  await knex.schema.alterTable('product_columns', (t) => {
    t.integer('neo4j_pg_id').nullable().unique();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('product_tables', (t) => {
    t.dropColumn('neo4j_pg_id');
  });
  await knex.schema.alterTable('product_columns', (t) => {
    t.dropColumn('neo4j_pg_id');
  });
}
