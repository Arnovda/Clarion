/**
 * Investigations — multi-step "why?" agent loops.
 *
 * Each investigation:
 *   - has an originating question + optional context (pulse entry,
 *     brief bullet, or ad-hoc)
 *   - is anchored to one data product (the schema the agent reasons
 *     against)
 *   - emits 3-6 steps (hypothesis → diagnostic SQL → finding) before
 *     concluding with a plain-English answer.
 *
 * Two tables:
 *   investigations         the run as a whole
 *   investigation_steps    each individual diagnostic step, in order
 *
 * Steps are persisted as they happen so the SSE stream can drop and
 * a refresh still shows the full trail.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('investigations', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('user_id').notNullable();
    t.integer('data_product_id').notNullable()
      .references('id').inTable('data_products').onDelete('CASCADE');

    // Originating context — one of these may be set (or none for ad-hoc).
    t.integer('pulse_entry_id').nullable()
      .references('id').inTable('user_pulse_entries').onDelete('SET NULL');
    t.integer('brief_id').nullable()
      .references('id').inTable('morning_briefs').onDelete('SET NULL');

    t.text('question').notNullable();          // user's natural-language ask
    t.text('focus').nullable();                 // optional metric / table / period the user pinned

    // Lifecycle
    t.text('status').notNullable().defaultTo('running');
    // 'running' | 'concluded' | 'failed' | 'cancelled'
    t.text('conclusion').nullable();           // final business-voice answer
    t.text('conclusion_confidence').nullable(); // 'high' | 'medium' | 'low'
    t.text('failure_reason').nullable();

    t.timestamps(true, true);
    t.timestamp('completed_at').nullable();

    t.index(['tenant_id', 'user_id', 'created_at'], 'idx_inv_user_created');
    t.index(['tenant_id', 'data_product_id'], 'idx_inv_product');
  });

  await knex.schema.createTable('investigation_steps', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('investigation_id').notNullable()
      .references('id').inTable('investigations').onDelete('CASCADE');

    t.integer('position').notNullable();       // 1-based step number
    t.text('hypothesis').notNullable();         // what the AI thinks to check
    t.text('query_sql').nullable();             // SQL run against the warehouse
    t.text('finding').nullable();               // business-voice summary of what it showed
    t.jsonb('result_preview').nullable();       // first ~5 rows for the UI
    t.integer('result_row_count').nullable();
    t.text('status').notNullable().defaultTo('running');
    // 'running' | 'success' | 'failed' | 'skipped'
    t.text('error_message').nullable();

    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('completed_at').nullable();

    t.index(['investigation_id', 'position'], 'idx_inv_step_position');
  });

  // ── RLS ────────────────────────────────────────────────────────────────
  for (const tbl of ['investigations', 'investigation_steps']) {
    await knex.raw(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`);
  }

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    for (const tbl of ['investigations', 'investigation_steps']) {
      await knex.raw(`
        CREATE POLICY ${tbl}_tenant_isolation ON ${tbl}
          USING (tenant_id = current_setting('app.current_tenant', true)::integer)
          WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
      `);
      await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tbl} TO databridge_app`);
      await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${tbl}_id_seq TO databridge_app`);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('investigation_steps');
  await knex.schema.dropTableIfExists('investigations');
}
