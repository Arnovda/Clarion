/**
 * Adds source-connector support to the existing `connections` table and
 * introduces `source_sync_runs` for tracking sync executions.
 *
 * Why a NEW `connector_type` column rather than reusing the existing `type`:
 * the existing `type` ('sqlite' | 'postgres' | 'mysql' | 'mssql' | 'duckdb')
 * names the SQL DRIVER used to query the connection. For source-system
 * connectors (ExactOnline, NetSuite, ...) the data lands in the warehouse
 * and is queried via DuckDB, so `type='duckdb'` is still correct for the
 * QUERY side. `connector_type` is the SOURCE side — what's loading the
 * data IN. They're orthogonal axes, deserve separate columns.
 *
 * For backwards-compat, existing rows have `connector_type=NULL` (= no
 * source connector, this is a directly-attached DB).
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── connections additions ────────────────────────────────────────────────
  await knex.schema.alterTable('connections', (t) => {
    // Source-system connector identifier. NULL = direct DB attach (legacy/SQL).
    // Non-null values match the registry: 'exactonline', 'netsuite', ...
    t.string('connector_type', 64).nullable();

    // Encrypted JSON config for the source connector (creds + region).
    // AES-256-GCM ciphertext (see backend/src/utils/crypto.ts).
    // Big enough for a deeply-nested config; ciphertext bloats by ~33%.
    t.text('connector_config_encrypted').nullable();

    // Entity names the user picked in the wizard. e.g. ['Accounts','GLAccounts'].
    // Stored as text[] rather than jsonb for cheap GIN-index lookups later.
    t.specificType('selected_entities', 'text[]').nullable();

    // Denormalised mirror of the latest source_sync_runs row, for fast
    // list-view rendering without a join.
    // (`last_synced_at` already exists from migration 20260402000016 —
    // ingestion timestamp, semantically the same field. Reusing it.)
    t.string('last_sync_status', 32).nullable();
  });

  // ── source_sync_runs ─────────────────────────────────────────────────────
  await knex.schema.createTable('source_sync_runs', (t) => {
    t.increments('id').primary();

    // Tenant scoping. Matches the integer-id pattern used elsewhere.
    t.integer('tenant_id').notNullable();
    t.integer('connection_id')
      .notNullable()
      .references('id')
      .inTable('connections')
      .onDelete('CASCADE');

    // Lifecycle: queued → running → (succeeded | failed | cancelled).
    t.string('status', 32).notNullable();

    t.timestamp('queued_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();

    // Audit: who triggered the sync (NULL for system / scheduled runs).
    t.integer('triggered_by_user_id').nullable().references('id').inTable('users');

    // Container Apps Job execution name — used to look up live logs in
    // Log Analytics during/after the run.
    t.string('job_execution_name', 255).nullable();

    // Per-entity row counts, e.g. { Accounts: 145, GLAccounts: 67 }.
    t.jsonb('row_counts').nullable();

    // Non-fatal warnings surfaced to the UI.
    t.jsonb('warnings').nullable();

    // User-facing error reason on failure. Already redacted by the worker.
    t.text('error_message').nullable();

    // Last ~10kB of worker stdout, redacted. Full logs live in Log Analytics.
    t.text('log_excerpt').nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Index for the "list runs for a connection, newest first" query
  // (the connection-detail page hits this on every load).
  await knex.raw(
    `CREATE INDEX idx_source_sync_runs_lookup
       ON source_sync_runs (tenant_id, connection_id, queued_at DESC)`,
  );

  // ── Row-level security ───────────────────────────────────────────────────
  // Only applied when the dual-role setup (databridge + databridge_app) is in
  // place. In single-role deployments (Azure Postgres Flexible Server with
  // the default `databridge` role only), tenant scoping relies on the
  // application layer setting `SET app.current_tenant` per-request — the
  // database-level RLS policy is unnecessary.
  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`ALTER TABLE source_sync_runs ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE source_sync_runs FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY source_sync_runs_tenant ON source_sync_runs
      USING (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON source_sync_runs TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE source_sync_runs_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('source_sync_runs');

  await knex.schema.alterTable('connections', (t) => {
    t.dropColumn('last_sync_status');
    t.dropColumn('selected_entities');
    t.dropColumn('connector_config_encrypted');
    t.dropColumn('connector_type');
    // last_synced_at intentionally NOT dropped — it predates this migration
    // (added in 20260402000016_add_ingestion_support.ts).
  });
}
