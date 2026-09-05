/**
 * Audit log service.
 *
 * Single entry point for writing to `audit_events`. Every administrative
 * mutation (user invite, role change, connection edit, product delete,
 * policy update, etc.) should call `recordAudit()` so the action is
 * captured durably with actor + context.
 *
 * The table is RLS-protected per tenant; the `tenant_id` column defaults
 * to `current_setting('app.current_tenant')` so callers don't need to
 * pass it explicitly as long as the session is set.
 *
 * Errors writing the audit row NEVER fail the underlying request — the
 * service logs and swallows. We'd rather lose an audit row than break
 * the user's action. This is a deliberate trade-off: an audit gap is
 * recoverable from application logs, a 500 on a role change is not.
 */

import type { Knex } from 'knex';
import type { Request } from 'express';
import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'audit' });

export interface AuditInput {
  /** Required. Short namespaced verb — 'user.invite', 'connection.delete'. */
  action: string;
  /** Entity type if the action targets a specific entity. */
  entityType?: string | null;
  /** Entity id (any type) if the action targets a specific row. */
  entityId?: string | number | null;
  /** Action-specific structured detail. Stored as JSONB; keep ≤4 KB. */
  context?: Record<string, unknown> | null;
}

/**
 * Record one audit event. Uses the caller's tenant context (set on the
 * session via requireAuth) so we don't need an explicit tenantId.
 * Reads actor info from `req.user`.
 *
 * When `req.dbTrx` is available, writes inside that transaction so the
 * audit row commits atomically with the action it describes. When not,
 * uses the global semanticDb — still works, just not transactional.
 */
export async function recordAudit(req: Request, input: AuditInput): Promise<void> {
  try {
    const actorUserId = req.user?.sub ?? null;
    const actorEmail = (req.user as { email?: string } | undefined)?.email ?? null;
    const actorRole = req.user?.role ?? null;

    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
      ?? req.socket?.remoteAddress
      ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    const row = {
      actor_user_id:  actorUserId,
      actor_email:    actorEmail,
      actor_role:     actorRole,
      action:         input.action,
      entity_type:    input.entityType ?? null,
      entity_id:      input.entityId != null ? String(input.entityId) : null,
      context:        input.context ? JSON.stringify(input.context) : null,
      ip,
      user_agent:     userAgent ? userAgent.slice(0, 500) : null,
    };

    const writer: Knex | Knex.Transaction = req.dbTrx ?? semanticDb;
    await writer('audit_events').insert(row);
  } catch (err) {
    // Audit failures NEVER break the user's action. Log loud so it
    // surfaces in monitoring; the underlying mutation already succeeded.
    log.warn({ err, action: input.action }, 'failed to write audit event');
  }
}

/**
 * Record an audit event INTO ANOTHER TENANT's trail, with the real actor
 * (P1-5 operator console). A platform operator suspending tenant 42 must
 * leave the row in tenant 42's audit trail — "who suspended us and when"
 * has to be answerable where the suspended customer's own admins look —
 * while `recordAudit(req, …)` would write it into the OPERATOR's tenant
 * via the session variable. Runs under an explicit SET LOCAL for the
 * target tenant (same pattern as refreshTokenService's writes) so the
 * insert satisfies RLS WITH CHECK under the non-bypass role.
 */
export async function recordAuditForTenant(
  targetTenantId: number,
  req: Request,
  input: AuditInput,
): Promise<void> {
  try {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
      ?? req.socket?.remoteAddress
      ?? null;
    await semanticDb.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.current_tenant = '${Number(targetTenantId)}'`);
      await trx('audit_events').insert({
        tenant_id:     targetTenantId,
        actor_user_id: null, // the operator's user id belongs to ANOTHER tenant — an FK-style reference here would be misleading
        actor_email:   req.user?.email ?? null,
        actor_role:    'platform_operator',
        action:        input.action,
        entity_type:   input.entityType ?? null,
        entity_id:     input.entityId != null ? String(input.entityId) : null,
        context:       input.context ? JSON.stringify(input.context) : null,
        ip,
        user_agent:    ((req.headers['user-agent'] as string | undefined) ?? null)?.slice(0, 500) ?? null,
      });
    });
  } catch (err) {
    log.warn({ err, action: input.action, targetTenantId }, 'failed to write operator audit event');
  }
}

/**
 * Record a system / cron / job-triggered audit event (no Express req).
 * Useful for scheduled tasks (refresh runs, schema drift detection,
 * background imports) that should still be auditable.
 */
export async function recordSystemAudit(
  tenantId: number,
  input: AuditInput,
  attribution: { source: string },
): Promise<void> {
  try {
    await tenantQuery(tenantId, (db) => db('audit_events').insert({
      tenant_id:     tenantId,
      actor_user_id: null,
      actor_email:   `system:${attribution.source}`,
      actor_role:    'system',
      action:        input.action,
      entity_type:   input.entityType ?? null,
      entity_id:     input.entityId != null ? String(input.entityId) : null,
      context:       input.context ? JSON.stringify(input.context) : null,
      ip:            null,
      user_agent:    null,
    }));
  } catch (err) {
    log.warn({ err, action: input.action, tenantId }, 'failed to write system audit event');
  }
}
