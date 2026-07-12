/**
 * Tenant-context-safe wrapper for WRITES on unauthenticated routes.
 *
 * Sibling of `unauthQuery`. Use this any time you know the tenant_id
 * (typically because a prior `unauthQuery` SELECT identified the user)
 * and need to UPDATE / INSERT / DELETE on a tenant-scoped table.
 *
 * Why it exists: the `auth_lookup` RLS policy that lets unauthenticated
 * SELECTs find a user by email is `FOR SELECT` only. Writes have to
 * satisfy the `tenant_isolation` policy, which requires
 * `tenant_id = current_setting('app.current_tenant')`. Under `unauthQuery`,
 * current_tenant is the empty string → NULL after coercion → the USING
 * clause is `tenant_id = NULL` which is never TRUE → the row is filtered
 * out → the write silently affects 0 rows with no error raised. This
 * shape of bug previously broke forgot-password (token never persisted),
 * reset-password (new hash never persisted), refresh-token logout, and
 * the password-change "revoke all sessions" cascade.
 *
 * After the unauthenticated SELECT has identified the actor (e.g. found
 * the user row by email + reset token), pass `user.tenant_id` here for
 * the follow-up write. Postgres then accepts the UPDATE under
 * `tenant_isolation`.
 *
 * Mirrors the explicit `SET LOCAL` pattern already used by
 * `createRefreshToken` in `services/refreshTokenService.ts` — the
 * helper just makes it reusable + impossible to forget.
 *
 * Cost: 1 dedicated pool connection per call (same as `unauthQuery` and
 * `reqDb`). Trivial at SMB scale.
 */

import type { Knex } from 'knex';
import { semanticDb } from './knex';
import { setTenantContext } from './tenantContext';

export async function tenantScopedWrite<T>(
  tenantId: number,
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  // setTenantContext validates (finite positive integer, throws otherwise)
  // and runs the parameterised set_config equivalent of SET LOCAL.
  return semanticDb.transaction(async (trx) => {
    await setTenantContext(trx, tenantId);
    return fn(trx);
  });
}
