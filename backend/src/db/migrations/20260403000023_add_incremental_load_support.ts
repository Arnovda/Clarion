import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add watermark tracking to ingested_tables
  await knex.schema.alterTable('ingested_tables', (table) => {
    table.text('watermark_column').defaultTo(null);       // e.g. 'updated_at', 'id'
    table.text('watermark_value').defaultTo(null);         // last seen value (stored as text for flexibility)
    table.text('load_mode').notNullable().defaultTo('full'); // 'full' | 'incremental'
  });

  // Add load_mode to product_tables (for transformation merge vs overwrite)
  await knex.schema.alterTable('product_tables', (table) => {
    table.text('load_mode').notNullable().defaultTo('full'); // 'full' | 'incremental'
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ingested_tables', (table) => {
    table.dropColumn('watermark_column');
    table.dropColumn('watermark_value');
    table.dropColumn('load_mode');
  });
  await knex.schema.alterTable('product_tables', (table) => {
    table.dropColumn('load_mode');
  });
}
