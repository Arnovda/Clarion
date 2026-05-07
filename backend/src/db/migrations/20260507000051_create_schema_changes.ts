/**
 * Schema-change audit log.
 *
 * Today the platform fires a notification when a sync detects a schema
 * hash drift, but the diff is computed-and-discarded — users see
 * "schema changed" in the bell with no way to learn WHAT changed before
 * deciding whether to re-profile (which spends AI tokens).
 *
 * This table captures one row per detected drift so the /sources page
 * can render a human-readable list of additions / removals / type
 * changes and the user can act with confidence.
 *
 * `diff` is a JSONB document of shape:
 *   {
 *     added_tables:   [{ name, columns: [{ name, type }] }],
 *     removed_tables: [{ name }],
 *     changed_tables: [{
 *       name,
 *       added_columns:   [{ name, type }],
 *       removed_columns: [{ name, type }],
 *       changed_columns: [{ name, old_type, new_type }],
 *     }],
 *   }
 *
 * `summary` is the same content collapsed into a one-line human string
 * for use in notification bodies / list items ("3 new columns, 1 type
 * change").
 *
 * No "reviewed" flag — re-profiling overwrites the connection's
 * schema_hash and stops generating new rows. Users can scroll history.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('schema_changes', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`current_setting('app.current_tenant', true)::integer`));
    t.integer('connection_id').notNullable()
      .references('id').inTable('connections').onDelete('CASCADE');
    t.timestamp('detected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('summary').notNullable();
    t.jsonb('diff').notNullable();
    /** Counters denormalised from `diff` so the /sources callout can
     *  render counts without parsing the JSONB on every read. */
    t.integer('tables_added').notNullable().defaultTo(0);
    t.integer('tables_removed').notNullable().defaultTo(0);
    t.integer('columns_added').notNullable().defaultTo(0);
    t.integer('columns_removed').notNullable().defaultTo(0);
    t.integer('columns_changed').notNullable().defaultTo(0);

    t.index(['tenant_id', 'connection_id', 'detected_at'], 'schema_changes_tenant_conn_time_idx');
  });

  // ── RLS ────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE schema_changes ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE schema_changes FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY schema_changes_tenant_isolation ON schema_changes
        USING (tenant_id = current_setting('app.current_tenant', true)::integer)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON schema_changes TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE schema_changes_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('schema_changes');
}
