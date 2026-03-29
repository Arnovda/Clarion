import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cross_source_views', (t) => {
    t.increments('id').primary();
    t.text('name').notNullable();
    t.text('description');
    t.text('user_id');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('cross_view_tables', (t) => {
    t.increments('id').primary();
    t.integer('view_id').references('id').inTable('cross_source_views').onDelete('CASCADE');
    t.integer('table_id').references('id').inTable('source_tables').onDelete('CASCADE');
    t.float('pos_x').defaultTo(80);
    t.float('pos_y').defaultTo(80);
  });

  await knex.schema.createTable('cross_view_relationships', (t) => {
    t.increments('id').primary();
    t.integer('view_id').references('id').inTable('cross_source_views').onDelete('CASCADE');
    t.integer('from_table_id').references('id').inTable('source_tables');
    t.integer('from_column_id').references('id').inTable('source_columns').nullable();
    t.integer('to_table_id').references('id').inTable('source_tables');
    t.integer('to_column_id').references('id').inTable('source_columns').nullable();
    t.text('relationship_type').defaultTo('many_to_one');
    t.text('label');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cross_view_relationships');
  await knex.schema.dropTableIfExists('cross_view_tables');
  await knex.schema.dropTableIfExists('cross_source_views');
}
