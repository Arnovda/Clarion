/**
 * WebAuthn / passkey credentials — phishing-resistant second factor.
 *
 * Each row is one registered authenticator (hardware key, Touch ID,
 * Windows Hello, password-manager-backed passkey). A user may have
 * multiple credentials registered; any one of them satisfies the
 * second-factor requirement at login.
 *
 * Why on top of TOTP rather than replacing it:
 *   - TOTP is the universal fallback (any 2FA app works).
 *   - WebAuthn is the phishing-resistant upgrade. Credentials are
 *     bound to the origin so a phishing site cannot use them.
 *   - Many enterprises explicitly ask for WebAuthn / passkey support
 *     when evaluating vendors. Salesforce, Slack, Google Workspace,
 *     Microsoft 365 all support it.
 *
 * Columns:
 *   credential_id — Base64URL-encoded raw bytes the browser issues for
 *                   this credential. Unique across the entire table (the
 *                   spec guarantees collision-free generation).
 *   public_key   — Base64URL-encoded COSE-formatted public key. Used to
 *                   verify the assertion at login time.
 *   counter      — Signature counter. Some authenticators increment per
 *                   use; if a counter regresses, the credential may have
 *                   been cloned. We store and compare on each
 *                   verification (per @simplewebauthn/server contract).
 *   transports   — JSON array of WebAuthn transport hints (usb / ble /
 *                   nfc / internal / hybrid). Helps the browser pick the
 *                   right authenticator at sign-in.
 *   aaguid       — Authenticator AAGUID. Identifies the model
 *                   (YubiKey 5C / Touch ID / Windows Hello / etc.).
 *                   Useful for showing nicer labels in the UI.
 *   nickname     — User-given label ("My YubiKey", "Work laptop").
 *                   Always set by the user during registration so they
 *                   can identify which credential to delete later.
 *   backed_up    — true when the credential is synced via a passkey
 *                   provider (iCloud Keychain, Google Passkey Manager).
 *                   The flag lets the UI explain "this signs you in on
 *                   every device you've signed into your provider on".
 *   device_type  — 'singleDevice' | 'multiDevice'. Mirrors the WebAuthn
 *                   credentialDeviceType flag.
 *   last_used_at — Bumped on every successful login. Lets the user see
 *                   "last used 3 days ago" and decide which credentials
 *                   to prune.
 *
 * Tenant scoping: RLS-protected like everything else. Two tenants
 * could in theory register the same credential_id (the spec generates
 * 128+ bits of entropy so collision is infeasible), but the unique
 * constraint is GLOBAL — credential_id is the join key during login
 * (we look up the user from the credential, not the other way around).
 * So we put a unique index on credential_id alone, plus a tenant_id
 * column for the RLS policy that scopes ALL reads/writes to the
 * caller's tenant.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('webauthn_credentials', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable()
      .defaultTo(knex.raw(`NULLIF(current_setting('app.current_tenant', true), '')::integer`));
    t.integer('user_id').notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    // credential_id is the WebAuthn credential identifier returned by the
    // authenticator. Base64URL-encoded so it's safe to store as text and
    // to use in URLs. Unique globally (the spec gives us 128+ bits of
    // entropy; collision is infeasible).
    t.text('credential_id').notNullable().unique();

    // public_key is the COSE-formatted public key. Stored as base64url
    // text so it's safe to round-trip through JSON and to compare cheaply.
    t.text('public_key').notNullable();

    // counter is a bigint because the spec allows values up to 2^32 and
    // some authenticators reset it across reboots. We never read it as
    // an int, only as a string-decoded number for the verifier.
    t.bigInteger('counter').notNullable().defaultTo(0);

    // Transport hints + metadata — all optional. JSON-encoded for the
    // transports array since pg arrays + knex are awkward and this list
    // is short.
    t.text('transports').nullable();
    t.uuid('aaguid').nullable();
    t.text('device_type').nullable();
    t.boolean('backed_up').notNullable().defaultTo(false);

    t.text('nickname').notNullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_used_at', { useTz: true }).nullable();

    t.index(['user_id'], 'webauthn_credentials_user_idx');
  });

  await knex.raw(`ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY`);

  const hasRole = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'databridge_app'`);
  if (hasRole.rows.length > 0) {
    await knex.raw(`
      CREATE POLICY webauthn_credentials_tenant_isolation ON webauthn_credentials
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::integer)
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_credentials TO databridge_app`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE webauthn_credentials_id_seq TO databridge_app`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webauthn_credentials');
}
