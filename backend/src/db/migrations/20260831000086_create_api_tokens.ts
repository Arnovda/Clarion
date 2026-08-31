/**
 * `api_tokens` — machine authentication for clients that are not a browser.
 *
 * Everything in Clarion has so far authenticated with a JWT obtained by a
 * person signing in. That works for the web app and for nothing else. The
 * Excel add-in runs inside Excel's webview with no Clarion session, and the
 * same gap blocks any future non-browser client — an MCP endpoint for AI
 * agents, a scheduled export, a customer's own script.
 *
 * A token belongs to a USER, not to a tenant. It carries exactly that user's
 * role and tenant, so a viewer's token can do what a viewer can do and nothing
 * more. There is no service account and no token that outranks its owner:
 * granting a machine more than the person who created it is how an integration
 * quietly becomes a privilege-escalation path.
 *
 * WHAT IS STORED IS A SHA-256 HASH, NEVER THE TOKEN. The plaintext is returned
 * once at creation and is unrecoverable afterwards — losing it means issuing a
 * new one, which is the correct trade. SHA-256 rather than bcrypt on purpose,
 * and it is the opposite of the rule for passwords: a token is 256 bits of
 * machine-generated randomness with no dictionary to attack, so the slow hash
 * buys nothing, while the fast hash matters because this runs on every request
 * the add-in makes. `prefix` is the first characters of the token, stored in
 * clear so the UI can show a user WHICH token they are revoking.
 *
 * `expires_at` is nullable but the route sets it: a token that never expires is
 * a credential nobody ever revisits.
 */

import type { Knex } from 'knex';

const TABLE = 'api_tokens';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    // What the user called it, so a list of tokens is readable a year later.
    t.text('name').notNullable();
    // SHA-256 of the full plaintext token, hex. Unique so a lookup is an index
    // hit rather than a scan over every tenant's tokens.
    t.text('token_hash').notNullable().unique();
    // First characters of the plaintext, e.g. `clr_a1b2c3`. Shown in the UI;
    // far too short to be useful to anyone who obtains it.
    t.text('prefix').notNullable();
    t.timestamp('last_used_at', { useTz: true });
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('revoked_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE "${TABLE}" ALTER COLUMN tenant_id
    SET DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::integer
  `);

  // RLS — canonical policy name + predicate, as every tenant-owned table here.
  await knex.raw(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON "${TABLE}"
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  // ── The lookup policy, and why this table needs its own ────────────────
  //
  // Verifying a token happens BEFORE the tenant is known — that is what the
  // token is for. Under `tenant_isolation` alone the predicate is
  // `tenant_id = NULL`, which is never true, so the lookup would find nothing
  // and every request from the add-in would be rejected as unauthenticated.
  //
  // The codebase describes an `auth_lookup` policy that grants exactly this
  // carve-out on `users`. IT DOES NOT EXIST — not in any migration, and not in
  // a migrated database. (Measured 2026-08-31: with a user row present, a
  // NOBYPASSRLS role running `SET LOCAL app.current_tenant = ''` — precisely
  // what `unauthQuery` does — reads zero rows.) So rather than inherit an
  // assumption that is not true, this table carries its own policy and works
  // under either configuration.
  //
  // Scope of what it opens: SELECT only, and only while there is NO tenant
  // context. The rows hold a SHA-256 hash, never a usable token, so what an
  // uncontexted read can obtain is a hash it cannot reverse plus a display
  // name. Writes stay under `tenant_isolation`, so a token can only ever be
  // created or revoked inside its owner's tenant.
  await knex.raw(`DROP POLICY IF EXISTS token_lookup ON "${TABLE}"`);
  await knex.raw(`
    CREATE POLICY token_lookup ON "${TABLE}"
      FOR SELECT
      USING (NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
  `);

  await knex.raw(`CREATE INDEX idx_api_tokens_tenant_user ON "${TABLE}" (tenant_id, user_id)`);

  const hasAppRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasAppRole.rows.length > 0) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE ${TABLE}_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}
