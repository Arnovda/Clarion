/**
 * Per-table refresh history — captures hash-diff'd change counts over
 * time so the /products/[id] page can render a mini line chart per
 * table showing "rows added / updated / unchanged / deleted" trends.
 *
 * Backs the change-evolution chart added when product transformations
 * moved from raw parquet writes to Delta + Python-sidecar SCD1 (with
 * row_hash) — that change made per-refresh diffs cheap to compute, so
 * we record them.
 *
 * One row per (product_table, refresh attempt). The `is_technical`
 * flag added to product_columns is the firewall that keeps `_row_hash`
 * (and future SCD2 cols) out of every UI/AI surface — readers filter
 * `WHERE is_technical = FALSE`.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('product_table_refresh_history', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('product_table_id').notNullable()
      .references('id').inTable('product_tables').onDelete('CASCADE');
    t.timestamp('refresh_started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('refresh_completed_at', { useTz: true });
    /** 'success' | 'failed' */
    t.text('status').notNullable();
    /** rows that matched on BK and had identical row_hash — no-op kept */
    t.integer('rows_unchanged').notNullable().defaultTo(0);
    /** rows that matched on BK but had different row_hash — overwritten */
    t.integer('rows_updated').notNullable().defaultTo(0);
    /** rows present in new state, not in existing — new BK */
    t.integer('rows_inserted').notNullable().defaultTo(0);
    /** rows in existing, not in new state — disappeared from source */
    t.integer('rows_deleted').notNullable().defaultTo(0);
    /** total rows in the new state (post-write count) */
    t.integer('rows_total').notNullable().defaultTo(0);
    /** populated when status = 'failed' */
    t.text('error_message');
    /** Storage format used for this refresh (parquet | delta_v1) — kept so
     *  rolling out the feature flag is auditable. */
    t.text('storage_format').notNullable().defaultTo('parquet');

    t.index(['tenant_id', 'product_table_id', 'refresh_started_at'], 'pt_refresh_history_lookup_idx');
  });

  // ── RLS ────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE product_table_refresh_history ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE product_table_refresh_history FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY pt_refresh_history_tenant_isolation ON product_table_refresh_history
        USING (tenant_id = current_setting('app.current_tenant', true)::integer)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON product_table_refresh_history TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE product_table_refresh_history_id_seq TO databridge_app`);
  }

  // ── product_columns: is_technical firewall flag ────────────────────────
  // Set TRUE for columns that must NEVER surface in any UI / NL→SQL prompt
  // / preview — `_row_hash` today, `_valid_from` / `_valid_to` /
  // `_is_current` / `_hash_schema_version` when SCD2 lands. Catalog,
  // notebook schema explorer, and AI prompts all filter by this.
  const hasIsTechnical = await knex.schema.hasColumn('product_columns', 'is_technical');
  if (!hasIsTechnical) {
    await knex.schema.alterTable('product_columns', (t) => {
      t.boolean('is_technical').notNullable().defaultTo(false);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('product_table_refresh_history');
  // Don't drop is_technical on rollback — it might be referenced by the
  // application code by then. Migration rollback in production is rare.
}
