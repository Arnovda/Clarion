/**
 * Tenant-aware query helper — wraps a Knex query in a short transaction
 * with SET LOCAL app.current_tenant so RLS policies see the correct tenant.
 *
 * Without this, Knex's connection pool can route SET and subsequent queries
 * to different connections, and RLS silently filters out all rows.
 */
import { semanticDb } from '../db/knex';

export async function tenantQuery<T>(
  tenantId: number | undefined,
  fn: (trx: import('knex').Knex) => Promise<T>,
): Promise<T> {
  return semanticDb.transaction(async (trx) => {
    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
    return fn(trx);
  });
}
