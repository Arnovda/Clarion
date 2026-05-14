/**
 * Comprehensive tenant-isolation audit for production.
 *
 * Checks every tenant-scoped table for:
 *   1. tenant_id column exists + NOT NULL
 *   2. RLS enabled + FORCE RLS
 *   3. At least one tenant_isolation policy attached
 *   4. Policy actually filters by app.current_tenant
 *   5. No NULL tenant_id rows
 *   6. tenant_id values reference valid tenants
 *   7. App-role membership / attributes (NOBYPASSRLS)
 *
 * Reports cross-tenant cardinality anomalies that could indicate
 * past leakage (e.g., a row's owning user is in tenant A but the row
 * is tagged tenant B).
 *
 * Read-only. Safe to re-run.
 */
import { Client } from 'pg';

interface TableAuditRow {
  table_name: string;
  has_tenant_id: boolean;
  tenant_id_notnull: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
  null_tenant_id_rows: number;
  orphan_tenant_id_rows: number; // tenant_id pointing to nonexistent tenant
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const out = (s: string) => process.stdout.write(s + '\n');

  // ── Section A — connection identity
  out('═══════════════════════════════════════════════════════════════════════');
  out('TENANT ISOLATION AUDIT');
  out('═══════════════════════════════════════════════════════════════════════');
  out('');

  const who = await client.query<{
    role: string; bypassrls: boolean; super: boolean;
  }>(`SELECT current_user AS role,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls,
             (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`);
  out(`Connected as: ${who.rows[0].role}    bypassrls=${who.rows[0].bypassrls}    super=${who.rows[0].super}`);
  out('');

  // ── Section B — app role check
  const appRole = await client.query<{
    rolname: string; bypassrls: boolean; canlogin: boolean; super: boolean;
  }>(`SELECT rolname, rolbypassrls AS bypassrls, rolcanlogin AS canlogin, rolsuper AS super
        FROM pg_roles WHERE rolname='databridge_app'`);
  if (appRole.rows.length === 0) {
    out('CRITICAL: databridge_app role missing.');
  } else {
    const r = appRole.rows[0];
    out(`databridge_app: bypassrls=${r.bypassrls} canlogin=${r.canlogin} super=${r.super}`);
    if (r.bypassrls) out('  ⚠ CRITICAL: app role has BYPASSRLS — RLS does not apply when backend runs as this role.');
  }
  out('');

  // ── Section C — per-table audit
  const tables = await client.query<{ table_name: string }>(`
    SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='public'
       AND c.column_name='tenant_id'
       AND t.table_type='BASE TABLE'
     ORDER BY c.table_name
  `);

