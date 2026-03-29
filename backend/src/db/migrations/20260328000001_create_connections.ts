import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('connections', (table) => {
    table.increments('id').primary();
    table.text('name').notNullable();
    table.text('type').notNullable(); // 'sqlite' for POC
    table.jsonb('config').notNullable(); // { filepath: '/path/to/data.db' }
    table.text('created_by');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('connections');
}
