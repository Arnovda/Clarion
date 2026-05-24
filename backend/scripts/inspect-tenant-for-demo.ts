/**
 * One-off operator script — inspect everything in a tenant that's relevant
 * for planning a demo: source tables, data products, KPIs, dashboards,
 * glossary terms, recent queries, conversation count.
 *
 * Same DATABASE_URL pattern as inspect-user.ts and list-tenants-and-users.ts.
 * Read-only. Safe to run.
 *
 * Usage:
 *
 *   cd backend
 *   DATABASE_URL='postgresql://databridge_app:...@host/databridge?sslmode=require' \
 *   TENANT_ID=<id>   # or TENANT_SLUG=vda-analytics
 *     npx tsx scripts/inspect-tenant-for-demo.ts
 */

import { Client } from 'pg';

interface TenantRow { id: number; name: string; slug: string; status: string }

interface CountRow { n: string }

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const tenantIdEnv = process.env.TENANT_ID;
  const tenantSlugEnv = process.env.TENANT_SLUG;
  if (!tenantIdEnv && !tenantSlugEnv) {
    throw new Error('Set either TENANT_ID=<n> or TENANT_SLUG=<slug>');
  }

  const log = (s = '') => process.stdout.write(s + '\n');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // Resolve tenant
    let tenant: TenantRow | undefined;
    if (tenantIdEnv) {
      const r = await client.query<TenantRow>(`SELECT id, name, slug, status FROM tenants WHERE id = $1`, [Number(tenantIdEnv)]);
      tenant = r.rows[0];
    } else {
      const r = await client.query<TenantRow>(`SELECT id, name, slug, status FROM tenants WHERE slug = $1`, [tenantSlugEnv]);
      tenant = r.rows[0];
    }
    if (!tenant) throw new Error(`Tenant not found.`);
    const tid = tenant.id;

    log(`────────────────────────────────────────────────────────────────`);
    log(`TENANT  #${tenant.id}  "${tenant.name}"  (slug=${tenant.slug}, status=${tenant.status})`);
    log(`────────────────────────────────────────────────────────────────`);

    // Open a transaction and SET the tenant context so RLS lets us read
    // tenant-scoped tables. The databridge_app role doesn't have BYPASSRLS,
    // so without this the SELECTs below return 0 rows for connections,
    // data_products, etc. (their RLS policies require app.current_tenant
    // to match the row's tenant_id).
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = '${Number(tid)}'`);

    // CONNECTIONS
    const conns = await client.query<{ id: number; name: string; connector_type: string | null; last_synced_at: string | null }>(
      `SELECT id, name, connector_type, last_synced_at FROM connections WHERE tenant_id = $1 ORDER BY id`, [tid],
    );
    log('');
    log(`SOURCES (${conns.rows.length})`);
    for (const c of conns.rows) {
      log(`  #${c.id}  ${c.name}  (type=${c.connector_type ?? '?'}, last_synced=${c.last_synced_at ?? 'never'})`);
    }

    // SOURCE TABLES — counts per connection
    const srcTables = await client.query<{ connection_id: number; n: string; ai_draft_n: string; approved_n: string }>(
      `SELECT connection_id,
              COUNT(*)::text AS n,
              SUM(CASE WHEN ai_draft = true  THEN 1 ELSE 0 END)::text AS ai_draft_n,
              SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END)::text AS approved_n
         FROM source_tables WHERE tenant_id = $1
        GROUP BY connection_id`, [tid],
    );
    log('');
    log(`SOURCE TABLES (per connection)`);
    for (const row of srcTables.rows) {
      log(`  conn #${row.connection_id}  total=${row.n}  ai_draft=${row.ai_draft_n}  approved=${row.approved_n}`);
    }

    // DATA PRODUCTS — full detail
    const products = await client.query<{
      id: number; name: string; status: string; connection_id: number | null;
      description: string | null; created_at: string;
    }>(`SELECT id, name, status, connection_id, description, created_at
          FROM data_products WHERE tenant_id = $1 ORDER BY id`, [tid]);
    log('');
    log(`DATA PRODUCTS (${products.rows.length})`);
    for (const p of products.rows) {
      log(`  #${p.id}  "${p.name}"  status=${p.status}  conn=${p.connection_id ?? 'multi'}`);
      if (p.description) log(`        description: ${p.description.slice(0, 200)}${p.description.length > 200 ? '…' : ''}`);

      // Star schemas + tables for this product
      const schemas = await client.query<{ id: number; name: string; grain: string | null }>(
        `SELECT id, name, grain FROM star_schemas WHERE data_product_id = $1`, [p.id],
      );
      for (const s of schemas.rows) {
        log(`        schema "${s.name}"  grain=${s.grain ?? '?'}`);
        const tables = await client.query<{ id: number; table_name: string; display_name: string | null; table_role: string; description: string | null; transformation_status: string; delta_path: string | null }>(
          `SELECT id, table_name, display_name, table_role, description, transformation_status, delta_path
             FROM product_tables WHERE star_schema_id = $1 ORDER BY table_role DESC, id`, [s.id],
        );
        for (const t of tables.rows) {
          const desc = t.description ? `  — ${t.description.slice(0, 80)}${t.description.length > 80 ? '…' : ''}` : '';
          log(`          ${t.table_role.padEnd(10)}  ${t.table_name.padEnd(28)}  status=${t.transformation_status}${desc}`);

          // Column count + sample columns
          const cols = await client.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM product_columns
              WHERE product_table_id = $1 AND (is_technical = false OR is_technical IS NULL)`, [t.id],
          );
          const colSample = await client.query<{ column_name: string; data_type: string | null; column_role: string | null }>(
            `SELECT column_name, data_type, column_role FROM product_columns
              WHERE product_table_id = $1 AND (is_technical = false OR is_technical IS NULL)
              ORDER BY sort_order, id LIMIT 8`, [t.id],
          );
          log(`              ${cols.rows[0].n} cols (sample: ${colSample.rows.map((c) => `${c.column_name}${c.column_role ? `[${c.column_role[0]}]` : ''}`).join(', ')})`);
        }
      }

      // KPIs for this product
      const kpis = await client.query<{ id: number; name: string; formula_sql: string | null; formula_plain_text: string | null }>(
        `SELECT id, name, formula_sql, formula_plain_text FROM product_kpis WHERE data_product_id = $1 ORDER BY id`, [p.id],
      );
      log(`        KPIs (${kpis.rows.length})`);
      for (const k of kpis.rows) {
        log(`          • ${k.name}`);
        if (k.formula_plain_text) log(`            ${k.formula_plain_text.slice(0, 100)}${k.formula_plain_text.length > 100 ? '…' : ''}`);
      }
    }

    // DASHBOARDS
    const dashboards = await client.query<{ id: number; title: string; description: string | null; is_favorite: boolean; created_at: string }>(
      `SELECT id, title, description, is_favorite, created_at FROM dashboards WHERE tenant_id = $1 ORDER BY id DESC LIMIT 20`, [tid],
    );
    log('');
    log(`DASHBOARDS (${dashboards.rows.length})`);
    for (const d of dashboards.rows) {
      const star = d.is_favorite ? ' ★' : '';
      log(`  #${d.id}  "${d.title}"${star}`);
      if (d.description) log(`        ${d.description.slice(0, 150)}${d.description.length > 150 ? '…' : ''}`);
    }

    // GLOSSARY
    const glossExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='business_glossary') AS exists`,
    );
    if (glossExists.rows[0]?.exists) {
      const gloss = await client.query<{ id: number; term: string; meaning: string; tags: string | null }>(
        `SELECT id, term, meaning, tags::text FROM business_glossary WHERE tenant_id = $1 ORDER BY term`, [tid],
      );
      log('');
      log(`GLOSSARY (${gloss.rows.length})`);
      for (const g of gloss.rows) {
        log(`  • ${g.term}`);
        log(`    ${g.meaning.slice(0, 120)}${g.meaning.length > 120 ? '…' : ''}`);
      }
    }

    // RECENT QUERIES — questions previously asked, useful for caching the demo's questions
    const queries = await client.query<{ question_text: string; confidence_score: number | null; was_flagged: boolean; created_at: string }>(
      `SELECT question_text, confidence_score, was_flagged, created_at
         FROM query_log WHERE tenant_id = $1
        ORDER BY id DESC LIMIT 20`, [tid],
    );
    log('');
    log(`RECENT QUERIES (last ${queries.rows.length})`);
    for (const q of queries.rows) {
      const conf = q.confidence_score !== null ? ` (${Math.round(q.confidence_score * 100)}%)` : '';
      const flag = q.was_flagged ? ' [BLOCKED]' : '';
      log(`  ${q.question_text.slice(0, 100)}${q.question_text.length > 100 ? '…' : ''}${conf}${flag}`);
    }

    // CONVERSATIONS — how active is the chat history?
    const convCount = await client.query<CountRow>(
      `SELECT COUNT(*)::text AS n FROM conversations WHERE tenant_id = $1`, [tid],
    );
    log('');
    log(`CONVERSATIONS: ${convCount.rows[0].n}`);

    // NOTEBOOKS — any?
    try {
      const nbCount = await client.query<CountRow>(`SELECT COUNT(*)::text AS n FROM notebooks WHERE tenant_id = $1`, [tid]);
      log(`NOTEBOOKS: ${nbCount.rows[0].n}`);
    } catch { /* table may not exist on older snapshots */ }

    // INGESTED-TABLE ROW COUNTS — gives a sense of data volume (top 10 by row count)
    try {
      const ingested = await client.query<{ table_name: string; row_count: string | null; last_loaded_at: string | null }>(
        `SELECT table_name, row_count::text, last_loaded_at
           FROM ingested_tables WHERE tenant_id = $1
           ORDER BY (row_count IS NOT NULL) DESC, row_count DESC NULLS LAST
           LIMIT 15`, [tid],
      );
      log('');
      log(`TOP INGESTED TABLES (by row count)`);
      for (const r of ingested.rows) {
        const rc = r.row_count ? Number(r.row_count).toLocaleString() : '?';
        log(`  ${r.table_name.padEnd(36)}  ${rc.padStart(12)} rows   last_loaded=${r.last_loaded_at ?? 'never'}`);
      }
    } catch { /* ingested_tables may be empty */ }

    log('');
    log(`────────────────────────────────────────────────────────────────`);
    log(`Done. Paste this output to plan the demo.`);

    // Close the transaction. Read-only — COMMIT or ROLLBACK both fine.
    await client.query('COMMIT');
  } catch (err) {
    // Make sure the transaction doesn't leak open on the connection if
    // a query in the middle threw.
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
