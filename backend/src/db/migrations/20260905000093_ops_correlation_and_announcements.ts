import type { Knex } from 'knex';

/**
 * Wave B item 3 — operating without a database session.
 *
 *  - `source_sync_runs.request_id` (6-1): the HTTP request a sync descends
 *    from, so an error on the operator console finds its log lines.
 *  - `announcements` (6-4): what every customer is told about an incident.
 *    An OPERATOR record about all tenants, not tenant-owned data — the same
 *    reasoning as `feature_flags`: no tenant_id, NO row-level security, the
 *    route gate is the only access control, and migration 56's blanket RLS
 *    enable skips it because it has no tenant_id column.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.text('request_id').nullable();
  });

  await knex.schema.createTable('announcements', (t) => {
    t.increments('id').primary();
    t.text('message').notNullable();
    // 'info' | 'warning' | 'critical' — the banner's colour and the word
    // it leads with.
    t.text('level').notNullable().defaultTo('info');
    t.timestamp('starts_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // NULL = until someone ends it.
    t.timestamp('ends_at', { useTz: true }).nullable();
    t.text('created_by').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE announcements ADD CONSTRAINT announcements_level_check CHECK (level IN ('info', 'warning', 'critical'))`);
  await knex.raw(`CREATE INDEX announcements_active_idx ON announcements (starts_at, ends_at)`);

  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON announcements TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE announcements_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('announcements');
  await knex.schema.alterTable('source_sync_runs', (t) => {
    t.dropColumn('request_id');
  });
}
