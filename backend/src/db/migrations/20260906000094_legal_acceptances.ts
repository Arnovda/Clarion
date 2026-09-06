import type { Knex } from 'knex';

/**
 * `legal_acceptances` — who accepted which version of the Terms, Privacy
 * Policy and DPA, when, from where (P0-7).
 *
 * One row per ACT of acceptance, never updated: a version bump asks again
 * and adds a row, so the history of what a person agreed to is complete.
 * Article 28 wants the contract before processing; the row is the evidence
 * that it was there. Written at registration (source 'register') and by the
 * signed-in acceptance gate (source 'login'). Nothing is written while
 * LEGAL_IN_FORCE is false — an acceptance of a draft is not an acceptance.
 */
const TABLE = 'legal_acceptances';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.text('terms_version').notNullable();
    t.text('privacy_version').notNullable();
    t.text('dpa_version').notNullable();
    // 'register' | 'login'
    t.text('source').notNullable();
    t.text('ip').nullable();
    t.text('user_agent').nullable();
    t.timestamp('accepted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX legal_acceptances_user_idx ON "${TABLE}" (tenant_id, user_id, accepted_at DESC)`);

  await knex.raw(`
    ALTER TABLE "${TABLE}" ALTER COLUMN tenant_id
    SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
  `);
  await knex.raw(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON "${TABLE}"
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
