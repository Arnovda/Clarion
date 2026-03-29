import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('kpi_definitions', (table) => {
    table.increments('id').primary();
    table.integer('connection_id').references('id').inTable('connections').onDelete('CASCADE');
    table.text('name').notNullable(); // e.g. "Gross Margin"
    table.text('description');
    table.text('formula_plain_text'); // "Revenue minus cost of goods sold"
    table.text('formula_sql');        // "SUM(revenue) - SUM(cogs)"
    table.text('owner_name');
    table.boolean('ai_draft').defaultTo(true);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('kpi_definitions');
}
