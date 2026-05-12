/**
 * Check if databridge_app role exists in prod, what its attributes are,
 * and whether it has the GRANTs the backend will need. Read-only.
 */
import { Client } from 'pg';

async function main(): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL!,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const role = await client.query<{
    rolname: string; rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean;
  }>(`SELECT rolname, rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'databridge_app'`);

  if (role.rows.length === 0) {
    console.log('❌ databridge_app role does NOT exist on prod.');
    console.log('   Need to CREATE ROLE before the flip.');
    await client.end();
    return;
  }
  const r = role.rows[0];
  console.log('✓ databridge_app exists');
  console.log(`  canlogin   : ${r.rolcanlogin}`);
  console.log(`  bypassrls  : ${r.rolbypassrls}    ${r.rolbypassrls ? '← BAD: app role should be NOBYPASSRLS' : '← good'}`);
  console.log(`  superuser  : ${r.rolsuper}`);
  console.log('');

  // GRANT check on key tables
  const grants = await client.query<{ table_name: string; privs: string }>(`
    SELECT table_name,
           string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND grantee = 'databridge_app'
       AND table_name IN ('users','tenants','connections','data_products','source_tables',
                          'audit_events','refresh_tokens','ai_call_log','knex_migrations',
                          'webauthn_credentials','mfa_totp_secrets')
     GROUP BY table_name
     ORDER BY table_name
  `);
  console.log('GRANTs on key tables:');
  for (const g of grants.rows) console.log(`  ${g.table_name.padEnd(30)} ${g.privs}`);
  if (grants.rows.length === 0) console.log('  (no GRANTs found — flip will break with permission denied)');
  console.log('');

  // Sequence USAGE check
  const seq = await client.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n
      FROM information_schema.sequences
     WHERE sequence_schema = 'public'
       AND NOT has_sequence_privilege('databridge_app', sequence_schema || '.' || sequence_name, 'USAGE')
  `);
  const missing = Number(seq.rows[0].n);
  console.log(`Sequences without USAGE for databridge_app: ${missing} ${missing === 0 ? '← good' : '← will block INSERTs'}`);

  // Total table count where GRANTs are needed
  const need = await client.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'
  `);
  const have = await client.query<{ n: string }>(`
    SELECT COUNT(DISTINCT table_name)::text AS n
      FROM information_schema.table_privileges
     WHERE table_schema='public' AND grantee='databridge_app' AND privilege_type='SELECT'
  `);
  console.log(`Tables with SELECT for databridge_app: ${have.rows[0].n} / ${need.rows[0].n}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
