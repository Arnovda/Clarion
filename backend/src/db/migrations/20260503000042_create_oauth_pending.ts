/**
 * Adds `oauth_pending` — short-lived storage for OAuth Authorization Code
 * flows in progress. Lifecycle:
 *
 *   1. Wizard's "Connect with X" button → POST /api/source-types/:type/oauth-init
 *      • inserts a row with the user's pre-auth fields (clientId, secret, etc.)
 *        encrypted via the existing AES-256-GCM crypto
 *      • returns the stateToken (= row.state_token) and the OAuth provider's
 *        authorisation URL
 *   2. Browser pops to provider, user authorises, provider redirects to
 *      GET /api/source-types/:type/oauth-callback?code=&state=
 *      • backend looks up the pending row by state_token, exchanges code for
 *        tokens via the connector's OAuthSpec.exchangeCode, updates the row's
 *        encrypted_config to include the freshly-acquired refresh_token
 *   3. Subsequent calls (test, list-entities, save) accept `stateToken`
 *      instead of inline `config` — backend reads the full config from
 *      this table.
 *   4. On Save, the row is deleted (the persistent connection's
 *      `connector_config_encrypted` takes over). Stale rows
 *      (status='pending' for >2h) are also dropped opportunistically by
 *      oauth-init to keep the table small.
 *
 * Why a real table rather than an in-memory map: the prod backend is
 * configured for autoscaling (max_replicas=3 per Terraform). The OAuth
 * popup callback may hit a different replica than the wizard, so any
 * shared state needs to be DB-backed.
 *
 * Why bare TEXT for state_token rather than UUID: state tokens are HMAC
 * digests of the row id + a server secret (CSRF guard). They look like
 * URL-safe base64 strings, not UUIDs.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('oauth_pending', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    // Created BY the user who initiated. Used to gate /test, /list-entities,
    // and the eventual /connections/source call to the same identity.
    t.integer('initiated_by_user_id').notNullable().references('id').inTable('users');
    t.string('connector_type', 64).notNullable();           // 'exactonline' | 'netsuite' | ...
    // Status moves: 'pending' → 'authorised' (after callback exchanges code) → deleted on save.
    t.string('status', 16).notNullable().defaultTo('pending');
    // Random nonce (HMAC) — used as the OAuth `state` param + as the API
    // identifier the wizard passes back to test/list-entities/save.
    t.string('state_token', 128).notNullable().unique();
    // Encrypted JSON config. Pre-auth fields at insert; full config (with
    // refresh_token) after callback completes.
    t.text('encrypted_config').notNullable();
    // The redirect_uri we used when building the auth URL. Stored verbatim
    // because OAuth providers require the SAME value on the token-exchange
    // call — if our backend hostname rotates between init + callback (e.g.
    // a different replica with a different X-Forwarded-Host) we'd otherwise
    // mismatch and lose the code.
    t.text('redirect_uri').notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(
    `CREATE INDEX idx_oauth_pending_lookup
       ON oauth_pending (state_token)`,
  );
  await knex.raw(
    `CREATE INDEX idx_oauth_pending_expiry
       ON oauth_pending (expires_at)`,
  );

  // RLS — only applied when the dual-role setup is in place (matching the
  // pattern from migration 20260502000041).
  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`ALTER TABLE oauth_pending ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE oauth_pending FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY oauth_pending_tenant ON oauth_pending
      USING (tenant_id = current_setting('app.current_tenant')::integer)
      WITH CHECK (tenant_id = current_setting('app.current_tenant')::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_pending TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE oauth_pending_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('oauth_pending');
}
