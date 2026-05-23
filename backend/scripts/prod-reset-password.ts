/**
 * One-off password reset for production, executed by an operator with
 * direct Postgres admin access. Use this when the in-app password
 * reset (email-based) is unavailable — for example, when SMTP isn't
 * configured on the deployment and the user is locked out.
 *
 * Inputs (all env vars — never use CLI args so the password doesn't
 * land in shell history):
 *
 *   DATABASE_URL      — Postgres admin connection string (the same
 *                       url the migrations + other prod-* scripts
 *                       use; needs UPDATE on the `users` table).
 *   EMAIL             — the user's email (must match users.email).
 *   NEW_PASSWORD      — the new plaintext password to set. Will be
 *                       bcrypt-hashed at SALT_ROUNDS=12 (matches the
 *                       app's hashPassword() in middleware/auth.ts so
 *                       login verifies identically).
 *   CONFIRM=YES       — explicit confirmation that the operator
 *                       intends to overwrite a production password.
 *                       Refuses to run without this.
 *
 * Side effects:
 *   - users.password_hash         ← bcrypt(NEW_PASSWORD, 12)
 *   - users.password_reset_token  ← NULL
 *   - users.password_reset_expires ← NULL
 *   - users.updated_at            ← now()
 *   - refresh_tokens.revoked_at   ← now() for every active session
 *                                   so any stale browser tab can't
 *                                   keep using an old session.
 *
 * After running, tell the user to log in with NEW_PASSWORD and
 * immediately change it via /profile so the operator doesn't keep
 * knowing it.
 *
 * Example:
 *
 *   cd backend
 *   DATABASE_URL='postgresql://...' \
 *   EMAIL='someone@example.com' \
 *   NEW_PASSWORD='<picked-strong-temp>' \
 *   CONFIRM=YES \
 *     npx tsx scripts/prod-reset-password.ts
 */

import { Client } from 'pg';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12; // mirrors middleware/auth.ts — do not change

async function main(): Promise<void> {
  const url     = process.env.DATABASE_URL;
  const email   = process.env.EMAIL;
  const password = process.env.NEW_PASSWORD;
  const confirm = process.env.CONFIRM;

  if (!url)      throw new Error('DATABASE_URL not set');
  if (!email)    throw new Error('EMAIL not set');
  if (!password) throw new Error('NEW_PASSWORD not set');
  if (password.length < 8) throw new Error('NEW_PASSWORD must be at least 8 chars');
  if (confirm !== 'YES')   throw new Error('Refusing to run without CONFIRM=YES — this overwrites a production password.');

  const log = (s: string) => process.stdout.write(s + '\n');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // 1. Locate the user. We don't filter on is_active here — operators
    //    sometimes need to recover a deactivated account. Surface the
    //    flag in the output so they see it.
    const found = await client.query<{ id: number; email: string; name: string | null; tenant_id: number; is_active: boolean }>(
      `SELECT id, email, name, tenant_id, is_active FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    if (found.rows.length === 0) {
      throw new Error(`No user with email "${email}" — nothing to reset.`);
    }
    if (found.rows.length > 1) {
      throw new Error(`Multiple users with email "${email}" — refusing to reset. Investigate manually.`);
    }
    const user = found.rows[0];
    log(`Found user #${user.id} (${user.email}, name="${user.name ?? ''}", tenant=${user.tenant_id}, is_active=${user.is_active})`);

    // 2. Hash + write.
    log('Hashing new password (bcrypt, SALT_ROUNDS=12)…');
    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    const upd = await client.query(
      `UPDATE users
         SET password_hash = $1,
             password_reset_token = NULL,
             password_reset_expires = NULL,
             updated_at = now()
       WHERE id = $2`,
      [hash, user.id],
    );
    log(`users updated (rowCount=${upd.rowCount}).`);

    // 3. Revoke any active refresh tokens so a stale browser tab can't
    //    keep using an old session under the previous password. The
    //    refresh_tokens table was added in migration 20260512000058 —
    //    guard the call in case this script is ever run on an older
    //    DB snapshot.
    try {
      const rev = await client.query(
        `UPDATE refresh_tokens
           SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      log(`refresh_tokens revoked (rowCount=${rev.rowCount}).`);
    } catch (err) {
      // Best-effort — if the table doesn't exist, login still works,
      // and any old refresh token's bearer can be rejected on use.
      log(`refresh_tokens revocation skipped (${err instanceof Error ? err.message : 'unknown'}).`);
    }

    log('');
    log(`Done. ${user.email} can now sign in with the new password.`);
    log('Tell them to change it via /profile immediately so the operator does not keep knowing it.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