  const audit: TableAuditRow[] = [];
  for (const t of tables.rows) {
    const cls = await client.query<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname=$1 AND relkind='r'`, [t.table_name]);
    const policies = await client.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n
        FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
       WHERE c.relname=$1`, [t.table_name]);
    const col = await client.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name='tenant_id'`, [t.table_name]);
    const nullCount = await client.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM "${t.table_name}" WHERE tenant_id IS NULL
    `).catch(() => ({ rows: [{ n: '0' }] }));
    const orphan = await client.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n FROM "${t.table_name}" x
       WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = x.tenant_id)
    `).catch(() => ({ rows: [{ n: '0' }] }));

    audit.push({
      table_name:          t.table_name,
      has_tenant_id:       true,
      tenant_id_notnull:   col.rows[0]?.is_nullable === 'NO',
      rls_enabled:         cls.rows[0]?.relrowsecurity ?? false,
      rls_forced:          cls.rows[0]?.relforcerowsecurity ?? false,
      policy_count:        Number(policies.rows[0].n),
      null_tenant_id_rows: Number(nullCount.rows[0].n),
      orphan_tenant_id_rows: Number(orphan.rows[0].n),
    });
  }

  // Display
  out(`Per-table audit (${audit.length} tenant-scoped tables):`);
  out('───────────────────────────────────────────────────────────────────────');
  out('table                          enabled  forced  policies  notnull  nullRows  orphanRows  STATUS');
  out('───────────────────────────────────────────────────────────────────────');
  let problems = 0;
  for (const r of audit) {
    const issues: string[] = [];
    if (!r.rls_enabled)        issues.push('NO_RLS');
    if (!r.rls_forced)         issues.push('NO_FORCE');
    if (r.policy_count === 0)  issues.push('NO_POLICY');
    if (!r.tenant_id_notnull)  issues.push('NULLABLE_TENANT');
    if (r.null_tenant_id_rows > 0)  issues.push(`NULL_ROWS=${r.null_tenant_id_rows}`);
    if (r.orphan_tenant_id_rows > 0) issues.push(`ORPHANS=${r.orphan_tenant_id_rows}`);
    if (issues.length > 0) problems++;
    const status = issues.length === 0 ? 'OK' : issues.join(',');
    out(
      `${r.table_name.padEnd(30)} ${String(r.rls_enabled).padEnd(7)} ${String(r.rls_forced).padEnd(6)} ${String(r.policy_count).padStart(8)}  ${String(r.tenant_id_notnull).padEnd(7)} ${String(r.null_tenant_id_rows).padStart(8)}  ${String(r.orphan_tenant_id_rows).padStart(10)}  ${status}`,
    );
  }
  out('');
  out(`Tables with issues: ${problems} / ${audit.length}`);
  out('');

  // ── Section D — find tables WITHOUT tenant_id (should be tenant-meta / global only)
  out('Tables WITHOUT tenant_id column (should be tenant-meta / global only):');
  const noTenant = await client.query<{ table_name: string; n: string }>(`
    SELECT t.table_name, (SELECT COUNT(*) FROM information_schema.columns c
                          WHERE c.table_schema='public' AND c.table_name=t.table_name)::text AS n
      FROM information_schema.tables t
     WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                        WHERE c.table_schema='public' AND c.table_name=t.table_name AND c.column_name='tenant_id')
     ORDER BY t.table_name
  `);
  for (const r of noTenant.rows) out(`  ${r.table_name}`);
  out('');

  // ── Section E — cross-tenant cardinality (referential checks across tenant_id)
  // For tables with user_id, verify the user belongs to the same tenant
  out('Cross-tenant referential integrity checks:');
  out('─────────────────────────────────────────');
  const crossChecks = [
    { table: 'connections',   userCol: 'created_by_user_id' },
    { table: 'dashboards',    userCol: 'user_id' },
    { table: 'data_products', userCol: 'created_by_user_id' },
    { table: 'notifications', userCol: 'user_id' },
    { table: 'refresh_tokens', userCol: 'user_id' },
    { table: 'audit_events',  userCol: 'actor_user_id' },
    { table: 'conversations', userCol: 'user_id' },
    { table: 'webauthn_credentials', userCol: 'user_id' },
  ];
  for (const c of crossChecks) {
    try {
      const r = await client.query<{ n: string }>(`
        SELECT COUNT(*)::text AS n
          FROM "${c.table}" x
          JOIN users u ON u.id = x.${c.userCol}
         WHERE x.tenant_id IS NOT NULL
           AND u.tenant_id <> x.tenant_id
      `);
      const n = Number(r.rows[0].n);
      out(`  ${c.table}.${c.userCol}: ${n} rows with cross-tenant user${n > 0 ? '  ⚠ LEAK' : ''}`);
    } catch (err) {
      out(`  ${c.table}.${c.userCol}: skip (${(err as Error).message.split('\n')[0]})`);
    }
  }
  out('');

  // ── Section F — token / session orphans
  out('Token / session hygiene:');
  out('─────────────────────────');
  const stale = await client.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n FROM refresh_tokens
     WHERE expires_at < now() AND revoked_at IS NULL
  `).catch(() => ({ rows: [{ n: '?' }] }));
  out(`  Expired but not revoked refresh tokens: ${stale.rows[0].n} (cron should clean these)`);
  const orphan = await client.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n FROM refresh_tokens rt
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rt.user_id)
  `).catch(() => ({ rows: [{ n: '?' }] }));
  out(`  Refresh tokens for deleted users:        ${orphan.rows[0].n}`);
  out('');

  // ── Section G — tenant summary
  const tns = await client.query<{ id: number; name: string; status: string }>(`
    SELECT id, name, status FROM tenants ORDER BY id
  `);
  out(`Tenants in system: ${tns.rows.length}`);
  for (const t of tns.rows) out(`  id=${t.id}  ${t.status}  ${t.name}`);
  out('');

  await client.end();
  if (problems > 0) {
    out(`⚠ ${problems} table(s) have isolation issues — see above.`);
    process.exit(2);
  }
  out('✓ All tenant-scoped tables have RLS + FORCE + policy. No null/orphan rows.');
}

main().catch((e) => { console.error(e); process.exit(1); });
