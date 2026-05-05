/**
 * Product customizations — per-product log of user-driven refinements.
 *
 * Phase 2 of the Refine feature. Every chat message that turns into an
 * approved change persists here. Stores:
 *   - the original natural-language ask,
 *   - the AI's structured proposal (intent + JSON payload),
 *   - the lifecycle state (pending → approved/applied or rejected).
 *
 * Used by the frontend chat UI as the conversation log, and by Phase 4's
 * bus-matrix re-run preservation (the next "Prepare my data" generation
 * gets these as constraints — "preserve these previous changes").
 *
 * Not joined to message_id or threaded — the conversation is a flat
 * append-only log per product. Team-visible by design.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('product_customizations', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('data_product_id').notNullable()
      .references('id').inTable('data_products').onDelete('CASCADE');

    // Optional table focus — set when the user invoked the chat from a
    // table-detail context. Null when the conversation was at the
    // product level. Either way the proposal can target any table the
    // AI deems appropriate; this just records intent.
    t.integer('product_table_id').nullable()
      .references('id').inTable('product_tables').onDelete('SET NULL');

    // ── User message + author ────────────────────────────────────────────
    t.text('user_message').notNullable();
    t.integer('user_id').nullable();           // FK omitted — users may be deleted
    t.text('user_name').nullable();

    // ── AI's structured proposal ──────────────────────────────────────────
    // intent: 'add_column' | 'modify_column' | 'add_kpi' | 'ask_clarification'
    //         | 'unsupported'
    t.text('intent').notNullable();
    t.text('intent_confidence').defaultTo('medium'); // 'high' | 'medium' | 'low'
    t.text('intent_reasoning');               // why the AI picked this intent
    t.jsonb('proposal').notNullable();        // full proposal payload (see refineService)
    t.text('summary');                         // human-readable one-liner shown in the chat bubble

    // ── Lifecycle ─────────────────────────────────────────────────────────
    // pending  — proposal generated, waiting for human approval
    // approved — user clicked Approve; about to be applied
    // applied  — change has been written to product_columns / product_tables / product_kpis
    // rejected — user clicked Discard
    // failed   — apply step threw; see apply_error
    t.text('status').notNullable().defaultTo('pending');
    t.timestamp('decided_at');
    t.integer('decided_by_user_id');
    t.text('decided_by_user_name');
    t.text('apply_error');

    t.timestamps(true, true);

    t.index(['tenant_id', 'data_product_id', 'created_at'], 'idx_pc_product_created');
    t.index(['tenant_id', 'status'], 'idx_pc_status');
  });

  // ── Row-Level Security ───────────────────────────────────────────────────
  // Same dual-role pattern as every other tenant-scoped table.
  await knex.raw(`ALTER TABLE product_customizations ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE product_customizations FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY product_customizations_tenant_isolation ON product_customizations
        USING (tenant_id = current_setting('app.current_tenant', true)::integer)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON product_customizations TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE product_customizations_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('product_customizations');
}
