/**
 * AI call log — granular telemetry for every Anthropic call.
 *
 * Sits next to the existing `ai_usage` aggregate (which rolls tokens
 * up to a monthly total per tenant). This table captures the
 * per-call detail the cost dashboard needs to answer:
 *   - which CALL TYPES are most expensive
 *   - which USERS drive the most cost
 *   - which TENANTS are heading toward their budget
 *   - daily trend over the last N days
 *
 * Logged async after every callClaude completion; never blocks the
 * main response, never throws into the call site.
 *
 * Volume estimate: a 5-user tenant does maybe 200 AI calls / day. At
 * 1 row each, that's 60k rows / month / tenant. Postgres handles that
 * without breaking a sweat. If we ever 100× the volume, archive rows
 * older than 30 days to a cheaper store.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ai_call_log', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));

    // Optional — background jobs (cron-driven brief, query starters)
    // run without a user context. Null user_id means "system / cron".
    t.integer('user_id').nullable();

    // ── What the call was ──────────────────────────────────────────────
    t.text('model').notNullable();             // 'claude-sonnet-4-6' / 'claude-haiku-4-5-…'
    t.text('call_label').notNullable();        // 'generate_sql' / 'investigate_plan_next' / etc.
    t.text('category').notNullable();          // see categoriseCall() — 'question' / 'investigate' / 'refine' / 'dashboard' / 'brief' / 'starters' / 'kpi' / 'pulse' / 'setup' / 'quality' / 'other'

    // ── Token counts ──────────────────────────────────────────────────
    t.integer('input_tokens').notNullable().defaultTo(0);
    t.integer('output_tokens').notNullable().defaultTo(0);
    t.integer('cache_read_tokens').notNullable().defaultTo(0);
    t.integer('cache_creation_tokens').notNullable().defaultTo(0);

    // ── Computed cost ─────────────────────────────────────────────────
    // Stored at the call site using the active pricing table — once
    // pricing changes, historical rows reflect old rates (correct for
    // an audit). Stored as numeric to keep sub-cent accuracy.
    t.decimal('cost_usd', 10, 6).notNullable().defaultTo(0);

    // ── Operational ───────────────────────────────────────────────────
    t.integer('duration_ms').notNullable().defaultTo(0);
    t.boolean('cache_used').notNullable().defaultTo(false);  // true if any cache_read_tokens
    t.boolean('failed').notNullable().defaultTo(false);
    t.text('error_code').nullable();           // 'rate_limit' / 'credit_exhausted' / etc.

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Indexes — optimised for the dashboard's three main queries:
    //   1. Daily totals per tenant       (created_at, tenant_id)
    //   2. Top users in a window         (tenant_id, user_id, created_at)
    //   3. Top categories in a window    (tenant_id, category, created_at)
    t.index(['tenant_id', 'created_at'], 'idx_ai_call_log_tenant_date');
    t.index(['tenant_id', 'user_id', 'created_at'], 'idx_ai_call_log_user_date');
    t.index(['tenant_id', 'category', 'created_at'], 'idx_ai_call_log_category_date');
  });

  await knex.raw(`ALTER TABLE ai_call_log ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ai_call_log FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY ai_call_log_tenant_isolation ON ai_call_log
        USING (tenant_id = current_setting('app.current_tenant', true)::integer)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ai_call_log TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ai_call_log_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ai_call_log');
}
