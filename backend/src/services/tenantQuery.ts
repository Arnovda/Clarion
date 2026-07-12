/**
 * Tenant-aware query helper — wraps a Knex query in a short transaction
 * with SET LOCAL app.current_tenant so RLS policies see the correct tenant.
 *
 * Without this, Knex's connection pool can route SET and subsequent queries
 * to different connections, and RLS silently filters out all rows.
 */
import { semanticDb } from '../db/knex';
import { setTenantContext } from '../db/tenantContext';

export async function tenantQuery<T>(
  tenantId: number | undefined,
  fn: (trx: import('knex').Knex) => Promise<T>,
): Promise<T> {
  return semanticDb.transaction(async (trx) => {
    // Preserve this helper's original semantics: falsy tenantId → no
    // tenant context is set (RLS then filters everything out).
    if (tenantId) await setTenantContext(trx, tenantId);
    return fn(trx);
  });
}
