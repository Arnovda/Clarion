/**
 * Legal acceptance (P0-7) — the engineering half of "the contract exists".
 *
 * The flag and the versions come from shared/legalVersions.ts (lint-locked
 * with the frontend's copy). While LEGAL_IN_FORCE is false every function
 * here is a no-op that reports "nothing required": registration asks for
 * nothing, the gate never shows, nothing is written. When it flips:
 *
 *   - POST /auth/register refuses without `acceptTerms: true` (400
 *     `terms_required`) and records the acceptance in the same transaction
 *     as the user row — a workspace cannot exist without one.
 *   - GET /api/legal/status tells a signed-in user whether the CURRENT
 *     versions have been accepted by them; the shell shows a blocking
 *     dialog until POST /api/legal/accept records it.
 *
 * Acceptance is per user and per version: a bump to any of the three
 * versions re-asks everyone. Tests inject the flag/versions through
 * `_setLegalForTests` — the constants themselves stay false until counsel.
 */
import type { Knex } from 'knex';
import type { Request } from 'express';
import { LEGAL_IN_FORCE, CURRENT_LEGAL_VERSIONS, type LegalVersions } from '../shared/legalVersions';

let override: { inForce: boolean; versions: LegalVersions } | null = null;

/** Test hook only. */
export function _setLegalForTests(value: { inForce: boolean; versions?: LegalVersions } | null): void {
  override = value ? { inForce: value.inForce, versions: value.versions ?? CURRENT_LEGAL_VERSIONS } : null;
}

export function legalInForce(): boolean {
  return override ? override.inForce : LEGAL_IN_FORCE;
}

export function currentLegalVersions(): LegalVersions {
  return override ? override.versions : CURRENT_LEGAL_VERSIONS;
}

export interface LegalStatus {
  inForce: boolean;
  versions: LegalVersions;
  /** True when in force and this user has not accepted the CURRENT versions. */
  acceptanceRequired: boolean;
  /** The versions on the user's latest acceptance row, if any. */
  accepted: LegalVersions | null;
  acceptedAt: string | null;
}

export async function legalStatusForUser(db: Knex | Knex.Transaction, tenantId: number, userId: number): Promise<LegalStatus> {
  const versions = currentLegalVersions();
  const inForce = legalInForce();
  const latest = await db('legal_acceptances')
    .where({ tenant_id: tenantId, user_id: userId })
    .orderBy('accepted_at', 'desc')
    .orderBy('id', 'desc')
    .first();
  const accepted: LegalVersions | null = latest
    ? { terms: latest.terms_version, privacy: latest.privacy_version, dpa: latest.dpa_version }
    : null;
  const current = !!accepted
    && accepted.terms === versions.terms
    && accepted.privacy === versions.privacy
    && accepted.dpa === versions.dpa;
  return {
    inForce,
    versions,
    acceptanceRequired: inForce && !current,
    accepted,
    acceptedAt: latest ? new Date(latest.accepted_at).toISOString() : null,
  };
}

function requestOrigin(req: Request): { ip: string | null; userAgent: string | null } {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
    ?? req.socket?.remoteAddress
    ?? null;
  const ua = (req.headers['user-agent'] as string | undefined) ?? null;
  return { ip, userAgent: ua ? ua.slice(0, 500) : null };
}

/**
 * Record an acceptance of the CURRENT versions. The caller passes a handle
 * that already carries the tenant context (the register transaction, or the
 * request handle) — `tenant_id` is written explicitly as well, the house rule.
 */
export async function recordLegalAcceptance(
  db: Knex | Knex.Transaction,
  input: { tenantId: number; userId: number; source: 'register' | 'login'; req: Request },
): Promise<LegalVersions> {
  const versions = currentLegalVersions();
  const { ip, userAgent } = requestOrigin(input.req);
  await db('legal_acceptances').insert({
    tenant_id: input.tenantId,
    user_id: input.userId,
    terms_version: versions.terms,
    privacy_version: versions.privacy,
    dpa_version: versions.dpa,
    source: input.source,
    ip,
    user_agent: userAgent,
  });
  return versions;
}
