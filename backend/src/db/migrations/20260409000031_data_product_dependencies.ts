import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Mark a product_table as the authoritative shared dimension
  // and optionally link it to the source table it references
  await knex.schema.alterTable('product_tables', (t) => {
    t.boolean('is_shared_dimension').defaultTo(false);
    // If set, this table is a reference (not rebuilt) — points to the owning product_table
    t.integer('source_product_table_id').nullable()
      .references('id').inTable('product_tables').onDelete('SET NULL');
  });

  // Declares that one data product depends on another (uses its shared dimensions)
  await knex.schema.createTable('data_product_dependencies', (t) => {
    t.increments('id').primary();
    t.integer('dependent_product_id').notNullable()
      .references('id').inTable('data_products').onDelete('CASCADE');
    t.integer('source_product_id').notNullable()
      .references('id').inTable('data_products').onDelete('CASCADE');
    t.integer('tenant_id').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['dependent_product_id', 'source_product_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('data_product_dependencies');
  await knex.schema.alterTable('product_tables', (t) => {
    t.dropColumn('is_shared_dimension');
    t.dropColumn('source_product_table_id');
  });
}
