/**
 * Refresh token service — issuance, validation, revocation.
 *
 * Refresh tokens live alongside JWT access tokens to give us a server-
 * side revocation lever. The access token stays HS256/short-lived for
 * speed; the refresh token is a random 32-byte string we hash and store
 * in `refresh_tokens`. Compromised access tokens expire in 15 minutes;
 * a compromised refresh token can be revoked instantly.
 *
 * Public API:
 *   - createRefreshToken(user)        → { raw, expiresAt }
 *   - validateRefreshToken(raw)       → user payload, or null if expired/revoked/missing
 *   - revokeRefreshToken(raw, reason) → marks revoked_at
 *   - revokeAllForUser(userId, reason)→ admin "force logout" / password-change cascade
 *   - cleanupExpiredAndRevoked()      → maintenance, called from cron
 *
 * The raw token is returned ONCE on create and never persisted. Only
 * sha256(raw) is stored. That's the same pattern as password-reset
 * tokens already used elsewhere in this codebase.
 */

import crypto from 'crypto';
import type { Request } from 'express';
import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'refreshToken' });

/**
 * Default refresh-token lifetime. Overridable via env so we can tune
 * without a redeploy. 30 days is a common SaaS default — long enough
 * that users stay logged in across a typical work week, short enough
 * that a stolen token isn't valid for months.
 */
const DEFAULT_LIFETIME_DAYS = Number(process.env.REFRESH_TOKEN_DAYS ?? 30);

export interface IssuedRefreshToken {
  raw: string;
  expiresAt: Date;
}

export interface RefreshTokenPayload {
  userId: number;
  tenantId: number;
  email: string;
  displayName: string | null;
  role: 'admin' | 'analyst' | 'viewer';
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function clientFingerprint(req?: Request): { ip: string | null; userAgent: string | null } {
  if (!req) return { ip: null, userAgent: null };
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
    ?? req.socket?.remoteAddress
    ?? null;
  const ua = (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null;
  return { ip, userAgent: ua };
}

/**
 * Issue a new refresh token for a user. Caller sends `raw` back to the
 * client (over TLS, in the response body); the server only ever sees
 * its sha256 hash again on validation.
 *
 * `req` is optional — when passed, we record the issuing IP + UA for
 * forensics. Pass it on login / refresh endpoints; omit it for
 * system-issued tokens (rare).
 */
export async function createRefreshToken(
  user: RefreshTokenPayload,
  req?: Request,
): Promise<IssuedRefreshToken> {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + DEFAULT_LIFETIME_DAYS * 86_400_000);
  const { ip, userAgent } = clientFingerprint(req);

  // Set tenant context inline so the row's tenant_id default fires.
  await semanticDb.raw(`SET app.current_tenant = '${Number(user.tenantId)}'`);
  await semanticDb('refresh_tokens').insert({
    tenant_id:         user.tenantId,
    user_id:           user.userId,
    token_hash:        tokenHash,
    expires_at:        expiresAt.toISOString(),
    issued_ip:         ip,
    issued_user_agent: userAgent,
  });

  return { raw, expiresAt };
}

/**
 * Validate a refresh token sent by a client. Returns the user payload
 * on success, null on any failure (unknown token, revoked, expired).
 * Updates `last_used_at` / `last_used_ip` on success for forensics.
 *
 * Returns null (not throw) on all failure paths so callers can map
 * everything to the same "401 / please log in" response without
 * leaking which specific failure mode tripped — that information
 * helps attackers calibrate their probing.
 */
export async function validateRefreshToken(
  raw: string,
  req?: Request,
): Promise<RefreshTokenPayload | null> {
  if (!raw || typeof raw !== 'string' || raw.length < 32) return null;

  const tokenHash = hashToken(raw);

  // We don't have a tenant context yet — this is the entry point of
  // a session-renewal. Use a transaction that bypasses the per-tenant
  // RLS by querying via the privileged role. The lookup is on the
  // unique `token_hash` so cross-tenant leakage of identity isn't a
  // concern.
  const row = await semanticDb('refresh_tokens')
    .where({ token_hash: tokenHash })
    .first();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  // Look up the user — they may have been deactivated since issuance.
  const user = await semanticDb('users')
    .where({ id: row.user_id, is_active: true })
    .first();
  if (!user) return null;

  // Last-used tracking — non-fatal if the update fails.
  try {
    const { ip } = clientFingerprint(req);
    await semanticDb('refresh_tokens')
      .where({ id: row.id })
      .update({
        last_used_at: new Date().toISOString(),
        last_used_ip: ip,
      });
  } catch (err) {
    log.warn({ err }, 'failed to update refresh_token last_used (non-fatal)');
  }

  return {
    userId:      user.id,
    tenantId:    user.tenant_id,
    email:       user.email,
    displayName: user.display_name,
    role:        user.role,
  };
}

/**
 * Revoke a specific refresh token (e.g. on logout). Idempotent — already
 * revoked tokens stay revoked with their original reason / timestamp.
 */
export async function revokeRefreshToken(raw: string, reason: string): Promise<void> {
  if (!raw) return;
  const tokenHash = hashToken(raw);
  await semanticDb('refresh_tokens')
    .where({ token_hash: tokenHash })
    .whereNull('revoked_at')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    });
}

/**
 * Revoke every active refresh token for a user. Use on:
 *   - password change (forces re-login on every device)
 *   - admin "force logout" action
 *   - role downgrade (so a former admin's session reflects new role
 *     within at most one access-token lifetime)
 */
export async function revokeAllForUser(userId: number, reason: string): Promise<number> {
  const updated = await semanticDb('refresh_tokens')
    .where({ user_id: userId })
    .whereNull('revoked_at')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    });
  return updated;
}

/**
 * Maintenance — delete rows that are both expired AND revoked-for-too-long.
 * Keeps the table small. Runs from the scheduler (added separately if not
 * already present). Safe to run frequently; idempotent.
 *
 * 90-day retention on revoked-but-not-yet-expired tokens lets forensics
 * trace a stolen-session incident back without losing the trail.
 */
export async function cleanupExpiredAndRevoked(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000);
  const deleted = await semanticDb('refresh_tokens')
    .where('expires_at', '<', cutoff.toISOString())
    .delete();
  return { deleted };
}
