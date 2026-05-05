/**
 * Morning brief schema — two tables:
 *
 *   pulse_observations  — daily snapshot of every pulse entry's value.
 *                          Used to compute today vs yesterday / last week
 *                          deltas for the morning brief. Also gives us
 *                          a free trend history per metric over time.
 *
 *   morning_briefs       — per-user, per-day persisted brief. Stores the
 *                          AI's 3-bullet narration + the deltas it was
 *                          based on, so the Home card can replay it
 *                          and the user can scroll back through history.
 *
 * Both RLS-scoped; tenant_id auto-fills from app.current_tenant.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── pulse_observations ──────────────────────────────────────────────────
  await knex.schema.createTable('pulse_observations', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('pulse_entry_id').notNullable()
      .references('id').inTable('user_pulse_entries').onDelete('CASCADE');

    // The value we snapshotted. Numeric for metric/slice; null + label
    // for "couldn't compute" (formula failed, no data, etc).
    t.decimal('value_numeric', 24, 6).nullable();
    t.text('error_message').nullable();

    // Date of the observation in user's local sense (we run a single UTC
    // job for now, so this is just the run date). Indexed so the brief
    // service can pull "today's row" quickly per pulse.
    t.date('observation_date').notNullable();
    t.timestamp('captured_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['pulse_entry_id', 'observation_date'], { indexName: 'uq_pulse_obs_per_day' });
    t.index(['tenant_id', 'observation_date'], 'idx_pulse_obs_tenant_date');
  });

  // ── morning_briefs ──────────────────────────────────────────────────────
  await knex.schema.createTable('morning_briefs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('user_id').notNullable();
    t.date('brief_date').notNullable();

    // The narrative payload. JSONB so the renderer can lay out bullets
    // independently and the prompt can evolve without a migration.
    // Shape:
    //   {
    //     summary: "<one paragraph in business voice>",
    //     bullets: [{ kind: 'movement'|'steady'|'warn',
    //                 label: '...', delta: '+1.5 pt', detail: '...' }],
    //     suggested_focus: "<one sentence — what to do today>",
    //     confidence: 'high'|'medium'|'low'
    //   }
    t.jsonb('content').notNullable();

    // Lifecycle
    t.timestamp('opened_at').nullable();
    t.timestamp('emailed_at').nullable();    // populated when email phase ships

    t.timestamps(true, true);

    t.unique(['user_id', 'brief_date'], { indexName: 'uq_brief_per_user_per_day' });
    t.index(['tenant_id', 'brief_date'], 'idx_brief_tenant_date');
  });

  // ── RLS ────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE pulse_observations ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE pulse_observations FORCE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE morning_briefs ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE morning_briefs FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    for (const tbl of ['pulse_observations', 'morning_briefs']) {
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
  await knex.schema.dropTableIfExists('morning_briefs');
  await knex.schema.dropTableIfExists('pulse_observations');
}
