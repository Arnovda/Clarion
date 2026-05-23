/**
 * Tenant-context-safe wrapper for queries on UNAUTHENTICATED routes.
 *
 * Why it exists: the platform's Postgres connections pool persistent
 * sessions, and `requireAuth` sets `app.current_tenant` at the session
 * level for the duration of an authenticated request. When that
 * connection is returned to the pool, the SET sticks around. A
 * subsequent UNAUTHENTICATED request that happens to grab the same
 * connection inherits the previous tenant's context — and then RLS
 * filters its queries to that wrong tenant. For the `auth_lookup`
 * policy on `users` / `refresh_tokens` / `webauthn_credentials` /
 * `mfa_backup_codes` / `oauth_pending` (which only permits SELECT when
 * `app.current_tenant` is empty), this means the unauthenticated query
 * returns ZERO rows. The user sees "Invalid email or password" even
 * when their password is right.
 *
 * This bug surfaced as failed logins-after-active-traffic in May 2026;
 * it's an explicit "HIGH (theoretical, low-prob in practice)" finding
 * in the security audit from 2026-05-14. Until the workers refactor
 * removes the session-level SET pattern entirely, every unauthenticated
 * route MUST use `unauthQuery` for SELECTs that rely on the
 * `auth_lookup` carve-out — login, register's pre-existing-email check,
 * the lookup half of forgot/reset-password, WebAuthn login verify,
 * refresh-token validation.
 *
 * ⚠ SELECT ONLY. The `auth_lookup` RLS policy is FOR SELECT — writes
 * under empty tenant context fall through to `tenant_isolation`, whose
 * USING clause is `tenant_id = NULL` (never TRUE), so the write
 * silently affects 0 rows with no error. Use `tenantScopedWrite`
 * (sibling file) for the subsequent UPDATE/INSERT/DELETE once the
 * SELECT has identified the user and you have their `tenant_id`.
 *
 * The implementation is the mirror of `reqDb` for authenticated routes:
 *   • Opens a short Knex transaction that holds one pool connection
 *   • Issues `SET LOCAL app.current_tenant = ''` so RLS sees NULL and
 *     the auth_lookup policy applies
 *   • Runs the caller's callback with the trx
 *   • Commits on success / rolls back on throw
 *   • Tenant context is scoped to the transaction — the next query on
 *     this connection sees a clean state
 *
 * Cost: 1 dedicated pool connection per unauthenticated call (same as
 * `reqDb` for authenticated calls). Trivial at SMB scale.
 */

import type { Knex } from 'knex';
import { semanticDb } from './knex';

/**
 * Run a callback inside a Knex transaction with `app.current_tenant`
 * explicitly reset to empty (NULL after the NULLIF coercion). Returns
 * whatever the callback returns. Throws if the callback throws (and
 * rolls back the implicit transaction).
 *
 * Use this when the route has NO authenticated user yet but needs to
 * read or write a table whose RLS policy depends on the absence of
 * tenant context (`auth_lookup ... USING (current_setting IS NULL)`).
 *
 * After authentication completes and the request continues, callers
 * should switch back to `reqDb(req)` — which carries the real tenant
 * context.
 */
export async function unauthQuery<T>(
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return semanticDb.transaction(async (trx) => {
    // SET LOCAL is scoped to this transaction only; the underlying
    // pool connection returns to a clean state when the trx commits.
    // The empty string is what every other tenant-set site uses; the
    // NULLIF in the RLS policies turns it into a real NULL.
    await trx.raw(`SET LOCAL app.current_tenant = ''`);
    return fn(trx);
  });
}
