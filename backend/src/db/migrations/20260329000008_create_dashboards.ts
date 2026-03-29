import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('dashboards', (t) => {
    t.increments('id').primary();
    t.text('user_id').notNullable();
    t.integer('connection_id').references('id').inTable('connections');
    t.text('title').notNullable();
    t.text('description');
    t.jsonb('spec').notNullable();        // full DashboardSpec JSON
    t.boolean('is_favorite').defaultTo(false);
    t.timestamps(true, true);             // created_at, updated_at
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('dashboards');
}
