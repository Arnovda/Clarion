/**
 * WebAuthn / passkey service.
 *
 * Phishing-resistant second factor that sits alongside TOTP. A user
 * can have BOTH enrolled: the login flow surfaces whichever they pick.
 *
 * Flow (registration):
 *   1. Authenticated user calls POST /auth/webauthn/register-options.
 *      We return a PublicKeyCredentialCreationOptionsJSON for the
 *      browser's navigator.credentials.create(), plus a short-lived
 *      signed challenge token (JWT) that captures the random challenge
 *      bytes so the browser doesn't need to round-trip a session id.
 *   2. Browser prompts the user for an authenticator (YubiKey, Touch ID,
 *      Windows Hello, etc.) and returns an attestation response.
 *   3. User submits the response + challenge token + a nickname to
 *      POST /auth/webauthn/register-verify. We verify against the
 *      challenge token, then persist a webauthn_credentials row.
 *
 * Flow (login):
 *   1. User POSTs email + password to /auth/login.
 *   2. If they have ANY webauthn_credentials rows OR mfa_enabled_at,
 *      we return a challenge response instead of access+refresh
 *      tokens. WebAuthn-enabled accounts get `webauthnOptions` for
 *      navigator.credentials.get() AND `mfaChallengeToken`; TOTP-only
 *      accounts get just the mfa challenge.
 *   3. Browser presents whichever the user prefers. On WebAuthn
 *      success, frontend POSTs to /auth/webauthn/login-verify with
 *      the assertion + challenge token. On TOTP success, frontend
 *      POSTs to /auth/mfa/verify with the code + challenge token.
 *
 * Challenge storage: we don't persist challenges in the DB. They're
 * embedded in a short-lived (5 min) signed token using the same
 * JWT_SECRET. Verifying the response decodes the token to get the
 * expected challenge bytes back. Simpler than a challenges table, no
 * cleanup needed.
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';

// ─── Configuration ────────────────────────────────────────────────────────

const RP_NAME = 'Clarion';

/**
 * Relying Party ID — must match the page's effective domain.
 *   - In production, derived from FRONTEND_BASE_URL (the same env var
 *     /security and password-reset emails use).
 *   - Locally, defaults to `localhost`.
 *
 * If the configured RP ID doesn't match the page origin, the browser
 * silently refuses to use the credential — the WebAuthn spec is
 * deliberately strict on this point. That's the point.
 */
function getRpId(): string {
  const base = process.env.FRONTEND_BASE_URL?.replace(/\/$/, '')
    ?? process.env.PUBLIC_APP_URL?.replace(/\/$/, '')
    ?? 'http://localhost:3000';
  try {
    return new URL(base).hostname;
  } catch {
    return 'localhost';
  }
}

/**
 * Expected origin(s) the credential will be used from. The browser
 * compares the origin in its response against this list and refuses
 * if there's no match. We accept the configured frontend base plus,
 * in dev, both the bare hostname and the localhost variant.
 */
function getExpectedOrigins(): string[] {
  const base = process.env.FRONTEND_BASE_URL?.replace(/\/$/, '')
    ?? process.env.PUBLIC_APP_URL?.replace(/\/$/, '');
  if (base) return [base];
  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

// ─── Challenge tokens ────────────────────────────────────────────────────

interface WebauthnChallengePayload {
  purpose: 'webauthn_register' | 'webauthn_login';
  /** The base64url challenge we asked the authenticator to sign. */
  challenge: string;
  /** For registration: the user the challenge was issued for. */
  sub?: number;
  /** For login: the user the challenge was issued for. */
  loginSub?: number;
  /** Issued-at + expiry are auto-managed by jsonwebtoken. */
}

function getChallengeSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return s;
}

function signChallenge(payload: WebauthnChallengePayload): string {
  return jwt.sign(payload, getChallengeSecret(), { expiresIn: '5m' });
}

function verifyChallenge(token: string, purpose: WebauthnChallengePayload['purpose']): WebauthnChallengePayload {
  const decoded = jwt.verify(token, getChallengeSecret()) as unknown as WebauthnChallengePayload;
  if (decoded?.purpose !== purpose) throw new Error('Invalid challenge purpose');
  return decoded;
}

// ─── Registration ─────────────────────────────────────────────────────────

export interface WebauthnRegisterOptions {
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeToken: string;
}

export async function buildRegistrationOptions(
  userId: number,
  email: string,
  displayName: string,
): Promise<WebauthnRegisterOptions> {
  // Pull existing credentials so the browser can refuse to enrol the
  // same authenticator twice. We don't filter by tenant — these all
  // belong to the calling user.
  const existing = await semanticDb('webauthn_credentials')
    .where({ user_id: userId })
    .select<{ credential_id: string; transports: string | null }[]>('credential_id', 'transports');

  const userIdBytes = new TextEncoder().encode(String(userId));

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: getRpId(),
    userName: email,
    userID: userIdBytes,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: {
      // residentKey: 'preferred' lets the credential become a discoverable
      // passkey (synced via the OS/browser provider) when the authenticator
      // supports it. 'preferred' means: use it if you can, don't fail if
      // you can't. Result: hardware-only YubiKeys still work, but
      // Touch ID / Windows Hello / 1Password create real passkeys.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeToken = signChallenge({
    purpose: 'webauthn_register',
    challenge: options.challenge,
    sub: userId,
  });

  return { options, challengeToken };
}

export interface VerifiedRegistration {
  credentialId: string;
}

