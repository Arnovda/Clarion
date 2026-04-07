import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add sharing, folder, auto-refresh, and permission columns to dashboards
  await knex.schema.alterTable('dashboards', (t) => {
    t.boolean('is_shared').defaultTo(false);           // visible to all tenant users
    t.text('shared_permission').defaultTo('viewer');    // default permission for shared: viewer | editor
    t.text('folder');                                   // folder/category name (nullable = uncategorized)
    t.integer('auto_refresh_seconds');                  // null = no auto-refresh
  });

  // Dashboard templates — pre-built layouts available to all tenants
  await knex.schema.createTable('dashboard_templates', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id');                             // null = global template
    t.text('name').notNullable();
    t.text('description');
    t.text('category');                                 // e.g. "Sales", "Finance", "Operations"
    t.jsonb('spec').notNullable();                      // DashboardSpec JSON
    t.text('preview_image');                            // optional base64 thumbnail
    t.timestamps(true, true);
  });

  // RLS on dashboard_templates
  await knex.raw(`ALTER TABLE dashboard_templates ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE dashboard_templates FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY dashboard_templates_tenant_isolation ON dashboard_templates
    USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant')::integer)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // Index for shared dashboards lookup
  await knex.raw(`CREATE INDEX idx_dashboards_shared ON dashboards (tenant_id, is_shared) WHERE is_shared = true`);
  await knex.raw(`CREATE INDEX idx_dashboards_folder ON dashboards (tenant_id, folder) WHERE folder IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_dashboards_folder`);
  await knex.raw(`DROP INDEX IF EXISTS idx_dashboards_shared`);
  await knex.raw(`DROP POLICY IF EXISTS dashboard_templates_tenant_isolation ON dashboard_templates`);
  await knex.schema.dropTableIfExists('dashboard_templates');
  await knex.schema.alterTable('dashboards', (t) => {
    t.dropColumn('auto_refresh_seconds');
    t.dropColumn('folder');
    t.dropColumn('shared_permission');
    t.dropColumn('is_shared');
  });
}
