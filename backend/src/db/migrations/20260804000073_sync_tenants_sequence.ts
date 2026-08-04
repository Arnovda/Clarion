import type { Knex } from 'knex';

/**
 * Resync `tenants_id_seq` with the rows that exist.
 *
 * Migration 20260403000020 seeds the default tenant with an EXPLICIT id:
 *
 *   INSERT INTO tenants (id, name, slug, status) VALUES (1, 'Default', …)
 *
 * An explicit id does not advance the sequence, so `tenants_id_seq` still
 * hands out 1 afterwards. The consequence is that the FIRST registration on a
 * freshly migrated database fails with
 *
 *   duplicate key value violates unique constraint "tenants_pkey"
 *   DETAIL: Key (id)=(1) already exists.
 *
 * That has been true of every new environment since April, and it stayed
 * invisible for the usual reason: nothing exercised the real path. The API
 * test suite TRUNCATEs every table before it runs, which deletes the seeded
 * tenant and takes the collision with it; long-lived dev and production
 * databases were past it. It surfaced only when the new tenant-isolation job
 * registered a tenant against a migrated-but-untouched database — i.e. the
 * one configuration that matches a real first deploy.
 *
 * `setval` with GREATEST is idempotent and safe on a populated database: it
 * only ever moves the sequence forward to max(id), never backwards, so
 * re-running cannot hand out an id that is already taken.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    SELECT setval(
      pg_get_serial_sequence('tenants', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 1) FROM tenants), 1),
      true
    )
  `);
}

export async function down(): Promise<void> {
  // Deliberately empty. Rewinding a sequence would hand out ids that already
  // exist — strictly worse than the state this migration corrects, and there
  // is no meaningful "previous value" to restore.
}
