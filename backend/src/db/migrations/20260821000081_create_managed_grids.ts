/**
 * `managed_grids` + `managed_grid_rows` — the in-Clarion spreadsheet place.
 *
 * A managed grid is a small tenant-owned table a business user edits INSIDE
 * Clarion: budgets, mappings, reference lists — the satellite data that today
 * lives in Excel files next to the systems Clarion connects to. The design
 * decision (2026-08-21, owner-approved): grids do NOT get a physical Postgres
 * table each. The schema of a grid is CONTENT — `columns` JSONB on the grid
 * row — and the cells are JSONB on `managed_grid_rows`. Two fixed tables,
 * enrolled in RLS once, cover every grid any tenant ever creates; dynamic
 * per-grid DDL would require the app role to run CREATE TABLE at runtime and
 * re-establish RLS per table, which is the opposite of the 2026-08-06
 * hardening direction.
 *
 * Postgres is the TRUTH (edits, audit, backups). On save the rows are
 * materialised to the tenant's warehouse as an ordinary Parquet table
 * (versioned directory, recorded in `warehouse_path` at write time — the
 * catalog rule: a reader never re-derives a location), where Ask AI and
 * dashboards read it like any other table.
 *
 * `tenant_id` is deliberately denormalised onto `managed_grid_rows` even
 * though the parent carries it: RLS needs it on every table, and
 * `purgeTenant` enumerates tables BY tenant_id column — a rows table without
 * one would be silently skipped by GDPR purge.
 */

import type { Knex } from 'knex';

const GRIDS = 'managed_grids';
const ROWS = 'managed_grid_rows';

export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable(GRIDS);
  if (exists) return;

  await knex.schema.createTable(GRIDS, (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.text('name').notNullable();
    // Stable identifier chosen at creation; the warehouse view is
    // `grid_<slug>`. Deliberately NOT re-derived on rename so saved
    // dashboards and questions keep resolving.
    t.text('slug').notNullable();
    t.text('description');
    t.text('kind').notNullable().defaultTo('list');
    // Array of { key, name, type } — key is the warehouse column identifier
    // (validated server-side), name is the display label, type is one of
    // text | number | date | boolean.
    t.jsonb('columns').notNullable();
    t.integer('row_count').notNullable().defaultTo(0);
    // Recorded at write time by the materialiser (directory URI, never a
    // file path — the Azure branch of createScanView cannot resolve a bare
    // .parquet file). NULL = never materialised.
    t.text('warehouse_path');
    t.integer('materialize_version').notNullable().defaultTo(0);
    t.timestamp('materialized_at', { useTz: true });
    t.text('materialize_error');
    t.text('created_by');
    t.text('updated_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable(ROWS, (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('grid_id').notNullable()
      .references('id').inTable(GRIDS).onDelete('CASCADE');
    t.integer('position').notNullable().defaultTo(0);
    t.jsonb('data').notNullable();
    t.text('updated_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  for (const tbl of [GRIDS, ROWS]) {
    await knex.raw(`
      ALTER TABLE "${tbl}" ALTER COLUMN tenant_id
      SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
    `);

    // RLS — canonical policy name + predicate (see migration 74's header for
    // why both are standardised).
    await knex.raw(`ALTER TABLE "${tbl}" ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE "${tbl}" FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${tbl}"`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON "${tbl}"
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
  }

  await knex.raw(`
    ALTER TABLE "${GRIDS}"
      ADD CONSTRAINT managed_grids_kind_check
      CHECK (kind IN ('budget', 'mapping', 'list'))
  `);

  // The slug becomes the warehouse view name (`grid_<slug>`), so it must be
  // unique per tenant or two grids would fight over one view.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_managed_grids_tenant_slug
      ON "${GRIDS}" (tenant_id, slug)
  `);
  await knex.raw(`CREATE INDEX idx_managed_grids_tenant ON "${GRIDS}" (tenant_id)`);
  await knex.raw(`CREATE INDEX idx_managed_grid_rows_grid_pos ON "${ROWS}" (grid_id, position)`);
  await knex.raw(`CREATE INDEX idx_managed_grid_rows_tenant ON "${ROWS}" (tenant_id)`);

  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    for (const tbl of [GRIDS, ROWS]) {
      await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${tbl}" TO databridge_app`);
      await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${tbl}_id_seq TO databridge_app`);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${ROWS}"`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${GRIDS}"`);
  await knex.schema.dropTableIfExists(ROWS);
  await knex.schema.dropTableIfExists(GRIDS);
}
