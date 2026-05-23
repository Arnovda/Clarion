/**
 * Operator script — list every tenant with its users.
 *
 * Read-only. Same DATABASE_URL that inspect-user.ts uses works here —
 * either the admin role (BYPASSRLS) or `databridge_app` (which can
 * SELECT from `users` via the auth_lookup RLS policy when no tenant
 * context is set, and from `tenants` freely since it has no RLS).
 *
 * Usage:
 *
 *   cd backend
 *   DATABASE_URL='postgresql://...' npx tsx scripts/list-tenants-and-users.ts
 */

import { Client } from 'pg';

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  status: string;
  created_at: string;
}

interface UserRow {
  id: number;
  tenant_id: number;
  email: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
  mfa_enabled_at?: string | null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const log = (s = '') => process.stdout.write(s + '\n');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const mfaColExists = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='users' AND column_name='mfa_enabled_at'
      ) AS exists
    `).then((r) => r.rows[0]?.exists ?? false);

    const tenants = await client.query<TenantRow>(
      `SELECT id, name, slug, status, created_at FROM tenants ORDER BY id`,
    );

    const userCols = ['id','tenant_id','email','display_name','role','is_active','created_at'];
    if (mfaColExists) userCols.push('mfa_enabled_at');

    const users = await client.query<UserRow>(
      `SELECT ${userCols.join(', ')} FROM users ORDER BY tenant_id, id`,
    );

    const byTenant = new Map<number, UserRow[]>();
    for (const u of users.rows) {
      const arr = byTenant.get(u.tenant_id) ?? [];
      arr.push(u);
      byTenant.set(u.tenant_id, arr);
    }

    log(`${tenants.rows.length} tenant(s), ${users.rows.length} user(s) total.`);
    log('');

    for (const t of tenants.rows) {
      const tUsers = byTenant.get(t.id) ?? [];
      log(`────────────────────────────────────────────────────────`);
      log(`Tenant #${t.id}  "${t.name}"  (slug=${t.slug}, status=${t.status})`);
      log(`  created  : ${t.created_at}`);
      log(`  users    : ${tUsers.length}`);
      if (tUsers.length === 0) {
        log(`    (none)`);
        continue;
      }
      for (const u of tUsers) {
        const inactive = u.is_active ? '' : '  [INACTIVE]';
        const mfa = mfaColExists && u.mfa_enabled_at ? '  [MFA]' : '';
        log(`    #${u.id}  ${u.role.padEnd(8)}  ${u.email.padEnd(40)} "${u.display_name ?? ''}"${inactive}${mfa}`);
      }
    }

    // Orphan check — any users whose tenant_id doesn't exist in tenants?
    const tenantIds = new Set(tenants.rows.map((t) => t.id));
    const orphans = users.rows.filter((u) => !tenantIds.has(u.tenant_id));
    if (orphans.length > 0) {
      log('');
      log(`⚠ ${orphans.length} orphan user(s) — tenant_id has no matching tenant row:`);
      for (const u of orphans) {
        log(`    #${u.id}  ${u.email}  (tenant_id=${u.tenant_id})`);
      }
    }

    log(`────────────────────────────────────────────────────────`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
