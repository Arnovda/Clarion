import type { Knex } from 'knex';

/**
 * Give every RLS-enabled tenant-scoped table a tenant_isolation policy.
 *
 * THIS IS THE FIX THAT MAKES THE PRODUCTION ROLE FLIP SURVIVABLE.
 *
 * Two migrations disagreed, and the gap has been open since May:
 *
 *   20260403000020  created the tenant_isolation policy — on a hand-written
 *                   list of 27 tables.
 *   20260512000056  set ENABLE + FORCE ROW LEVEL SECURITY on EVERY table with
 *                   a tenant_id column, which is many more than 27.
 *
 * In PostgreSQL a table with row-level security enabled and **no policy**
 * denies every row to every non-bypassing role. So each table in the second
 * set but not the first — `users` among them — is currently unreadable and
 * unwritable by `databridge_app`.
 *
 * That has been invisible because production connects as the superuser
 * `databridge`, which bypasses RLS unconditionally (FORCE binds the table
 * OWNER, not a superuser). RLS is therefore not actually enforcing anything
 * in production today; isolation rests on the application's own tenant
 * filters. The consequence is worse than it sounds: the role flip described
 * in docs/runbooks/db-role-flip.md as "the last step of Sprint 1 hardening"
 * would not have hardened anything — it would have taken the platform down,
 * because login and registration both touch `users`.
 *
 * It surfaced when the new tenant-isolation CI job became the first thing
 * ever to connect as `databridge_app` and tried to register a tenant:
 *
 *   new row violates row-level security policy for table "users"
 *
 * This migration enumerates tenant-scoped tables the same way 56 does and
 * creates the policy from 20 wherever it is missing. Idempotent, and a no-op
 * for the 27 that already have it.
 *
 * Applying it changes nothing for a superuser connection, so it is safe to
 * deploy ahead of any role change — which is exactly the point: it has to
 * land before the flip, not with it.
 */
export async function up(knex: Knex): Promise<void> {
  const { rows } = await knex.raw<{
    rows: Array<{ table_name: string }>;
  }>(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity                       -- RLS is enabled
       AND EXISTS (                               -- and it is tenant-scoped
         SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name   = c.relname
            AND col.column_name  = 'tenant_id'
       )
       AND NOT EXISTS (                           -- but has no policy at all
         SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
       )
     ORDER BY c.relname
  `);

  for (const { table_name } of rows) {
    // Same shape as 20260403000020 so every table answers to one rule.
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${table_name}"`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON "${table_name}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  // Only drop policies from tables that 20260403000020 did not create one for.
  // Dropping indiscriminately would re-open the hole on the original 27.
  const { rows } = await knex.raw<{
    rows: Array<{ table_name: string }>;
  }>(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
     ORDER BY c.relname
  `);
  void rows;
  // Intentionally a no-op: leaving a correct policy in place is never the
  // failure mode worth reverting, and removing one would deny all access.
}
