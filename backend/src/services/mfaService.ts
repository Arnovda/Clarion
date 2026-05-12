/**
 * MFA (TOTP) service.
 *
 * Three-step enrolment ceremony:
 *   1. POST /auth/mfa/setup    — generate a fresh secret + QR-code data
 *                                URL. Secret stored on user row but
 *                                mfa_enabled_at stays NULL.
 *   2. user scans QR with their authenticator.
 *   3. POST /auth/mfa/enable   — user submits the first TOTP code. On
 *                                success: set mfa_enabled_at = now,
 *                                generate 10 single-use backup codes.
 *
 * On login (separate flow in routes/auth.ts):
 *   - Password verified
 *   - If users.mfa_enabled_at is set, return { mfa_required: true,
 *     mfa_token: <short-lived signed token> }
 *   - Frontend prompts for TOTP
 *   - POST /auth/mfa/verify with the mfa_token + code → real access +
 *     refresh tokens issued
 *
 * Backup codes:
 *   - 10 codes generated at enable time, shown ONCE in clear text
 *   - sha256-hashed in mfa_backup_codes
 *   - used_at flips when consumed; never reusable
 *   - User can regenerate (invalidates old set)
 */

import crypto from 'crypto';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import { semanticDb } from '../db/knex';
import { encryptCredentials, decryptCredentials } from '../utils/crypto';

// Configure otplib — 6-digit codes, 30s window, 1-step tolerance for
// clock skew (so ±30s either side of "now" works). Standard for TOTP.
authenticator.options = {
  digits: 6,
  step: 30,
  window: 1,
};

const ISSUER = 'Clarion';

export interface MfaEnrolmentResponse {
  /** Base32 secret — shown for manual key entry on devices without a camera. */
  secret: string;
  /** Data URL (image/png base64) for the QR code. Renderable as <img src> directly. */
  qrCodeDataUrl: string;
  /** otpauth:// URI the QR encodes — useful for custom UIs. */
  otpauthUri: string;
}

export interface MfaEnableResponse {
  backupCodes: string[];
}

