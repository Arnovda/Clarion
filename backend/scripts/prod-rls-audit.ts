/**
 * Production RLS audit — one-shot diagnostic script.
 *
 * Run with the prod DATABASE_URL exported in env:
 *   DATABASE_URL='postgresql://databridge:...@host:5432/databridge?sslmode=require' \
 *     npx ts-node backend/scripts/prod-rls-audit.ts
 *
 * Prints:
 *   - current connected role (whoami)
 *   - per-table: rls_enabled / rls_forced / tenant_isolation_policy_present
 *   - row counts grouped by tenant_id for each leaking table
 *   - knex_migrations status (last 5 applied)
 *
 * Read-only. No mutations.
 */

import { Client } from 'pg';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const out = (s: string) => process.stdout.write(s + '\n');

  out('═══════════════════════════════════════════════════════════════════════');
  out('Production RLS audit');
  out('═══════════════════════════════════════════════════════════════════════\n');

  // ── 1. Who am I connected as
  const who = await client.query<{
    role: string; db: string; rolbypassrls: boolean; rolsuper: boolean;
  }>(`
    SELECT current_user AS role,
           current_database() AS db,
           r.rolbypassrls,
           r.rolsuper
      FROM pg_roles r
     WHERE r.rolname = current_user
  `);
  const wr = who.rows[0];
  out(`Connected as : ${wr.role}@${wr.db}`);
  out(`  bypassrls  : ${wr.rolbypassrls}   ← if true, RLS doesn't apply (admin-style)`);
  out(`  superuser  : ${wr.rolsuper}`);
  out('');

  // ── 2. Per-tenant-table RLS state
  const tables = [
    'connections', 'data_products', 'source_tables', 'source_columns',
    'table_relationships', 'product_tables', 'product_columns',
    'data_product_sources', 'star_schemas', 'product_relationships',
  ];

  out('RLS state per table:');
  out('─────────────────────────────────────────────────────────────');
  out('table_name                 │ rls_enabled │ rls_forced │ policies');
  out('─────────────────────────────────────────────────────────────');
  for (const t of tables) {
    const r = await client.query<{ enabled: boolean; forced: boolean; pol: number }>(`
      SELECT c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT COUNT(*) FROM pg_policy WHERE polrelid = c.oid)::int AS pol
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1
    `, [t]);
    if (r.rows.length === 0) { out(`${t.padEnd(26)} │ MISSING`); continue; }
    const row = r.rows[0];
    const flag = row.forced ? '' : ' ← LEAK';
    out(`${t.padEnd(26)} │   ${row.enabled ? 't' : 'f'}        │   ${row.forced ? 't' : 'f'}       │   ${row.pol}${flag}`);
  }
  out('');

  // ── 3. Row counts per tenant — confirms whether data is actually mixed
  out('Row counts per tenant (admin view, RLS bypass):');
  out('────────────────────────────────────────────────');
  for (const t of ['data_products', 'source_tables', 'connections', 'table_relationships']) {
    try {
      const r = await client.query<{ tenant_id: number; n: string }>(`
        SELECT tenant_id, COUNT(*)::text AS n
          FROM ${t}
         GROUP BY tenant_id
         ORDER BY tenant_id
      `);
      const summary = r.rows.map((x) => `t${x.tenant_id}=${x.n}`).join(', ');
      out(`${t.padEnd(26)} │ ${summary || '(empty)'}`);
    } catch (err) {
      out(`${t.padEnd(26)} │ ERROR ${(err as Error).message}`);
    }
  }
  out('');

  // ── 4. Migration state
  const mig = await client.query<{ name: string; migration_time: string }>(`
    SELECT name, migration_time
      FROM knex_migrations
     ORDER BY id DESC
     LIMIT 12
  `).catch(() => null);
  if (mig) {
    out('Last 12 migrations applied:');
    out('──────────────────────────────────────────');
    for (const m of mig.rows) out(`  ${m.migration_time} │ ${m.name}`);
    out('');
  } else {
    out('(could not read knex_migrations)');
  }

  // ── 5. tenants table — how many tenants exist?
  const tns = await client.query<{ id: number; name: string; created_at: string; slug: string }>(`
    SELECT id, name, slug, created_at FROM tenants ORDER BY id
  `).catch(() => null);
  if (tns) {
    out(`Tenants (${tns.rows.length}):`);
    out('──────────────────────────────────────────');
    for (const t of tns.rows) {
      out(`  id=${t.id}  slug=${t.slug.padEnd(30)} name=${t.name}`);
    }
    out('');
  }

  await client.end();
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
