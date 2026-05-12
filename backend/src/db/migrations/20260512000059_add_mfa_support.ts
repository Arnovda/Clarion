/**
 * MFA (TOTP) support — adds the columns needed for time-based one-time
 * password 2FA on the `users` table, plus a side table for one-shot
 * recovery codes.
 *
 * Why TOTP and not SMS / WebAuthn:
 *   - TOTP works offline, with any standard authenticator (Google
 *     Authenticator, 1Password, Authy, Bitwarden, etc.).
 *   - SMS is phishable + costs money + requires a phone number per user.
 *   - WebAuthn / hardware keys are the gold standard but require
 *     significantly more frontend work and customer education. We can
 *     add WebAuthn alongside TOTP later — the columns we add now don't
 *     conflict with a WebAuthn credential table.
 *
 * Columns:
 *   users.mfa_secret           — base32 TOTP secret (encrypted at rest
 *                                via encryptCredentials()). NULL when MFA
 *                                is not enrolled.
 *   users.mfa_enabled_at       — timestamp the user activated MFA. NULL
 *                                when not enrolled. Allows "enrolled but
 *                                not yet active" intermediate state
 *                                during the enrolment ceremony.
 *
 * Side table:
 *   mfa_backup_codes — sha256-hashed one-shot recovery codes. 10 per
 *                      user. `used_at` flips when consumed. Once used,
 *                      a code can never be reused.
 *
 * RLS on both — tenant-isolated like everything else.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasMfaSecret = await knex.schema.hasColumn('users', 'mfa_secret');
  if (!hasMfaSecret) {
    await knex.schema.alterTable('users', (t) => {
      t.text('mfa_secret').nullable();
      t.timestamp('mfa_enabled_at', { useTz: true }).nullable();
    });
  }

  await knex.schema.createTable('mfa_backup_codes', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`NULLIF(current_setting('app.current_tenant', true), '')::integer`));
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    // sha256(rawCode). Raw codes are shown to the user ONCE on enrolment
    // and never persisted.
    t.text('code_hash').notNullable();

    t.timestamp('used_at', { useTz: true }).nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['user_id', 'used_at'], 'mfa_backup_codes_user_active_idx');
    t.unique(['code_hash']);
  });

  await knex.raw(`ALTER TABLE mfa_backup_codes ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE mfa_backup_codes FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY mfa_backup_codes_tenant_isolation ON mfa_backup_codes
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_backup_codes TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE mfa_backup_codes_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mfa_backup_codes');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('mfa_secret');
    t.dropColumn('mfa_enabled_at');
  });
}