function hashCode(code: string): string {
  // Backup codes are stored hashed. Normalise to upper case + strip
  // dashes so users can type them in any common format.
  const normalised = code.replace(/[-\s]/g, '').toUpperCase();
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

function generateBackupCode(): string {
  // 10 random uppercase alphanumeric characters in two 5-char groups
  // separated by a dash. Easy to read aloud / type, 32^10 ≈ 10^15
  // possibilities — brute-forcing one is infeasible.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // excludes I, O, 0, 1 (ambiguous)
  let s = '';
  for (let i = 0; i < 10; i++) {
    s += alphabet[crypto.randomInt(0, alphabet.length)];
    if (i === 4) s += '-';
  }
  return s;
}

/**
 * Step 1 — generate a fresh secret + QR code. Idempotent: calling
 * again overwrites any unfinished enrolment, but refuses if MFA is
 * already enabled (use disable() first to re-enrol).
 */
export async function setupMfa(userId: number, email: string): Promise<MfaEnrolmentResponse> {
  const user = await semanticDb('users').where({ id: userId, is_active: true }).first();
  if (!user) throw new Error('user not found');
  if (user.mfa_enabled_at) {
    throw new Error('MFA already enabled. Disable it first before re-enrolling.');
  }

  const secret = authenticator.generateSecret();   // base32
  const otpauthUri = authenticator.keyuri(email, ISSUER, secret);
  const qrCodeDataUrl = await qrcode.toDataURL(otpauthUri);

  await semanticDb('users')
    .where({ id: userId })
    .update({ mfa_secret: encryptCredentials(secret) });

  return { secret, qrCodeDataUrl, otpauthUri };
}

/**
 * Step 2 — user confirms enrolment by submitting their first valid
 * TOTP code. Activates MFA and issues 10 backup codes.
 *
 * Throws on invalid code OR if setupMfa wasn't called first.
 */
export async function enableMfa(userId: number, code: string): Promise<MfaEnableResponse> {
  const user = await semanticDb('users').where({ id: userId }).first();
  if (!user || !user.mfa_secret) {
    throw new Error('Run setupMfa first.');
  }
  const secret = decryptCredentials(user.mfa_secret);
  const ok = authenticator.check(code.trim(), secret);
  if (!ok) {
    throw new Error('Invalid TOTP code.');
  }

  // Generate 10 backup codes, return raw to caller, store hashed.
  const backupCodes = Array.from({ length: 10 }, generateBackupCode);

  await semanticDb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_tenant = '${Number(user.tenant_id)}'`);
    await trx('users')
      .where({ id: userId })
      .update({ mfa_enabled_at: new Date().toISOString() });

    // Wipe any prior backup codes (re-enrol path).
    await trx('mfa_backup_codes').where({ user_id: userId }).delete();
    await trx('mfa_backup_codes').insert(
      backupCodes.map((raw) => ({
        tenant_id: user.tenant_id,
        user_id:   userId,
        code_hash: hashCode(raw),
      })),
    );
  });

  return { backupCodes };
}

/**
 * Step 3 (used by login flow) — verify a TOTP code OR a backup code
 * against an enrolled user. Returns true on success. Backup codes are
 * marked used_at on a successful match so they cannot be replayed.
 */
export async function verifyMfaCode(userId: number, code: string): Promise<boolean> {
  const user = await semanticDb('users').where({ id: userId }).first();
  if (!user || !user.mfa_secret || !user.mfa_enabled_at) return false;

  const trimmed = code.trim();

  // First try as TOTP. otplib's check() validates with the ±1-step
  // window configured at module init.
  try {
    const secret = decryptCredentials(user.mfa_secret);
    if (authenticator.check(trimmed, secret)) return true;
  } catch {
    // decrypt failure → treat as no match. Don't leak which path failed.
  }

  // Fall back to backup-code lookup. Hash + match + flip used_at in
  // one transaction so a code can't be used twice in a race.
  const hash = hashCode(trimmed);
  let consumed = false;
  await semanticDb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_tenant = '${Number(user.tenant_id)}'`);
    const row = await trx('mfa_backup_codes')
      .where({ user_id: userId, code_hash: hash })
      .whereNull('used_at')
      .first();
    if (row) {
      await trx('mfa_backup_codes')
        .where({ id: row.id })
        .update({ used_at: new Date().toISOString() });
      consumed = true;
    }
  });
  return consumed;
}

/**
 * Disable MFA for a user. Caller MUST verify the user's password or
 * a current MFA code BEFORE calling — this service does not re-auth.
 * Wipes secret, mfa_enabled_at, and all backup codes.
 */
export async function disableMfa(userId: number): Promise<void> {
  const user = await semanticDb('users').where({ id: userId }).first();
  if (!user) return;
  await semanticDb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_tenant = '${Number(user.tenant_id)}'`);
    await trx('users')
      .where({ id: userId })
      .update({ mfa_secret: null, mfa_enabled_at: null });
    await trx('mfa_backup_codes').where({ user_id: userId }).delete();
  });
}

/**
 * Generate a fresh set of backup codes, invalidating the old ones.
 * Caller MUST verify the user before calling.
 */
export async function regenerateBackupCodes(userId: number): Promise<string[]> {
  const user = await semanticDb('users').where({ id: userId }).first();
  if (!user || !user.mfa_enabled_at) {
    throw new Error('MFA not enabled.');
  }
  const codes = Array.from({ length: 10 }, generateBackupCode);
  await semanticDb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_tenant = '${Number(user.tenant_id)}'`);
    await trx('mfa_backup_codes').where({ user_id: userId }).delete();
    await trx('mfa_backup_codes').insert(
      codes.map((raw) => ({
        tenant_id: user.tenant_id,
        user_id:   userId,
        code_hash: hashCode(raw),
      })),
    );
  });
  return codes;
}

/** True when the user has finished MFA enrolment (mfa_enabled_at set). */
export async function isMfaEnabled(userId: number): Promise<boolean> {
  const u = await semanticDb('users').where({ id: userId }).select('mfa_enabled_at').first();
  return !!u?.mfa_enabled_at;
}
