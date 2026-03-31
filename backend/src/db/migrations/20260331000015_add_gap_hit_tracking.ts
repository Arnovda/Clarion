import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('definition_gaps', (table) => {
    table.integer('hit_count').notNullable().defaultTo(1);
    table.timestamp('last_hit_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('definition_gaps', (table) => {
    table.dropColumn('hit_count');
    table.dropColumn('last_hit_at');
  });
}
