/**
 * Tenant middleware — sets Postgres `app.current_tenant` session variable
 * so that Row-Level Security (RLS) policies filter data automatically.
 *
 * Must be called AFTER requireAuth (needs req.user.tenantId).
 *
 * Uses `SET app.current_tenant` (session-level, not LOCAL) on the raw connection.
 * Since Knex uses a connection pool, we reset it after the response finishes via
 * the `afterResponse` pool config in knex.ts.
 *
 * This is the safety net: even if application code forgets a WHERE clause,
 * Postgres will only return rows belonging to the authenticated tenant.
 */

import { Request, Response, NextFunction } from 'express';
import { semanticDb } from '../db/knex';

export async function setTenantContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      // No tenant in JWT — shouldn't happen after requireAuth
      next();
      return;
    }

    // Set session-level variable — RLS policies check this
    // SET doesn't support parameterized queries in Postgres — Number() coercion prevents injection
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Helper to get the current tenant ID from the request.
 * Use this when inserting new rows — they need an explicit tenant_id value.
 */
export function getTenantId(req: Request): number {
  return req.user!.tenantId;
}
