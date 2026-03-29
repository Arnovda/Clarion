import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('source_tables', (table) => {
    table.increments('id').primary();
    table.integer('connection_id').references('id').inTable('connections').onDelete('CASCADE');
    table.text('table_name').notNullable();
    table.text('display_name');
    table.text('description');
    table.text('owner_name');
    table.boolean('is_active').defaultTo(true);
    table.boolean('ai_draft').defaultTo(true); // true = AI-generated, pending human review
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('source_tables');
}
