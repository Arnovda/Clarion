import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('data_products', (t) => {
    t.text('icon_svg');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('data_products', (t) => {
    t.dropColumn('icon_svg');
  });
}
