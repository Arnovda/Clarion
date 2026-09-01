/**
 * `dashboard_user_views` — the filters YOU left a dashboard on.
 *
 * A dashboard's spec carries default filter values, and everybody who opens it
 * gets those. But a dashboard is read by different people for different jobs:
 * one always looks at last quarter for one customer, another at year-to-date
 * across everything. Re-applying the same filters on every visit is a tax on
 * the person who uses the dashboard most.
 *
 * PER USER, never shared. The whole point is that it is a private lens: two
 * people can sit on the same dashboard with different filters and neither
 * disturbs the other, and neither has to negotiate whose view is "right".
 * That is also why this is NOT stored on the dashboard's spec — a spec edit is
 * a change to the artefact everyone sees.
 *
 * Server-side rather than localStorage, deliberately: "next time they look at
 * the dashboard" means from any device, and browser storage would silently
 * lose the view on a new laptop while appearing to work on the old one.
 *
 * Only filter VALUES are stored. Layout, widget set and titles belong to the
 * dashboard and are shared by definition; a per-user copy of those would fork
 * the artefact rather than filter it.
 */

import type { Knex } from 'knex';

const TABLE = 'dashboard_user_views';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    // Deleting the dashboard takes every private view of it with it —
    // a saved view of something that no longer exists is unreachable state.
    t.integer('dashboard_id').notNullable()
      .references('id').inTable('dashboards').onDelete('CASCADE');
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    // { filterId: value }, exactly the shape the dashboard page holds live.
    // Values whose filter has since been removed are dropped at read time
    // rather than here — the spec can change under a saved view at any time.
    t.jsonb('filter_values').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // One view per person per dashboard: saving replaces, never accumulates.
  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT dashboard_user_views_unique UNIQUE (dashboard_id, user_id)
  `);

  await knex.raw(`
    ALTER TABLE "${TABLE}" ALTER COLUMN tenant_id
    SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
  `);

  // RLS — canonical policy name + predicate, as every tenant-owned table here.
  // Note this isolates by TENANT; the per-USER scoping is the unique key plus
  // an explicit user_id filter on every query, because RLS has no notion of
  // which user inside the tenant is asking.
  await knex.raw(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON "${TABLE}"
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  await knex.raw(`CREATE INDEX idx_dashboard_user_views_lookup ON "${TABLE}" (dashboard_id, user_id)`);

  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
