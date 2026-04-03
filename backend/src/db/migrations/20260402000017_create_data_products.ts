import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ---------------------------------------------------------------------------
  // Data Products — a business domain grouping (Finance, Sales, HR)
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('data_products', (t) => {
    t.increments('id').primary();
    t.integer('connection_id').references('id').inTable('connections').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.text('status').defaultTo('draft'); // draft | designing | approved | error | success
    t.text('created_by');
    t.timestamps(true, true);
  });

  // ---------------------------------------------------------------------------
  // Star Schemas — one fact + its dimensions within a data product
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('star_schemas', (t) => {
    t.increments('id').primary();
    t.integer('data_product_id').references('id').inTable('data_products').onDelete('CASCADE');
    t.text('name').notNullable();          // "Sales Orders Star"
    t.text('description');
    t.text('grain');                       // "One row per order line item"
    t.text('fact_table_type').defaultTo('transaction');
      // transaction | periodic_snapshot | accumulating_snapshot | factless
    t.timestamps(true, true);
  });

  // ---------------------------------------------------------------------------
  // Product Tables — fact, dimension, bridge, or junk tables
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('product_tables', (t) => {
    t.increments('id').primary();
    t.integer('star_schema_id').references('id').inTable('star_schemas').onDelete('CASCADE');
    t.text('table_name').notNullable();     // "fact_sales", "dim_customer"
    t.text('display_name');
    t.text('description');
    t.text('table_role').notNullable();     // fact | dimension | bridge | junk
    t.text('transformation_sql');           // full DuckDB SQL
    t.text('transformation_status').defaultTo('draft');
      // draft | approved | running | error | success
    t.integer('dag_order').defaultTo(0);    // 0=dims, 1=facts (execution order)
    t.text('delta_path');                   // ./warehouse/product/finance/dim_customer/
    t.timestamp('last_run_at');
    t.text('last_run_error');
    t.integer('row_count');
    t.boolean('ai_draft').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---------------------------------------------------------------------------
  // Product Columns — columns in a product table
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('product_columns', (t) => {
    t.increments('id').primary();
    t.integer('product_table_id').references('id').inTable('product_tables').onDelete('CASCADE');
    t.text('column_name').notNullable();
    t.text('data_type');
    t.text('display_name');
    t.text('description');
    t.text('column_role');
      // surrogate_key | natural_key | foreign_key | measure | attribute | degenerate_dimension
    t.text('fk_target_table');              // e.g. "dim_customer"
    t.text('fk_target_column');             // e.g. "customer_key"
    t.text('transformation_expression');    // e.g. "CAST(o.order_date AS DATE)"
    t.text('additivity');                   // additive | semi_additive | non_additive
    t.integer('scd_type').defaultTo(1);     // 1 or 2
    t.integer('sort_order').defaultTo(0);
    t.boolean('ai_draft').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---------------------------------------------------------------------------
  // Column Lineage — which source column(s) feed into each product column
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('column_lineage', (t) => {
    t.increments('id').primary();
    t.integer('product_column_id').references('id').inTable('product_columns').onDelete('CASCADE');
    t.text('source_table_name').notNullable();
    t.text('source_column_name').notNullable();
    t.text('transformation_description');   // human-readable
  });

  // ---------------------------------------------------------------------------
  // Data Product Sources — which source tables feed into this data product
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('data_product_sources', (t) => {
    t.increments('id').primary();
    t.integer('data_product_id').references('id').inTable('data_products').onDelete('CASCADE');
    t.integer('source_table_id');           // FK to source_tables (may be in Neo4j)
    t.text('table_name').notNullable();
  });

  // ---------------------------------------------------------------------------
  // Product KPIs — KPI formulas referencing product layer tables
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('product_kpis', (t) => {
    t.increments('id').primary();
    t.integer('data_product_id').references('id').inTable('data_products').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.text('formula_plain_text');
    t.text('formula_sql');                  // references product table columns
    t.text('owner_name');
    t.boolean('ai_draft').defaultTo(true);
    t.timestamps(true, true);
  });

  // ---------------------------------------------------------------------------
  // Product Relationships — star schema joins (fact→dim)
  // ---------------------------------------------------------------------------
  await knex.schema.createTable('product_relationships', (t) => {
    t.increments('id').primary();
    t.integer('star_schema_id').references('id').inTable('star_schemas').onDelete('CASCADE');
    t.integer('from_table_id').references('id').inTable('product_tables').onDelete('CASCADE');
    t.text('from_column_name').notNullable();
    t.integer('to_table_id').references('id').inTable('product_tables').onDelete('CASCADE');
    t.text('to_column_name').notNullable();
    t.text('relationship_type').defaultTo('fact_to_dim');
      // fact_to_dim | dim_to_dim
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('product_relationships');
  await knex.schema.dropTableIfExists('product_kpis');
  await knex.schema.dropTableIfExists('data_product_sources');
  await knex.schema.dropTableIfExists('column_lineage');
  await knex.schema.dropTableIfExists('product_columns');
  await knex.schema.dropTableIfExists('product_tables');
  await knex.schema.dropTableIfExists('star_schemas');
  await knex.schema.dropTableIfExists('data_products');
}
