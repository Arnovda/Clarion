/**
 * Tenant-aware query helper — wraps a Knex query in a short transaction
 * with SET LOCAL app.current_tenant so RLS policies see the correct tenant.
 *
 * Without this, Knex's connection pool can route SET and subsequent queries
 * to different connections, and RLS silently filters out all rows.
 */
import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { setTenantContext } from '../db/tenantContext';

export async function tenantQuery<T>(
  tenantId: number | undefined,
  fn: (trx: Knex) => Promise<T>,
): Promise<T> {
  return tenantQueryOn(semanticDb, tenantId, fn);
}

/** `tenantQuery` on an explicit Knex instance (tests open one as the app role). */
export async function tenantQueryOn<T>(
  db: Knex,
  tenantId: number | undefined,
  fn: (trx: Knex) => Promise<T>,
): Promise<T> {
  return db.transaction(async (trx) => {
    // Preserve this helper's original semantics: falsy tenantId → no
    // tenant context is set (RLS then filters everything out).
    if (tenantId) await setTenantContext(trx, tenantId);
    return fn(trx);
  });
}

/**
 * Every active tenant's id, read WITHOUT tenant context — `tenants` is the
 * one table that deliberately has no RLS, which is what makes it the only
 * legitimate starting point for platform-wide work (boot-time schedule
 * loaders, the daily brief). Any read of a tenant-owned table that starts
 * from here must go through `tenantQueryOn(db, tenantId, …)` per tenant.
 */
export async function listActiveTenantIds(db: Knex = semanticDb): Promise<number[]> {
  // `tenants.status` is 'active' | 'suspended' | 'deleted'. There is NO
  // `is_active` column on tenants (that is a users column) — the daily brief
  // loop filtered on it and threw "column is_active does not exist" every
  // morning (found while closing P0-2). A suspended tenant's schedules must
  // not fire: their users cannot log in and nobody should receive their
  // report emails; `jobs/tenantSchedules.ts` re-registers them on resume.
  const rows = await db('tenants').where({ status: 'active' }).select('id');
  return rows.map((r: { id: number }) => Number(r.id));
}

/**
 * Read a tenant-owned table ACROSS every active tenant, one short
 * transaction per tenant with the tenant context set. This is how a
 * process with no request scope reads RLS-forced tables under the
 * production role — reading them on the root pool with no context returns
 * ZERO rows (P0-2 of the 2026-09-05 assessment: every boot-time schedule
 * loader did exactly that, so no scheduled work could register).
 */
export async function readAcrossTenants<T>(
  db: Knex,
  fn: (trx: Knex, tenantId: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (const tenantId of await listActiveTenantIds(db)) {
    const rows = await tenantQueryOn(db, tenantId, (trx) => fn(trx, tenantId));
    out.push(...rows);
  }
  return out;
}
