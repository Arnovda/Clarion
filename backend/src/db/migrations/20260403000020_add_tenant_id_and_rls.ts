import type { Knex } from 'knex';

/**
 * Multi-tenancy migration:
 * 1. Add tenant_id to every data table
 * 2. Backfill existing rows with tenant_id = 1 (default tenant)
 * 3. Enable Row-Level Security (RLS) on each table
 * 4. Create RLS policy: rows visible only when tenant_id = current_setting('app.current_tenant')
 *
 * The backend middleware sets `app.current_tenant` on each request from the JWT.
 * Even if application code forgets a WHERE clause, Postgres blocks cross-tenant access.
 */

const TABLES = [
  'connections',
  'source_tables',
  'source_columns',
  'table_relationships',
  'kpi_definitions',
  'query_log',
  'definition_gaps',
  'dashboards',
  'data_products',
  'data_product_sources',
  'star_schemas',
  'product_tables',
  'product_columns',
  'column_lineage',
  'product_relationships',
  'product_kpis',
  'ingested_tables',
  'dataset_profiles',
  'field_profiles',
  'quality_rules',
  'rule_executions',
  'quality_failures',
  'quality_score_history',
  'cross_source_views',
  'cross_view_tables',
  'cross_view_relationships',
  'transformation_checks',
];

export async function up(knex: Knex): Promise<void> {
  // Ensure a default tenant exists for backfilling existing data
  const existingTenant = await knex('tenants').where({ id: 1 }).first();
  if (!existingTenant) {
    await knex.raw(`INSERT INTO tenants (id, name, slug, status) VALUES (1, 'Default', 'default', 'active') ON CONFLICT (id) DO NOTHING`);
  }

  for (const table of TABLES) {
    // Check if column already exists (idempotent)
    const hasCol = await knex.schema.hasColumn(table, 'tenant_id');
    if (!hasCol) {
      // Add column as nullable first
      await knex.schema.alterTable(table, (t) => {
        t.integer('tenant_id').references('id').inTable('tenants');
      });

      // Backfill existing rows
      await knex(table).whereNull('tenant_id').update({ tenant_id: 1 });

      // Make NOT NULL + set default from session variable
      // This means INSERT statements don't need to include tenant_id — Postgres fills it
      await knex.raw(`ALTER TABLE "${table}" ALTER COLUMN tenant_id SET NOT NULL`);
      await knex.raw(`ALTER TABLE "${table}" ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer`);
    }

    // Enable RLS
    await knex.raw(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);

    // Force RLS on table owner too (otherwise the owner bypasses RLS)
    await knex.raw(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);

    // Create policy (drop first if exists for idempotency)
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON "${table}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
  }

  // Add index on tenant_id for every table (speeds up RLS filtering)
  for (const table of TABLES) {
    const indexName = `idx_${table}_tenant_id`;
    const hasIndex = await knex.raw(`
      SELECT 1 FROM pg_indexes WHERE tablename = ? AND indexname = ?
    `, [table, indexName]);
    if (hasIndex.rows.length === 0) {
      await knex.raw(`CREATE INDEX "${indexName}" ON "${table}" (tenant_id)`);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [...TABLES].reverse()) {
    // Drop RLS policy and disable
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
    await knex.raw(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);

    // Drop index
    await knex.raw(`DROP INDEX IF EXISTS "idx_${table}_tenant_id"`);

    // Drop column
    const hasCol = await knex.schema.hasColumn(table, 'tenant_id');
    if (hasCol) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn('tenant_id');
      });
    }
  }
}
