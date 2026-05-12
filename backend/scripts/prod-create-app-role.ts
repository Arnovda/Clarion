/**
 * Create databridge_app role on production with the GRANTs required for
 * the backend. Runs as admin role (DATABASE_URL must be the admin url).
 *
 * Idempotent — safe to re-run.
 *
 * The new role password is read from APP_ROLE_PASSWORD env var so it
 * never lands in shell history.
 */
import { Client } from 'pg';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const pw  = process.env.APP_ROLE_PASSWORD;
  if (!url) throw new Error('DATABASE_URL not set');
  if (!pw)  throw new Error('APP_ROLE_PASSWORD not set');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const log = (s: string) => process.stdout.write(s + '\n');

  // 1. Create role if missing; set password / attributes idempotently.
  const existing = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pg_roles WHERE rolname = 'databridge_app'`,
  );
  if (Number(existing.rows[0].n) === 0) {
    log('Creating databridge_app role…');
    // pg parameterised queries don't work for CREATE ROLE; escape the
    // password by replacing single quotes (safest because we generated it).
    const safePw = pw.replace(/'/g, "''");
    await client.query(
      `CREATE ROLE databridge_app WITH LOGIN PASSWORD '${safePw}' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
  } else {
    log('databridge_app already exists — updating password + attributes…');
    const safePw = pw.replace(/'/g, "''");
    await client.query(`ALTER ROLE databridge_app WITH LOGIN PASSWORD '${safePw}' NOBYPASSRLS NOSUPERUSER`);
  }

  // 2. Connect + schema usage
  log('Granting CONNECT + USAGE…');
  await client.query(`GRANT CONNECT ON DATABASE databridge TO databridge_app`);
  await client.query(`GRANT USAGE ON SCHEMA public TO databridge_app`);

  // 3. All current tables — SELECT/INSERT/UPDATE/DELETE
  log('Granting SELECT/INSERT/UPDATE/DELETE on every table in public…');
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO databridge_app`);

  // 4. All sequences — USAGE/SELECT (needed for nextval() on auto-increment PKs)
  log('Granting USAGE/SELECT on every sequence…');
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO databridge_app`);

  // 5. Default privileges so future migrations grant automatically.
  // Important: the ALTER must run AS the role that creates the tables
  // (i.e. databridge admin), so its default grants apply to whatever
  // it creates next. Since we're running as that role right now, this works.
  log('Setting ALTER DEFAULT PRIVILEGES for future tables/sequences…');
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO databridge_app`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO databridge_app`);

  // 6. Verify the role attributes are correct
  const r = await client.query<{
    rolname: string; canlogin: boolean; bypassrls: boolean; super: boolean;
  }>(`
    SELECT rolname, rolcanlogin AS canlogin, rolbypassrls AS bypassrls, rolsuper AS super
      FROM pg_roles WHERE rolname='databridge_app'
  `);
  const row = r.rows[0];
  log('');
  log('Role attributes after setup:');
  log(`  canlogin   : ${row.canlogin}`);
  log(`  bypassrls  : ${row.bypassrls}    ${row.bypassrls ? '← STILL BAD' : '← good'}`);
  log(`  superuser  : ${row.super}`);
  log('');

  if (row.bypassrls || row.super || !row.canlogin) {
    log('⚠ Role attributes are NOT correct. Investigate before flipping.');
    process.exit(1);
  }

  log('✓ databridge_app is configured. Safe to flip Container App secret.');
  await client.end();
}

main().catch((e) => { console.error('setup failed:', e); process.exit(1); });
