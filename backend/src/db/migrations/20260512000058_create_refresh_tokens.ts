/**
 * Refresh tokens — short-lived access tokens with server-side revocation.
 *
 * Before this table the platform issued 8-hour HS256 access tokens with
 * no way to revoke them. A stolen token was valid for up to 8 hours
 * regardless of logout. SOC 2 CC6 and most security questionnaires
 * explicitly ask "can you revoke a session?" — the answer was no.
 *
 * After this:
 *   - Access tokens: 15 minutes, HS256 (same format, shorter expiry)
 *   - Refresh tokens: 30 days, random 32-byte strings stored HASHED in
 *     this table. Sent to the client once; server stores only the hash.
 *   - On access-token expiry, frontend hits POST /api/auth/refresh
 *     with the refresh token; server validates against the hash and
 *     issues a new access token.
 *   - On logout: refresh token is marked revoked.
 *   - On password change: ALL the user's refresh tokens are revoked.
 *   - Admin can force-logout a user by revoking their tokens.
 *
 * Storage is one row per token, never updated except to flip `revoked`.
 * Cleanup of expired+revoked rows happens via a daily cron in
 * jobs/scheduler.ts (added separately).
 *
 * No rotation in v1 — refresh tokens can be reused until expiry.
 * Rotation (issue new refresh on every refresh, invalidate old) is
 * a nice security upgrade but introduces race-condition complexity;
 * deferring to a follow-up once we see real attack patterns.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('refresh_tokens', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`NULLIF(current_setting('app.current_tenant', true), '')::integer`));
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    // sha256(rawToken) — the raw 32-byte token is never stored. Same
    // pattern as password_reset_token in users.
    t.text('token_hash').notNullable().unique();

    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.text('revoked_reason').nullable();   // 'logout' | 'password_change' | 'admin_revoke' | 'rotation'

    // Forensics — capture where the token was issued from so we can
    // tell "the token from IP X was used to refresh from IP Y" stories.
    t.text('issued_ip').nullable();
    t.text('issued_user_agent').nullable();
    t.timestamp('last_used_at', { useTz: true }).nullable();
    t.text('last_used_ip').nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['user_id', 'revoked_at'], 'refresh_tokens_user_active_idx');
    t.index(['tenant_id', 'expires_at'], 'refresh_tokens_cleanup_idx');
  });

  // ── RLS ────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
    // Full CRUD — we need UPDATE to flip revoked_at, DELETE for cleanup.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE refresh_tokens_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('refresh_tokens');
}
