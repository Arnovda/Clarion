import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── Definition version history ───────────────────────────────────────────
  // Stores a snapshot of every edit to tables, columns, KPIs, and relationships.
  await knex.schema.createTable('definition_versions', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id');
    t.text('entity_type').notNullable();    // 'table' | 'column' | 'kpi' | 'relationship'
    t.integer('entity_id').notNullable();   // pgId of the entity
    t.integer('version').notNullable();     // monotonically increasing per entity
    t.jsonb('snapshot').notNullable();      // full state at this version
    t.jsonb('changes');                     // diff: only the fields that changed
    t.text('changed_by');                   // user who made the change
    t.text('change_reason');                // optional commit message
    t.timestamps(true, true);
  });

  await knex.raw(`CREATE INDEX idx_def_versions_entity ON definition_versions (entity_type, entity_id, version)`);
  await knex.raw(`ALTER TABLE definition_versions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE definition_versions FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY definition_versions_tenant ON definition_versions
    USING (tenant_id = current_setting('app.current_tenant')::integer)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // ── Audit log ────────────────────────────────────────────────────────────
  // General-purpose audit trail for all semantic layer operations.
  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id');
    t.text('user_id').notNullable();
    t.text('user_name');                    // denormalized for display
    t.text('action').notNullable();         // 'create' | 'update' | 'delete' | 'approve' | 'reject' | 'import'
    t.text('entity_type').notNullable();    // 'table' | 'column' | 'kpi' | 'relationship'
    t.integer('entity_id');
    t.text('entity_name');                  // denormalized for display
    t.jsonb('details');                     // action-specific details (e.g. changed fields)
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id)`);
  await knex.raw(`CREATE INDEX idx_audit_log_tenant_time ON audit_log (tenant_id, created_at DESC)`);
  await knex.raw(`ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE audit_log FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY audit_log_tenant ON audit_log
    USING (tenant_id = current_setting('app.current_tenant')::integer)
    WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
  `);

  // ── Approval workflow: add status columns to source_tables ───────────────
  // Status flow: draft → pending_review → approved (or rejected → draft)
  const hasTables = await knex.schema.hasColumn('source_tables', 'approval_status');
  if (!hasTables) {
    await knex.schema.alterTable('source_tables', (t) => {
      t.text('approval_status').defaultTo('draft');     // draft | pending_review | approved | rejected
      t.text('approved_by');
      t.timestamp('approved_at');
      t.text('rejection_reason');
    });
  }

  const hasCols = await knex.schema.hasColumn('source_columns', 'approval_status');
  if (!hasCols) {
    await knex.schema.alterTable('source_columns', (t) => {
      t.text('approval_status').defaultTo('draft');
      t.text('approved_by');
      t.timestamp('approved_at');
      t.text('rejection_reason');
    });
  }

  const hasKpis = await knex.schema.hasColumn('kpi_definitions', 'approval_status');
  if (!hasKpis) {
    await knex.schema.alterTable('kpi_definitions', (t) => {
      t.text('approval_status').defaultTo('draft');
      t.text('approved_by');
      t.timestamp('approved_at');
      t.text('rejection_reason');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Remove approval columns
  const hasTables = await knex.schema.hasColumn('source_tables', 'approval_status');
  if (hasTables) {
    await knex.schema.alterTable('source_tables', (t) => {
      t.dropColumn('rejection_reason');
      t.dropColumn('approved_at');
      t.dropColumn('approved_by');
      t.dropColumn('approval_status');
    });
  }
  const hasCols = await knex.schema.hasColumn('source_columns', 'approval_status');
  if (hasCols) {
    await knex.schema.alterTable('source_columns', (t) => {
      t.dropColumn('rejection_reason');
      t.dropColumn('approved_at');
      t.dropColumn('approved_by');
      t.dropColumn('approval_status');
    });
  }
  const hasKpis = await knex.schema.hasColumn('kpi_definitions', 'approval_status');
  if (hasKpis) {
    await knex.schema.alterTable('kpi_definitions', (t) => {
      t.dropColumn('rejection_reason');
      t.dropColumn('approved_at');
      t.dropColumn('approved_by');
      t.dropColumn('approval_status');
    });
  }

  await knex.raw(`DROP POLICY IF EXISTS audit_log_tenant ON audit_log`);
  await knex.schema.dropTableIfExists('audit_log');
  await knex.raw(`DROP POLICY IF EXISTS definition_versions_tenant ON definition_versions`);
  await knex.schema.dropTableIfExists('definition_versions');
}
