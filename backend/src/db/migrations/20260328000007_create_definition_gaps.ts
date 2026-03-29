import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('definition_gaps', (table) => {
    table.increments('id').primary();
    table.integer('query_log_id').references('id').inTable('query_log').onDelete('CASCADE');
    table.text('gap_description');
    table.boolean('resolved').defaultTo(false);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('definition_gaps');
}
