/**
 * Diagnose 42501 (insufficient_privilege) errors by listing every
 * public.* table and reporting which ones databridge_app does NOT
 * have SELECT / INSERT / UPDATE / DELETE on. Also checks sequence
 * USAGE.
 *
 * Works WITHOUT the admin role: queries pg_tables (visible to all)
 * and uses has_table_privilege() which checks against any named
 * role. Run with the same `databridge_app` URL used by the other
 * inspection scripts.
 *
 * Usage:
 *   cd backend
 *   DATABASE_URL='postgresql://databridge_app:...@host/databridge?sslmode=require' \
 *     npx tsx scripts/check-app-grants.ts
 */

import { Client } from 'pg';

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
    // Every public BASE TABLE, plus a flag per privilege. pg_tables
    // is visible to all roles (unlike information_schema.tables which
    // hides entries the current role can't see at all). has_table_privilege
    // checks any role's grant on any table, regardless of who's asking.
    const tableGrants = await client.query<{
      table_name: string;
      has_select: boolean;
      has_insert: boolean;
      has_update: boolean;
      has_delete: boolean;
    }>(`
      SELECT
        t.tablename AS table_name,
        has_table_privilege('databridge_app', quote_ident(t.tablename), 'SELECT') AS has_select,
        has_table_privilege('databridge_app', quote_ident(t.tablename), 'INSERT') AS has_insert,
        has_table_privilege('databridge_app', quote_ident(t.tablename), 'UPDATE') AS has_update,
        has_table_privilege('databridge_app', quote_ident(t.tablename), 'DELETE') AS has_delete
      FROM pg_tables t
      WHERE t.schemaname = 'public'
      ORDER BY t.tablename
    `);

    const missing = {
      select: tableGrants.rows.filter((r) => !r.has_select),
      insert: tableGrants.rows.filter((r) => !r.has_insert),
      update: tableGrants.rows.filter((r) => !r.has_update),
      delete: tableGrants.rows.filter((r) => !r.has_delete),
    };

    log(`Checked ${tableGrants.rows.length} tables in public schema.`);
    log('');

    log('TABLES WHERE databridge_app HAS NO SELECT GRANT:');
    if (missing.select.length === 0) log('  (none, every table is readable)');
    else for (const r of missing.select) log(`  ✗ ${r.table_name}`);
    log('');

    log('TABLES WHERE databridge_app HAS NO INSERT GRANT:');
    if (missing.insert.length === 0) log('  (none)');
    else for (const r of missing.insert) log(`  ✗ ${r.table_name}`);
    log('');

    log('TABLES WHERE databridge_app HAS NO UPDATE GRANT:');
    if (missing.update.length === 0) log('  (none)');
    else for (const r of missing.update) log(`  ✗ ${r.table_name}`);
    log('');

    log('TABLES WHERE databridge_app HAS NO DELETE GRANT:');
    if (missing.delete.length === 0) log('  (none)');
    else for (const r of missing.delete) log(`  ✗ ${r.table_name}`);
    log('');

    // Sequences (needed for SERIAL/BIGSERIAL inserts)
    const seqGrants = await client.query<{
      sequence_name: string;
      has_usage: boolean;
    }>(`
      SELECT
        c.relname AS sequence_name,
        has_sequence_privilege('databridge_app', quote_ident(c.relname), 'USAGE') AS has_usage
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
      ORDER BY c.relname
    `);
    const missingSeq = seqGrants.rows.filter((r) => !r.has_usage);
    log(`SEQUENCES WHERE databridge_app HAS NO USAGE GRANT (of ${seqGrants.rows.length} total):`);
    if (missingSeq.length === 0) log('  (none)');
    else for (const r of missingSeq) log(`  ✗ ${r.sequence_name}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
