import type { Knex } from 'knex';

/**
 * Per-tenant monthly AI-token budgets.
 *
 * Purpose: cap how many Claude tokens a single tenant can burn in a
 * calendar month, so one chatty tenant can't consume the platform's
 * AI budget unbounded. Also provides the raw data for a tenant-level
 * usage dashboard.
 *
 * Two shapes:
 *  - `tenants.monthly_token_budget` — soft cap in tokens (NULL = unlimited).
 *  - `ai_usage` — monthly rollup of consumed tokens per tenant.
 *
 * The check runs inside `callClaude` (backend/src/ai/AIService.ts) via
 * AsyncLocalStorage-scoped tenant context. Missing context ⇒ no check
 * (e.g. migrations, scripts, worker tasks that haven't opted in yet).
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Add budget column to tenants (nullable = unlimited).
  const hasColumn = await knex.schema.hasColumn('tenants', 'monthly_token_budget');
  if (!hasColumn) {
    await knex.schema.alterTable('tenants', (table) => {
      table.bigInteger('monthly_token_budget').nullable();
    });
  }

  // 2. Monthly usage rollup. One row per (tenant, period) — the app does
  //    an atomic UPSERT into here after every successful AI call.
  await knex.schema.createTable('ai_usage', (table) => {
    table.increments('id').primary();
    table
      .integer('tenant_id')
      .notNullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
    // First day of the month this usage belongs to. Always the 1st 00:00:00
    // of the calling instant's calendar month, stored as DATE.
    table.date('period_start').notNullable();
    table.bigInteger('input_tokens').notNullable().defaultTo(0);
    table.bigInteger('output_tokens').notNullable().defaultTo(0);
    table.bigInteger('total_tokens').notNullable().defaultTo(0);
    table.integer('call_count').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    table.unique(['tenant_id', 'period_start']);
  });

  // Tenant isolation matches every other multi-tenant table.
  await knex.raw('ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY ai_usage_tenant_isolation ON ai_usage
      USING (tenant_id = current_setting('app.current_tenant', true)::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP POLICY IF EXISTS ai_usage_tenant_isolation ON ai_usage');
  await knex.schema.dropTableIfExists('ai_usage');
  const hasColumn = await knex.schema.hasColumn('tenants', 'monthly_token_budget');
  if (hasColumn) {
    await knex.schema.alterTable('tenants', (table) => {
      table.dropColumn('monthly_token_budget');
    });
  }
}
