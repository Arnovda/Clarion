/**
 * `entity_sync_cursors` — per-(connection, entity) watermark for incremental
 * source sync.
 *
 * The platform is the only writer. Connectors are stateless w.r.t. cursor
 * persistence — they receive cursor state in `SyncOptions.cursors`, return
 * new cursor state in `SyncResult.cursors`, and the orchestrator writes
 * here after a successful per-entity sync.
 *
 * Composite primary key (tenant_id, connection_id, entity_name). Tenant-
 * scoped via RLS + FORCE RLS (matches the platform isolation invariant).
 *
 * Cursor "type" is opaque to the platform. The connector knows whether
 * the value is an ISO timestamp, an integer ID, an LSN, etc., and how to
 * encode it back into a filter on the next sync. The type field is
 * captured for introspection / debugging only.
 *
 * Cursor value is text — flexible enough to carry any encoding, simple
 * enough to keep the table easy to inspect. Maximum length is the
 * Postgres text default (no explicit cap).
 *
 * Updated by the orchestrator AFTER a successful per-entity sync. If a
 * sync crashes mid-stream or an entity-level error fires, the cursor for
 * that entity is NOT updated — next run resumes from the previous cursor.
 * The "downstream merge by business key" pattern in the warehouse writer
 * makes the re-pull idempotent.
 *
 * Deletes are intentionally NOT tracked here — incremental sync over the
 * EO REST API doesn't surface deletes. Detection requires a periodic full
 * re-sync (which clears the cursor) or a separate audit feed.
 */

import type { Knex } from 'knex';

const TABLE = 'entity_sync_cursors';

export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) {
    await knex.schema.createTable(TABLE, (t) => {
      t.integer('tenant_id').notNullable()
        .references('id').inTable('tenants').onDelete('CASCADE');
      t.integer('connection_id').notNullable()
        .references('id').inTable('connections').onDelete('CASCADE');
      t.string('entity_name', 128).notNullable();

      // Cursor metadata — opaque to platform, meaningful only to the connector.
      t.string('cursor_type', 32).notNullable();  // 'timestamp' | 'integer' | 'string'
      t.text('cursor_value').notNullable();       // ISO 8601 / int as text / opaque

      // Operational metadata
      t.bigInteger('rows_synced_last').notNullable().defaultTo(0);
      t.timestamp('last_sync_at', { useTz: true }).notNullable();
      t.string('last_status', 16).notNullable().defaultTo('success'); // 'success' | 'failed'
      t.text('last_error').nullable();

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'connection_id', 'entity_name']);
    });

    // Default tenant_id from session — matches the rest of the platform.
    await knex.raw(`
      ALTER TABLE "${TABLE}" ALTER COLUMN tenant_id
      SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
    `);
  }

  // CHECK constraint on cursor_type — keep the set tight so we catch typos.
  await knex.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS entity_sync_cursors_cursor_type_check`);
  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT entity_sync_cursors_cursor_type_check
      CHECK (cursor_type IN ('timestamp', 'integer', 'string'))
  `);

  await knex.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS entity_sync_cursors_last_status_check`);
  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT entity_sync_cursors_last_status_check
      CHECK (last_status IN ('success', 'failed'))
  `);

  // RLS — every other tenant table has it, this one too. FORCE so the
  // admin DB role doesn't bypass.
  await knex.raw(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON "${TABLE}"
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  // Index for the common lookup: load all cursors for a connection at the
  // start of a sync run.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_entity_sync_cursors_connection
      ON "${TABLE}" (tenant_id, connection_id)
  `);

  // GRANT to the unprivileged app role if it exists (mirrors migration 41).
  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
