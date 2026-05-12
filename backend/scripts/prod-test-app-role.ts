/**
 * Smoke-test connecting AS databridge_app — does it bypass RLS?
 * Should see role attributes correct + RLS now filters when tenant is set.
 */
import { Client } from 'pg';

async function main(): Promise<void> {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error('APP_DATABASE_URL not set');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const log = (s: string) => process.stdout.write(s + '\n');

  const who = await client.query<{ role: string; bypassrls: boolean; super: boolean }>(`
    SELECT current_user AS role,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypassrls,
           (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super
  `);
  const w = who.rows[0];
  log(`Connected as: ${w.role}    bypassrls=${w.bypassrls}    super=${w.super}`);

  // Without tenant set — RLS should filter to 0 rows
  const noTenant = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM data_products`);
  log(`data_products (no tenant set)        : ${noTenant.rows[0].n} rows  ← should be 0`);

  // Set tenant=2 (EpicData) — should see 7 rows
  await client.query(`SET app.current_tenant = '2'`);
  const t2 = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM data_products`);
  log(`data_products (tenant=2 EpicData)    : ${t2.rows[0].n} rows  ← should be 7`);

  // Set tenant=4 (Test Workspace) — should see 0 rows
  await client.query(`SET app.current_tenant = '4'`);
  const t4 = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM data_products`);
  log(`data_products (tenant=4 Test Workspc) : ${t4.rows[0].n} rows  ← should be 0`);

  // Set tenant=4 — source_tables
  const t4st = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM source_tables`);
  log(`source_tables  (tenant=4 Test Workspc): ${t4st.rows[0].n} rows  ← should be 0`);

  // Set tenant=4 — table_relationships
  const t4rel = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM table_relationships`);
  log(`table_relats   (tenant=4 Test Workspc): ${t4rel.rows[0].n} rows  ← should be 0`);

  // Final: tenants table is intentionally NOT tenant-scoped (it's the meta-table).
  // It should be readable.
  const tns = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tenants`);
  log(`tenants                               : ${tns.rows[0].n} rows  ← should be ≥ 4`);

  await client.end();
  log('');
  log('✓ If all the "should be" comments match, RLS works correctly as databridge_app.');
}

main().catch((e) => { console.error('test failed:', e); process.exit(1); });
