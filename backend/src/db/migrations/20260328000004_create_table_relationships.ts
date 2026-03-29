import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('table_relationships', (table) => {
    table.increments('id').primary();
    table.integer('from_table_id').references('id').inTable('source_tables').onDelete('CASCADE');
    table.integer('from_column_id').references('id').inTable('source_columns').onDelete('CASCADE');
    table.integer('to_table_id').references('id').inTable('source_tables').onDelete('CASCADE');
    table.integer('to_column_id').references('id').inTable('source_columns').onDelete('CASCADE');
    table.text('relationship_type'); // 'one_to_many', 'many_to_one', 'many_to_many'
    table.text('description');
    table.boolean('ai_draft').defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('table_relationships');
}
