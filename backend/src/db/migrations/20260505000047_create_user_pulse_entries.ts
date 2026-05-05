/**
 * User pulse entries — per-user list of metrics/slices Clarion should
 * keep an eye on. The backbone for the morning brief, push alerts,
 * Investigate seeding, and personalised "suggested focus."
 *
 * Per user (not per tenant) — Sara cares about margin, her CFO cares
 * about cash flow; same product, different perspectives. An admin can
 * later seed defaults for new team members but each user owns their
 * own list.
 *
 * Phase 1 supports two kinds:
 *   - 'metric' — a product KPI watched globally
 *   - 'slice'  — a product KPI watched by a specific dimension
 *               (e.g. "gross margin × product_group")
 *
 * 'theme' (free-form like "anything about Beverages") is deferred until
 * we have a reliable way to resolve themes to columns/tables. The
 * column exists in the schema so we don't need a follow-up migration
 * when it ships.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_pulse_entries', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('user_id').notNullable();          // FK omitted — users may be soft-deleted

    // ── What's being watched ────────────────────────────────────────────
    t.text('kind').notNullable();                // 'metric' | 'slice' | 'theme'

    t.integer('product_kpi_id').nullable()
      .references('id').inTable('product_kpis').onDelete('CASCADE');
    t.integer('data_product_id').nullable()
      .references('id').inTable('data_products').onDelete('CASCADE');

    // For 'slice' entries — break the metric down by this dimension.
    // We store names (not ids) because the same dimension may appear on
    // multiple tables / products and we want it to keep working when
    // the schema evolves.
    t.text('dimension_table').nullable();
    t.text('dimension_column').nullable();

    // For 'theme' entries — resolved later by an AI-driven matcher.
    t.text('theme_text').nullable();

    // ── How we watch ────────────────────────────────────────────────────
    // sensitivity: how aggressively to alert on movement.
    //   high   = any directional change worth mentioning
    //   medium = ±5% threshold (default)
    //   low    = ±10% threshold (only big swings)
    t.text('sensitivity').notNullable().defaultTo('medium');
    // frequency: how often the morning-brief job evaluates this entry.
    t.text('frequency').notNullable().defaultTo('daily');

    // ── Display ─────────────────────────────────────────────────────────
    // User-edited label (or AI-generated default). Independent of the
    // KPI's name so renaming the KPI doesn't surprise the user.
    t.text('label').nullable();
    t.integer('position').notNullable().defaultTo(0);

    t.timestamps(true, true);

    t.index(['tenant_id', 'user_id', 'position'], 'idx_pulse_user_position');
    t.index(['tenant_id', 'product_kpi_id'], 'idx_pulse_kpi');
  });

  // ── Row-level security ────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE user_pulse_entries ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE user_pulse_entries FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY user_pulse_entries_tenant_isolation ON user_pulse_entries
        USING (tenant_id = current_setting('app.current_tenant', true)::integer)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON user_pulse_entries TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE user_pulse_entries_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_pulse_entries');
}
