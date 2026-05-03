/**
 * Adds `connection_sync_schedules` — recurring sync schedules for source-
 * connector connections. One schedule per connection (a UNIQUE constraint
 * on `connection_id` keeps the model simple — multiple schedules per
 * connection would be confusing UX, easy to add later if needed).
 *
 * Mirrors the structure of `transformation_schedules` (existing pattern
 * in this codebase) so operators have one mental model for "scheduled X"
 * across the platform. Differences:
 *   • Targets `connection_id` (the source side) rather than a product.
 *   • The runner triggers `triggerSync()` on the connector instead of a
 *     transformation.
 *
 * Cost containment is handled BY the orchestrator's schema-hash gate
 * (migration 20260503000043) — every scheduled run that hits an unchanged
 * schema short-circuits before the AI step. Without that gate, hourly
 * scheduling would blow the Claude budget; with it, the marginal LLM
 * cost of a scheduled refresh on a stable schema is zero.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('connection_sync_schedules', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('connection_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('connections')
      .onDelete('CASCADE');
    // Standard 5-field cron expression (minute hour day-of-month month day-of-week).
    t.string('cron_expression', 100).notNullable();
    // IANA timezone name (e.g. 'Europe/Brussels'). Default UTC for safety.
    t.string('timezone', 64).notNullable().defaultTo('UTC');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('created_by').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenant_id', 'enabled']);
  });

  // RLS — only applied when the dual-role setup is in place, matching the
  // pattern from migrations 20260502000041 and 20260503000042.
  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`ALTER TABLE connection_sync_schedules ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE connection_sync_schedules FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY connection_sync_schedules_tenant ON connection_sync_schedules
      USING (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON connection_sync_schedules TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE connection_sync_schedules_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('connection_sync_schedules');
}
