/**
 * `feature_flags` — separating "the code is deployed" from "this customer can see it".
 *
 * Today those are one event: a push reaches main, the revision is promoted, and
 * every tenant gets the change simultaneously. That is fine with one tenant and
 * unacceptable with ten — there is no way to put something in front of a test
 * tenant first, and no way to withdraw it that does not involve a rollback of
 * unrelated work shipped in the same revision.
 *
 * WHY THIS TABLE HAS NO `tenant_id` COLUMN, deliberately, against the house
 * pattern: a flag is not tenant-owned data. It is an OPERATOR record ABOUT
 * tenants, and the operator sits outside any one tenant's RLS scope. Enrolling
 * it in `tenant_isolation` would make the row visible only to the tenant it
 * mentions — while the person who needs to write it (the operator, whose
 * session variable holds their OWN tenant id) would be refused by the WITH
 * CHECK clause on every insert. So the audience lives in a jsonb array and the
 * ONLY access control is the operator gate on the route. That is a real
 * trade-off and it is why `routes/featureFlags.ts` carries a test asserting a
 * non-operator is refused: here, unlike everywhere else in this schema, there
 * is no database-level second line of defence.
 *
 * `key` is a foreign key in spirit to the `FEATURE_FLAGS` registry in
 * `shared/contract.ts` — a row whose key is not in that registry is ignored on
 * read and reported as an orphan in the console. Rows are created lazily: a
 * flag with no row is 'off', which is the correct state for a flag someone
 * just declared in code and has not rolled out to anyone.
 */

import type { Knex } from 'knex';

const TABLE = 'feature_flags';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    // Matches a key in the code registry. Unique: one rollout state per flag.
    t.text('key').notNullable().unique();
    // 'off' | 'tenants' | 'all' — see the ladder in shared/contract.ts.
    t.text('rollout').notNullable().defaultTo('off');
    // Tenant ids that see the feature while rollout = 'tenants'. Stored as an
    // array rather than a join table because the whole point is that this is
    // read on every request: one small row beats a join, and the set is a
    // handful of integers for the lifetime of a flag.
    t.jsonb('tenant_ids').notNullable().defaultTo('[]');
    t.text('updated_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT feature_flags_rollout_check
      CHECK (rollout IN ('off', 'tenants', 'all'))
  `);

  // The array must really be an array — a bare object or string here would
  // make every membership test throw at read time, i.e. break every request.
  await knex.raw(`
    ALTER TABLE "${TABLE}"
      ADD CONSTRAINT feature_flags_tenant_ids_is_array
      CHECK (jsonb_typeof(tenant_ids) = 'array')
  `);

  // NO row-level security on purpose — see the header. The table holds no
  // tenant-owned data, and migration 20260512000056's blanket enable only
  // covers tables WITH a tenant_id column, so this one is untouched by it.
  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
