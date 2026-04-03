import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add ingestion fields to connections
  await knex.schema.alterTable('connections', (table) => {
    table.text('ingestion_status').defaultTo(null);        // null | 'pending' | 'running' | 'done' | 'error'
    table.integer('ingestion_progress').defaultTo(0);      // 0-100
    table.text('ingestion_error').defaultTo(null);
    table.timestamp('last_ingested_at', { useTz: true }).defaultTo(null);
    table.text('warehouse_path').defaultTo(null);           // path to Delta Lake warehouse directory
    table.text('query_engine').defaultTo('source');         // 'source' | 'duckdb'
  });

  // Track which tables have been selected for ingestion
  await knex.schema.createTable('ingested_tables', (table) => {
    table.increments('id').primary();
    table.integer('connection_id').notNullable().references('id').inTable('connections').onDelete('CASCADE');
    table.text('table_name').notNullable();
    table.text('status').notNullable().defaultTo('pending'); // 'pending' | 'ingesting' | 'done' | 'error'
    table.bigInteger('row_count').defaultTo(null);
    table.bigInteger('file_size_bytes').defaultTo(null);
    table.text('error').defaultTo(null);
    table.text('delta_path').defaultTo(null);                // path to this table's delta directory
    table.timestamp('ingested_at', { useTz: true }).defaultTo(null);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.unique(['connection_id', 'table_name']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ingested_tables');
  await knex.schema.alterTable('connections', (table) => {
    table.dropColumn('ingestion_status');
    table.dropColumn('ingestion_progress');
    table.dropColumn('ingestion_error');
    table.dropColumn('last_ingested_at');
    table.dropColumn('warehouse_path');
    table.dropColumn('query_engine');
  });
}
