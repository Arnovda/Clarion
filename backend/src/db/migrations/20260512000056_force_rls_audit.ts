/**
 * FORCE ROW LEVEL SECURITY audit + repair.
 *
 * Every tenant-scoped table SHOULD have both ENABLE ROW LEVEL SECURITY
 * (policies are evaluated for unprivileged roles) AND FORCE ROW LEVEL
 * SECURITY (policies are evaluated even for table-OWNER roles — i.e.
 * the `databridge` admin role). Without FORCE, a backend connecting as
 * admin (which we currently do in production — see security audit
 * May 2026, security/SECURITY-FIXES.md) bypasses RLS entirely.
 *
 * The original tenant migration (20260403000020) set FORCE on the
 * initial 27 tables. Most later migrations follow the pattern. This
 * migration is the safety-net: it enumerates every tenant-scoped
 * table (anything with a `tenant_id` column) and sets FORCE if
 * missing. Idempotent — already-FORCEd tables are a no-op.
 *
 * The companion fix is operational: switch the production backend's
 * DB role from `databridge` (admin) to `databridge_app` (RLS-enforced
 * unprivileged). FORCE is the defense-in-depth that makes a missed
 * env-var flip non-catastrophic.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Enumerate every table that has a tenant_id column. This catches
  // any table created by future migrations that the developer forgot
  // to add to a hand-curated list.
  const rows = await knex.raw<{ rows: Array<{ table_name: string }> }>(`
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'tenant_id'
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name
  `);

  // Pull current RLS state so we only act on tables that need it.
  // pg_class.relrowsecurity tells us ENABLE; relforcerowsecurity tells
  // us FORCE. Both must be true for an admin connection to be filtered.
  const state = await knex.raw<{ rows: Array<{ table_name: string; rls_enabled: boolean; rls_forced: boolean }> }>(`
    SELECT t.relname AS table_name,
           t.relrowsecurity AS rls_enabled,
           t.relforcerowsecurity AS rls_forced
      FROM pg_class t
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relkind = 'r'
  `);

  const stateByName = new Map(state.rows.map((r) => [r.table_name, r]));

  for (const { table_name } of rows.rows) {
    const s = stateByName.get(table_name);
    // ENABLE first (no-op if already), then FORCE. Both are idempotent
    // in Postgres — Knex .raw runs each as a separate statement.
    if (!s?.rls_enabled) {
      await knex.raw(`ALTER TABLE "${table_name}" ENABLE ROW LEVEL SECURITY`);
    }
    if (!s?.rls_forced) {
      await knex.raw(`ALTER TABLE "${table_name}" FORCE ROW LEVEL SECURITY`);
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Intentionally a no-op. Removing FORCE is a security regression and
  // should never happen via migration rollback. If you genuinely need
  // to drop FORCE on a specific table for an operational reason, do it
  // as an explicit one-off in a maintenance window.
}
