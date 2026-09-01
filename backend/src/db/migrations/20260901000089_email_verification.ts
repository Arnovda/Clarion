/**
 * Email verification columns on `users` — the storage half of the
 * market-readiness assessment's P0-5 (open registration hardening).
 *
 * Same shape as the password-reset pair that already lives on this table:
 * the RAW token exists only inside the sent email, the row stores its
 * SHA-256, and an expiry bounds the window. `email_verified_at` is the
 * fact of interest — a timestamp rather than a boolean because WHEN an
 * address was proven matters for support and audit.
 *
 * EVERY EXISTING USER IS BACKFILLED AS VERIFIED. They predate the
 * mechanism, they include the platform's own operators, and several were
 * created through the invite flow, which already proves inbox control by
 * construction (the invite link arrives by email). Leaving them NULL would
 * lock every current account out of login the moment enforcement turns on.
 *
 * Enforcement itself is application policy, not schema: see
 * services/signup.ts (`emailVerificationRequired`) — required when an email
 * provider is configured or REQUIRE_EMAIL_VERIFICATION forces it, off in
 * environments that cannot send mail at all (local dev, CI), where users
 * are created pre-verified rather than unreachable.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('email_verified_at', { useTz: true }).nullable();
    // SHA-256 hex of the raw token, never the token itself — identical
    // discipline to password_reset_token two columns over.
    t.text('email_verification_token').nullable();
    t.timestamp('email_verification_expires', { useTz: true }).nullable();
  });

  await knex.raw(`
    UPDATE users
       SET email_verified_at = COALESCE(created_at, NOW())
     WHERE email_verified_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('email_verified_at');
    t.dropColumn('email_verification_token');
    t.dropColumn('email_verification_expires');
  });
}