export async function verifyAndStoreRegistration(
  userId: number,
  tenantId: number,
  response: RegistrationResponseJSON,
  challengeToken: string,
  nickname: string,
  db: Knex | Knex.Transaction = semanticDb,
): Promise<VerifiedRegistration> {
  const decoded = verifyChallenge(challengeToken, 'webauthn_register');
  if (decoded.sub !== userId) {
    throw new Error('Challenge does not match the calling user');
  }

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: decoded.challenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Registration verification failed');
  }

  const reg = verification.registrationInfo;
  const credentialIdB64 = reg.credential.id;
  const publicKeyB64 = bufferToBase64url(reg.credential.publicKey);
  const counter = reg.credential.counter;
  const aaguid = reg.aaguid && reg.aaguid !== '00000000-0000-0000-0000-000000000000'
    ? reg.aaguid
    : null;
  const transports = response.response.transports ?? [];

  await db('webauthn_credentials').insert({
    tenant_id: tenantId,
    user_id: userId,
    credential_id: credentialIdB64,
    public_key: publicKeyB64,
    counter,
    transports: JSON.stringify(transports),
    aaguid,
    device_type: reg.credentialDeviceType ?? null,
    backed_up: reg.credentialBackedUp ?? false,
    nickname: nickname.trim() || 'Security key',
  });

  return { credentialId: credentialIdB64 };
}

// ─── Authentication (login) ───────────────────────────────────────────────

export interface WebauthnLoginOptions {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeToken: string;
}

/**
 * Build the navigator.credentials.get() options for a user. Caller
 * passes the user id we just verified the password for.
 */
export async function buildAuthenticationOptions(userId: number): Promise<WebauthnLoginOptions | null> {
  const existing = await semanticDb('webauthn_credentials')
    .where({ user_id: userId })
    .select<{ credential_id: string; transports: string | null }[]>('credential_id', 'transports');
  if (existing.length === 0) return null;

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: 'preferred',
    allowCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
  });

  const challengeToken = signChallenge({
    purpose: 'webauthn_login',
    challenge: options.challenge,
    loginSub: userId,
  });

  return { options, challengeToken };
}

/**
 * Verify a WebAuthn assertion. On success, bumps counter + last_used_at
 * and returns the user id the assertion authenticated.
 *
 * Throws on any failure (invalid signature, replay, unknown credential,
 * counter regression). Caller should map throw → 401.
 */
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  challengeToken: string,
): Promise<{ userId: number }> {
  const decoded = verifyChallenge(challengeToken, 'webauthn_login');
  if (typeof decoded.loginSub !== 'number') {
    throw new Error('Invalid challenge token');
  }
  const userId = decoded.loginSub;

  // Look up the credential. We need the user's tenant for the SET LOCAL
  // (the row is RLS-scoped). Find the user first to get tenant.
  const user = await semanticDb('users').where({ id: userId, is_active: true }).first();
  if (!user) throw new Error('User not found');

  // Use raw with SET to scope the lookup; tenantQuery would also work
  // but we need to mutate the row afterwards, so an explicit trx makes
  // the read+update atomic.
  let creds: { id: number; credential_id: string; public_key: string; counter: string | number; transports: string | null } | undefined;
  await semanticDb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_tenant = '${Number(user.tenant_id)}'`);
    creds = await trx('webauthn_credentials')
      .where({ user_id: userId, credential_id: response.id })
      .first();
  });
  if (!creds) throw new Error('Unknown credential');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: decoded.challenge,
    expectedOrigin: getExpectedOrigins(),
    expectedRPID: getRpId(),
    credential: {
      id: creds.credential_id,
      // Cast — TS-DOM's Uint8Array<ArrayBuffer> vs the polyfilled
      // Uint8Array<ArrayBufferLike> differ only in shared-vs-not, and
      // Buffer-backed bytes are always non-shared in practice.
      publicKey: base64urlToBuffer(creds.public_key) as unknown as Uint8Array<ArrayBuffer>,
      counter: Number(creds.counter),
      transports: parseTransports(creds.transports),
    },
  });

  if (!verification.verified) {
    throw new Error('Assertion failed verification');
  }

  // Bump counter + last_used_at. Done under SET LOCAL so the
  // RLS policy still matches.
  await semanticDb.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_tenant = '${Number(user.tenant_id)}'`);
    await trx('webauthn_credentials')
      .where({ id: creds!.id })
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      });
  });

  return { userId };
}

// ─── Credential management ────────────────────────────────────────────────

export interface CredentialRow {
  id: number;
  nickname: string;
  created_at: string;
  last_used_at: string | null;
  device_type: string | null;
  backed_up: boolean;
}

export async function listUserCredentials(
  userId: number,
  db: Knex | Knex.Transaction = semanticDb,
): Promise<CredentialRow[]> {
  const rows = await db('webauthn_credentials')
    .where({ user_id: userId })
    .orderBy('created_at', 'asc')
    .select<CredentialRow[]>('id', 'nickname', 'created_at', 'last_used_at', 'device_type', 'backed_up');
  return rows;
}

export async function deleteCredential(
  userId: number,
  credentialRowId: number,
  db: Knex | Knex.Transaction = semanticDb,
): Promise<boolean> {
  const count = await db('webauthn_credentials')
    .where({ id: credentialRowId, user_id: userId })
    .delete();
  return count > 0;
}

export async function userHasWebauthn(userId: number): Promise<boolean> {
  const row = await semanticDb('webauthn_credentials')
    .where({ user_id: userId })
    .count<{ count: string | number }[]>('id as count')
    .first();
  return Number(row?.count ?? 0) > 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) {
      return parsed as AuthenticatorTransportFuture[];
    }
  } catch { /* fall through */ }
  return undefined;
}

function bufferToBase64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function base64urlToBuffer(b64url: string): Uint8Array {
  const buf = Buffer.from(b64url, 'base64url');
  // Wrap in a fresh ArrayBuffer so the type aligns with WebAuthn's
  // expected Uint8Array<ArrayBuffer> (not <ArrayBufferLike>).
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
