import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('source_columns', (table) => {
    table.increments('id').primary();
    table.integer('table_id').references('id').inTable('source_tables').onDelete('CASCADE');
    table.text('column_name').notNullable();
    table.text('data_type');
    table.text('display_name');
    table.text('description');
    table.jsonb('example_values'); // up to 5 sample values
    table.boolean('is_dimension').defaultTo(false); // e.g. customer name, product category
    table.boolean('is_measure').defaultTo(false);   // e.g. revenue, quantity
    table.text('owner_name');
    table.boolean('ai_draft').defaultTo(true);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('source_columns');
}
