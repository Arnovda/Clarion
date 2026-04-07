import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Schedules — one per data product
  await knex.schema.createTable('transformation_schedules', (table) => {
    table.increments('id').primary();
    table.integer('product_id').notNullable().references('id').inTable('data_products').onDelete('CASCADE');
    table.integer('tenant_id').notNullable();
    table.string('cron_expression', 100).notNullable(); // e.g. '0 6 * * *' = daily at 6AM
    table.string('timezone', 50).defaultTo('Europe/Brussels');
    table.boolean('enabled').defaultTo(true);
    table.string('created_by', 255);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());

    table.unique(['product_id']); // one schedule per product
    table.index(['tenant_id']);
  });

  // Run history — one row per scheduled or manual run
  await knex.schema.createTable('transformation_runs', (table) => {
    table.increments('id').primary();
    table.integer('product_id').notNullable().references('id').inTable('data_products').onDelete('CASCADE');
    table.integer('schedule_id').nullable().references('id').inTable('transformation_schedules').onDelete('SET NULL');
    table.integer('tenant_id').notNullable();
    table.string('triggered_by', 255); // 'schedule' | user email
    table.string('status', 20).notNullable().defaultTo('running'); // 'running' | 'completed' | 'failed'
    table.integer('tables_transformed').defaultTo(0);
    table.text('error_message').nullable();
    table.timestamp('started_at').defaultTo(knex.fn.now());
    table.timestamp('finished_at').nullable();

    table.index(['product_id']);
    table.index(['tenant_id']);
    table.index(['status']);
  });

  // Add RLS policies if the databridge_app role exists
  const hasRole = await knex.raw(
    `SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`
  );
  if (hasRole.rows.length > 0) {
    for (const tbl of ['transformation_schedules', 'transformation_runs']) {
      await knex.raw(`ALTER TABLE "${tbl}" ENABLE ROW LEVEL SECURITY`);
      await knex.raw(`ALTER TABLE "${tbl}" FORCE ROW LEVEL SECURITY`);
      await knex.raw(`
        CREATE POLICY tenant_isolation ON "${tbl}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      `);
      await knex.raw(`
        ALTER TABLE "${tbl}" ALTER COLUMN tenant_id
        SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
      `);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('transformation_runs');
  await knex.schema.dropTableIfExists('transformation_schedules');
}
