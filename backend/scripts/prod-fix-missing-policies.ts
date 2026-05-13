/**
 * Emergency fix: add tenant_isolation policies to every tenant-scoped
 * table that has ENABLE/FORCE RLS but no policy attached.
 *
 * Background: the admin role's BYPASSRLS attribute silently masked this
 * gap. Once we flipped the backend to a non-bypass role, those tables
 * deny-all'd because Postgres treats "RLS enabled + no policy" as deny
 * for non-bypass roles. Login broke first because users is in this set.
 *
 * Two policy shapes:
 *   - tenant_isolation       : tenant_id matches app.current_tenant
 *   - auth_lookup (SELECT)   : visible when no app.current_tenant set
 *                              (unauthenticated SELECT for login flow)
 *
 * auth_lookup is added only to the narrow set of tables touched by
 * unauthenticated routes: users, refresh_tokens, webauthn_credentials,
 * mfa_backup_codes, oauth_pending. Everything else gets just
 * tenant_isolation — there's no legitimate unauthenticated read.
 *
 * Run as DATABASE_URL=<admin-url> npx ts-node scripts/prod-fix-missing-policies.ts
 * Idempotent.
 */
import { Client } from 'pg';

// Tables that participate in unauthenticated lookups (login, register,
// password reset, refresh, WebAuthn challenge). Get the auth_lookup
// carve-out so SELECT works when no tenant is set yet.
const AUTH_LOOKUP_TABLES = new Set([
  'users',
  'refresh_tokens',
  'webauthn_credentials',
  'mfa_backup_codes',
  'oauth_pending',
]);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const log = (s: string) => process.stdout.write(s + '\n');

  // Find every tenant-scoped table that has RLS enabled but NO policies.
  const broken = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public'
       AND c.relkind='r'
       AND c.relrowsecurity = true
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=c.relname AND column_name='tenant_id'
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_policy WHERE polrelid = c.oid
       )
     ORDER BY c.relname
  `);

  log(`Found ${broken.rows.length} table(s) with RLS + no policy.`);
  for (const r of broken.rows) {
    const isAuthLookup = AUTH_LOOKUP_TABLES.has(r.table_name);
    log(`  ${r.table_name}${isAuthLookup ? '  [+auth_lookup]' : ''}`);
  }
  log('');

  // Apply. Idempotent DROP-then-CREATE pattern.
  for (const { table_name } of broken.rows) {
    // Standard tenant_isolation policy (same shape as the original
    // migration 20260403000020 used for the core tables).
    await client.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table_name}"`);
    await client.query(`
      CREATE POLICY tenant_isolation ON "${table_name}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);

    // Carve-out for the narrow set of auth-related tables: allow SELECT
    // when app.current_tenant is not set. Lets the login route look up
    // a user by email without already knowing which tenant they belong
    // to. Authenticated requests already have tenant set → tenant_isolation
    // takes over and limits visibility to the user's own tenant.
    //
    // FOR SELECT only — never permit unauthenticated INSERT/UPDATE/DELETE.
    if (AUTH_LOOKUP_TABLES.has(table_name)) {
      await client.query(`DROP POLICY IF EXISTS auth_lookup ON "${table_name}"`);
      await client.query(`
        CREATE POLICY auth_lookup ON "${table_name}"
          FOR SELECT
          USING (NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
      `);
    }
    log(`✓ ${table_name}`);
  }

  log('');
  log('Done. Re-running audit to confirm.');

  // Verify
  const after = await client.query<{ table_name: string; policies: number }>(`
    SELECT c.relname AS table_name,
           (SELECT COUNT(*) FROM pg_policy WHERE polrelid = c.oid)::int AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'
       AND c.relrowsecurity = true
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=c.relname AND column_name='tenant_id'
       )
       AND (SELECT COUNT(*) FROM pg_policy WHERE polrelid = c.oid) = 0
  `);
  if (after.rows.length === 0) {
    log('✓ Every tenant-scoped table now has at least one policy.');
  } else {
    log(`⚠ Still missing on: ${after.rows.map((r) => r.table_name).join(', ')}`);
  }

  await client.end();
}

main().catch((e) => { console.error('fix failed:', e); process.exit(1); });
