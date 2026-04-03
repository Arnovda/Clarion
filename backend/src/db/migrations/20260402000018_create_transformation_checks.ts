import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('transformation_checks', (t) => {
    t.increments('id').primary();
    t.integer('product_table_id').notNullable().references('id').inTable('product_tables').onDelete('CASCADE');
    t.string('check_type').notNullable(); // 'bk_uniqueness' | 'fan_out'
    t.string('status').notNullable();     // 'pass' | 'fail' | 'skip' | 'error'
    t.jsonb('bk_columns').notNullable();  // array of column names used as BK
    t.integer('total_rows').defaultTo(0);
    t.integer('distinct_bk_rows').defaultTo(0);
    t.integer('duplicate_count').defaultTo(0);       // BK: number of duplicate groups; fan-out: surplus rows
    t.jsonb('sample_duplicates').defaultTo('[]');     // up to 10 example duplicate BK values
    t.text('message');                                // human-readable summary
    t.timestamp('executed_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('transformation_checks');
}
