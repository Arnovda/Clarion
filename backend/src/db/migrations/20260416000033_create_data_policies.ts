import type { Knex } from 'knex';

/**
 * Row-level data access policies.
 *
 * Admins define filter expressions that restrict which rows specific users
 * or roles can see when querying data. The policy engine injects these
 * filters into AI-generated SQL before execution.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('data_policies', (table) => {
    table.increments('id').primary();
    table.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    table.string('name', 255).notNullable();
    table.text('description');
    table.integer('user_id').references('id').inTable('users').onDelete('CASCADE');  // NULL = applies to a role
    table.string('role', 50);                            // 'analyst', 'viewer', NULL = specific user
    table.string('table_name', 255).notNullable();       // which table this policy applies to
    table.string('column_name', 255);                    // optional: for column masking
    table.text('filter_expression').notNullable();        // SQL WHERE clause fragment
    table.string('policy_type', 20).notNullable().defaultTo('row_filter'); // 'row_filter' or 'column_mask'
    table.boolean('is_active').notNullable().defaultTo(true);
    table.integer('created_by').references('id').inTable('users');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // Performance index for looking up active policies by tenant + table
  await knex.raw(`CREATE INDEX idx_data_policies_tenant_table_active ON data_policies (tenant_id, table_name, is_active)`);

  // RLS for tenant isolation (same pattern as all other tables)
  await knex.raw(`ALTER TABLE data_policies ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE data_policies FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON data_policies
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  // Set default tenant_id from session variable (same as other tables)
  await knex.raw(`ALTER TABLE data_policies ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON data_policies`);
  await knex.raw(`ALTER TABLE data_policies DISABLE ROW LEVEL SECURITY`);
  await knex.raw(`DROP INDEX IF EXISTS idx_data_policies_tenant_table_active`);
  await knex.schema.dropTableIfExists('data_policies');
}
