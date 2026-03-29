import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('query_log', (table) => {
    table.increments('id').primary();
    table.text('user_id');
    table.text('question_text').notNullable();
    table.text('generated_sql');
    table.float('confidence_score');
    table.boolean('executed').defaultTo(false);
    table.text('result_summary');
    table.boolean('was_flagged').defaultTo(false);
    table.text('flag_reason');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('query_log');
}
