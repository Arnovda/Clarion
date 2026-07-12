/**
 * The ONE place that sets the per-transaction tenant context for RLS.
 *
 * `SELECT set_config('app.current_tenant', ?, true)` with is_local = true is
 * exactly equivalent to `SET LOCAL app.current_tenant = '<id>'` — the setting
 * lives only for the current transaction — but, unlike SET, set_config accepts
 * a bound parameter, so no value is ever interpolated into SQL text.
 *
 * Callers previously each carried their own inline
 * `trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`)` copy.
 * The validation below matches the strictest of them (tenantScopedWrite):
 * a non-finite / non-positive / non-integer tenant id throws instead of
 * silently setting a garbage value like 'NaN'.
 */

import type { Knex } from 'knex';

export async function setTenantContext(
  trx: Knex.Transaction,
  tenantId: number,
): Promise<void> {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0 || !Number.isInteger(tid)) {
    throw new Error(`setTenantContext: invalid tenantId ${tenantId}`);
  }
  await trx.raw(`SELECT set_config('app.current_tenant', ?, true)`, [String(tid)]);
}
