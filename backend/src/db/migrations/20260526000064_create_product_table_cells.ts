/**
 * `product_table_cells` — notebook cells for each product table.
 *
 * Each product table (dim_customer, fact_sales, etc.) has one or more cells
 * that together form its "mini-notebook". The cells define the transformation
 * logic that produces the table.
 *
 * Cell types:
 *   - sql:      Raw DuckDB SQL (the primary type)
 *   - markdown: Documentation / description (rendered as markdown)
 *   - nl:       Natural language prompt → AI generates SQL in `generated_sql`
 *
 * The cell marked `is_deploy_cell = true` is the one whose SQL becomes
 * `product_tables.transformation_sql` when the user clicks "Deploy".
 * Typically this is the last (or only) SQL cell.
 *
 * Backfill: every existing product_table with transformation_sql gets one
 * SQL cell so the notebook view has content from day one.
 */

import type { Knex } from 'knex';

const TABLE = 'product_table_cells';

export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable(TABLE);
  if (exists) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('product_table_id').notNullable()
      .references('id').inTable('product_tables').onDelete('CASCADE');
    t.text('cell_type').notNullable().defaultTo('sql');
    t.text('source').notNullable().defaultTo('');
    t.text('generated_sql');
    t.integer('position').notNullable().defaultTo(0);
    t.jsonb('last_output');
    t.text('last_status');
    t.timestamp('last_run_at', { useTz: true });
    t.boolean('is_deploy_cell').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Default tenant_id from session variable
  await knex.raw(`
    ALTER TABLE "${TABLE}" ALTER COLUMN tenant_id
    SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
  `);

  // CHECK constraints
  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT product_table_cells_cell_type_check
      CHECK (cell_type IN ('sql', 'markdown', 'nl'))
  `);

  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT product_table_cells_last_status_check
      CHECK (last_status IS NULL OR last_status IN ('success', 'error'))
  `);

  // RLS — matches the pattern from migration 20
  await knex.raw(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON "${TABLE}"
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX idx_product_table_cells_table_pos
      ON "${TABLE}" (product_table_id, position)
  `);
  await knex.raw(`
    CREATE INDEX idx_product_table_cells_tenant
      ON "${TABLE}" (tenant_id)
  `);

  // Grant to unprivileged app role
  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE product_table_cells_id_seq TO databridge_app`);
  }

  // ─── Backfill ──────────────────────────────────────────────────────────────
  // For every existing product_table that has transformation_sql, create one
  // SQL cell. This ensures the notebook view has content from day one.
  //
  // We must use the superuser role for the backfill because RLS requires
  // app.current_tenant to be set, and we're running across all tenants.
  // The FORCE RLS bypass for the table owner handles this.
  await knex.raw(`
    INSERT INTO "${TABLE}" (tenant_id, product_table_id, cell_type, source, position, is_deploy_cell, created_at, updated_at)
    SELECT
      pt.tenant_id,
      pt.id,
      'sql',
      pt.transformation_sql,
      0,
      true,
      NOW(),
      NOW()
    FROM product_tables pt
    WHERE pt.transformation_sql IS NOT NULL
      AND pt.transformation_sql != ''
      AND NOT EXISTS (
        SELECT 1 FROM "${TABLE}" c WHERE c.product_table_id = pt.id
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.schema.dropTableIfExists(TABLE);
}
