/**
 * Legal documents — in-force flag and versions (P0-7).
 *
 * ══ THIS FILE EXISTS AS TWO BYTE-IDENTICAL COPIES ═══════════════════════════
 *
 *     backend/src/shared/legalVersions.ts
 *     frontend/lib/legal/versions.ts
 *
 * Edit them TOGETHER; `backend/scripts/lint-contract-sync.ts` fails the build
 * when they differ (the frontend Docker build context cannot reach a shared
 * file, same reason as contract.ts). Unlike contract.ts this file MAY hold
 * runtime constants — that is its whole purpose: the backend must refuse a
 * registration without acceptance and the register screen must ask for it
 * from the same flag and the same versions, or the two drift apart.
 *
 * LEGAL_IN_FORCE stays FALSE until a lawyer has reviewed the four documents
 * (docs/legal/README.md is the checklist). While false:
 *   - the /legal pages carry the "draft — not yet in force" banner,
 *   - registration asks for nothing and records nothing,
 *   - no signed-in user is asked to accept anything.
 * Flipping it, after counsel, is the owner's act: set true here (both
 * copies), set the real versions/dates, remove the placeholders in the
 * documents. From then on every new workspace records an acceptance at
 * signup and every existing user accepts on their next visit — and a later
 * version bump re-asks everyone, because acceptance is recorded PER VERSION.
 */

export const LEGAL_IN_FORCE = false;

export const TERMS_VERSION = '0.1-draft';
export const TERMS_UPDATED = '2026-09-01';

export const PRIVACY_VERSION = '0.1-draft';
export const PRIVACY_UPDATED = '2026-09-01';

export const DPA_VERSION = '0.1-draft';
export const DPA_UPDATED = '2026-09-01';

export const SUBPROCESSORS_VERSION = '0.1-draft';
export const SUBPROCESSORS_UPDATED = '2026-09-01';

/** The versions a user accepts in one act — the three binding documents. */
export interface LegalVersions {
  terms: string;
  privacy: string;
  dpa: string;
}

export const CURRENT_LEGAL_VERSIONS: LegalVersions = {
  terms: TERMS_VERSION,
  privacy: PRIVACY_VERSION,
  dpa: DPA_VERSION,
};
