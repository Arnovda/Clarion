import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_schedules', (table) => {
    table.increments('id').primary();
    table
      .integer('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    table
      .integer('dashboard_id')
      .notNullable()
      .references('id')
      .inTable('dashboards')
      .onDelete('CASCADE');
    table.string('name').notNullable();
    // Stored as JSON array of email strings
    table.jsonb('recipients').notNullable().defaultTo('[]');
    // Standard cron expression: "0 8 * * 1" = every Monday 08:00
    table.string('cron_expression').notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    // Whether to prepend an AI-generated executive summary to the email
    table.boolean('ai_summary').notNullable().defaultTo(true);
    table.timestamp('last_run_at', { useTz: true }).nullable();
    table.timestamp('next_run_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw('ALTER TABLE email_schedules ENABLE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY email_schedules_tenant_isolation ON email_schedules
      USING (tenant_id = current_setting('app.current_tenant', true)::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP POLICY IF EXISTS email_schedules_tenant_isolation ON email_schedules');
  await knex.schema.dropTableIfExists('email_schedules');
}
