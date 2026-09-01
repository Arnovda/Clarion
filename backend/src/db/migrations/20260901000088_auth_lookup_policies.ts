/**
 * `auth_lookup` — the policy that makes login work — finally lives in a
 * migration.
 *
 * Thirteen places in this codebase describe an `auth_lookup` RLS policy that
 * lets an UNAUTHENTICATED `SELECT` find a user: `unauthQuery`'s whole design,
 * `tenantScopedWrite`'s header, every unauthenticated route in
 * `routes/auth.ts`, `refreshTokenService`. Until this migration, the only
 * thing that ever CREATED it was `backend/scripts/prod-fix-missing-policies.ts`
 * — a hand-run script no workflow and no `.ops` control invokes.
 *
 * A database provisioned purely from migrations therefore gives `users` only
 * `tenant_isolation`, whose predicate under empty tenant context is
 * `tenant_id = NULL` — never true, zero rows. Under `databridge_app`
 * (NOBYPASSRLS, the production role since the 2026-08-06 flip) login,
 * forgot-password, refresh-token validation and WebAuthn verification can only
 * fail, and register's duplicate-email check always concludes the address is
 * free. Measured 2026-08-31 and again while building this migration: with a
 * real user row present, a NOBYPASSRLS role running
 * `SET LOCAL app.current_tenant = ''` reads 0 rows from `users`.
 * (This is the market-readiness assessment's P0-1.)
 *
 * The policy, verbatim from the script, on the same five tables — the narrow
 * set touched by unauthenticated routes (login, register's pre-existing-email
 * check, forgot/reset-password lookup, refresh-token validation, WebAuthn
 * login verify, OAuth callback):
 *
 *   CREATE POLICY auth_lookup ON <t>
 *     FOR SELECT
 *     USING (NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
 *
 * FOR SELECT only — an unauthenticated request must never INSERT/UPDATE/DELETE
 * past `tenant_isolation` (writes under empty context keep affecting 0 rows,
 * which is why `tenantScopedWrite` exists). The predicate is true both when
 * the setting was explicitly reset to '' (`unauthQuery`) and when it was never
 * set on the connection at all (`current_setting(..., true)` returns NULL).
 *
 * Permissive policies OR together, so on an authenticated connection
 * `tenant_isolation` still scopes reads to the caller's own tenant — the
 * carve-out only widens the no-context case, where `tenant_isolation` grants
 * nothing.
 *
 * `api_tokens` is NOT in this list on purpose: migration 86 already gave it
 * its own `token_lookup` policy of exactly this shape, precisely because
 * `auth_lookup` could not be relied on to exist. That stays as it is.
 *
 * ── oauth_pending needs two extra repairs first ─────────────────────────────
 *
 * Its migration (20260503000042) only enabled RLS *if* `databridge_app`
 * existed at migration time, and its policy predicate is the pre-NULLIF shape
 * `current_setting('app.current_tenant')::integer` — no missing_ok, no NULLIF.
 * That expression THROWS under empty ('' is not an integer) or unset
 * (unrecognized parameter) context. Because permissive policies are OR-ed into
 * one qual with no guaranteed evaluation order, leaving it in place could make
 * the very SELECT `auth_lookup` permits error instead. So this migration
 * normalises oauth_pending to the canonical `tenant_isolation` policy
 * (ENABLE + FORCE + NULLIF predicate) before adding the carve-out — the same
 * rule every other tenant table answers to.
 */

import type { Knex } from 'knex';

/**
 * Tables that participate in unauthenticated lookups. Mirrored in
 * `scripts/preflight-role-flip.ts` (which asserts these policies exist before
 * a role flip) and `scripts/prod-fix-missing-policies.ts` — keep the three
 * lists in agreement.
 */
const AUTH_LOOKUP_TABLES = [
  'users',
  'refresh_tokens',
  'webauthn_credentials',
  'mfa_backup_codes',
  'oauth_pending',
];

export async function up(knex: Knex): Promise<void> {
  // Repair oauth_pending first (see header): make its RLS unconditional and
  // its tenant policy the canonical never-throwing shape.
  await knex.raw(`ALTER TABLE oauth_pending ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE oauth_pending FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS oauth_pending_tenant ON oauth_pending`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON oauth_pending`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON oauth_pending
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
  `);

  for (const table of AUTH_LOOKUP_TABLES) {
    // DROP-then-CREATE so this is idempotent against a production database
    // where prod-fix-missing-policies.ts already created the policy by hand.
    await knex.raw(`DROP POLICY IF EXISTS auth_lookup ON "${table}"`);
    await knex.raw(`
      CREATE POLICY auth_lookup ON "${table}"
        FOR SELECT
        USING (NULLIF(current_setting('app.current_tenant', true), '') IS NULL)
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  // A true inverse for the carve-out: dropping auth_lookup returns the tables
  // to deny-under-no-context, which is the (broken-login) pre-migration state.
  for (const table of AUTH_LOOKUP_TABLES) {
    await knex.raw(`DROP POLICY IF EXISTS auth_lookup ON "${table}"`);
  }
  // The oauth_pending normalisation is deliberately NOT reverted: restoring
  // the pre-NULLIF predicate would be reinstating a policy that throws under
  // empty tenant context — reverting a bug fix, not a rollback.
}
