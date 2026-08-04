import type { Knex } from 'knex';

/**
 * Grant `databridge_app` the privileges it needs on every table and sequence.
 *
 * The companion to 20260804000074. That migration gave every RLS-enabled table
 * a policy; this one makes sure the role can reach the tables at all. Both are
 * preconditions for the production role flip, and they fail differently:
 * a missing policy denies rows, a missing grant denies the table.
 *
 * Why this was needed:
 *
 * Migrations have granted to `databridge_app` since 20260502000041, but only
 * per-table, in the migration that creates the table. Everything older — users,
 * tenants, connections, dashboards, and the rest of the original schema — was
 * granted out-of-band, by hand, following docs/runbooks/db-role-flip.md. So a
 * database provisioned purely from migrations produces a role that cannot read
 * `users`, and the backend cannot even log anyone in.
 *
 * That is not a hypothetical. It is what the new tenant-isolation CI job hit on
 * its first run, being the first thing that had ever connected as this role.
 *
 * Doing it here rather than in a runbook is the point: a step that lives only
 * in a document is a step that is skipped, and the failure it causes appears
 * long after the person who skipped it has moved on. `ALTER DEFAULT PRIVILEGES`
 * additionally covers tables created by FUTURE migrations, so a new table can
 * no longer arrive without its grant.
 *
 * Guarded on the role existing: local developer databases and any environment
 * that has not provisioned it should migrate cleanly, not fail here.
 * Idempotent — GRANT on an already-granted object is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{ rows: Array<{ exists: boolean }> }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app') AS exists`,
  );
  if (!rows[0]?.exists) return;

  await knex.raw(`GRANT USAGE ON SCHEMA public TO databridge_app`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO databridge_app`);
  await knex.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO databridge_app`);

  // Future tables and sequences, so the next migration cannot reopen the gap.
  // Scoped to the role that runs migrations — default privileges apply per
  // granting role, which is why this is not retroactive and the two blanket
  // grants above are still required.
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO databridge_app
  `);
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO databridge_app
  `);
}

export async function down(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{ rows: Array<{ exists: boolean }> }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app') AS exists`,
  );
  if (!rows[0]?.exists) return;

  // Only the default-privilege rules are reverted. Revoking the table grants
  // themselves would break any environment already running as this role —
  // strictly worse than the state before this migration.
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM databridge_app
  `);
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM databridge_app
  `);
}
