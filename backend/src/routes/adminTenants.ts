/**
 * Operator console — tenant administration (P1-5).
 *
 *   GET   /api/admin/tenants                 — every tenant with health/usage
 *   GET   /api/admin/tenants/:id             — one tenant in depth (users,
 *                                              connections, recent sync runs)
 *   POST  /api/admin/tenants/:id/suspend     — tenants.status = 'suspended'
 *   POST  /api/admin/tenants/:id/resume      — tenants.status = 'active'
 *   PATCH /api/admin/tenants/:id/budget      — monthly AI token budget
 *   POST  /api/admin/tenants/:id/impersonate — 15-minute support session
 *
 * PLATFORM OPERATOR only, same gate and same 404-not-403 refusal as the
 * feature-flag console (routes/featureFlags.ts explains why operator is a
 * different word than admin). Like that console, this surface works ACROSS
 * tenants, so reads cannot ride the caller's own RLS context:
 *
 *  - `tenants` carries no RLS → read on the root pool.
 *  - everything tenant-owned (users, connections, source_sync_runs,
 *    ai_usage) is read per target tenant via `tenantQuery(targetId, …)` —
 *    an explicit SET LOCAL transaction. Under the production non-bypass
 *    role there is no way to aggregate across tenants in one query, so the
 *    list endpoint runs one scoped query per tenant; fine at SMB tenant
 *    counts and capped below.
 *
 * Suspension takes real effect within AUTH_STATUS_TTL_MS (default 30s) on
 * every request — that is P1-3's requireAuth re-validation; this console
 * is just the switch. Suspending the tenant YOU are signed into is refused:
 * the operator would lock themselves out of this very console 30s later.
 *
 * IMPERSONATION is deliberately narrow: a 15-minute access token for one
 * REAL, active user of the target tenant, hard-capped in
 * signImpersonationToken regardless of JWT_ACCESS_EXPIRES_IN, with NO
 * refresh token — the window closes itself and cannot be extended. Every
 * grant writes an audit row into the TARGET tenant's trail (actor = the
 * operator's email, with the operator-stated reason), so "who looked at
 * our workspace" is answerable where that customer's own admins look.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, signImpersonationToken } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  adminTenantParamsSchema,
  adminTenantBudgetSchema,
  adminTenantImpersonateSchema,
} from '../middleware/schemas';
import { semanticDb } from '../db/knex';
import { tenantQuery } from '../services/tenantQuery';
import { isPlatformOperator } from '../services/featureFlags';
import { recordAuditForTenant } from '../services/auditService';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'adminTenants' });

const router = Router();
router.use(requireAuth);

/** 404, not 403 — same reasoning as the feature-flag console. */
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isPlatformOperator(req.user?.email)) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }
  next();
});

/** First day of the current month, as ai_usage stores period_start. */
function currentPeriodStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

interface TenantHealth {
  users: number;
  activeUsers: number;
  connections: number;
  failedConnections: number;
  lastSyncAt: string | null;
  aiTokensThisMonth: number;
  aiCallsThisMonth: number;
}

/**
 * One SET LOCAL transaction, one round trip of scalar subqueries. Every
 * subquery ALSO filters tenant_id explicitly — RLS scopes these reads in
 * production, but the explicit predicate is the house rule (and the test
 * database's superuser role would otherwise aggregate across all tenants).
 */
async function tenantHealth(tenantId: number): Promise<TenantHealth> {
  const period = currentPeriodStart();
  return tenantQuery(tenantId, async (trx) => {
    const row = (await trx
      .select({
        users: trx('users').where({ tenant_id: tenantId }).count('*'),
        active_users: trx('users').where({ tenant_id: tenantId, is_active: true }).count('*'),
        connections: trx('connections').where({ tenant_id: tenantId }).count('*'),
        failed_connections: trx('connections')
          .where({ tenant_id: tenantId })
          .whereNotNull('last_sync_status')
          .whereNot('last_sync_status', 'success')
          .count('*'),
        last_sync_at: trx('connections').where({ tenant_id: tenantId }).max('last_synced_at'),
        ai_tokens: trx('ai_usage').where({ tenant_id: tenantId, period_start: period }).sum('total_tokens'),
        ai_calls: trx('ai_usage').where({ tenant_id: tenantId, period_start: period }).sum('call_count'),
      })
      .first()) as Record<string, unknown>;
    return {
      users: Number(row.users ?? 0),
      activeUsers: Number(row.active_users ?? 0),
      connections: Number(row.connections ?? 0),
      failedConnections: Number(row.failed_connections ?? 0),
      lastSyncAt: (row.last_sync_at as string | null) ?? null,
      aiTokensThisMonth: Number(row.ai_tokens ?? 0),
      aiCallsThisMonth: Number(row.ai_calls ?? 0),
    };
  });
}

// ───────────────────────────── the tenant list ──────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Newest first; capped so a runaway tenant count cannot turn this into
    // hundreds of transactions. Revisit with pagination when the cap is felt.
    const tenants = await semanticDb('tenants')
      .select('id', 'name', 'slug', 'status', 'monthly_token_budget', 'created_at')
      .orderBy('created_at', 'desc')
      .limit(200);

    const enriched = await Promise.all(
      tenants.map(async (t) => {
        try {
          const health = await tenantHealth(t.id);
          return { ...shapeTenant(t), ...health };
        } catch (err) {
          // One broken tenant must not blank the whole console.
          log.warn({ err, tenantId: t.id }, 'tenant health read failed');
          return { ...shapeTenant(t), healthError: true };
        }
      }),
    );

    res.json({ ok: true, data: { tenants: enriched, callerTenantId: req.user!.tenantId } });
  } catch (err) { next(err); }
});

function shapeTenant(t: Record<string, unknown>) {
  return {
    id: t.id as number,
    name: t.name as string,
    slug: t.slug as string,
    status: t.status as string,
    monthlyTokenBudget: t.monthly_token_budget == null ? null : Number(t.monthly_token_budget),
    createdAt: t.created_at as string,
  };
}

// ───────────────────────────── one tenant in depth ──────────────────────────

router.get('/:id', validate(adminTenantParamsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const tenant = await semanticDb('tenants')
      .select('id', 'name', 'slug', 'status', 'monthly_token_budget', 'created_at')
      .where({ id })
      .first();
    if (!tenant) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }

    // Explicit tenant_id on every read, same reasoning as tenantHealth.
    const detail = await tenantQuery(id, async (trx) => {
      const users = await trx('users')
        .select('id', 'email', 'display_name', 'role', 'is_active', 'created_at')
        .where({ tenant_id: id })
        .orderBy('created_at', 'asc');
      const connections = await trx('connections')
        .select('id', 'name', 'type', 'connector_type', 'last_sync_status', 'last_synced_at')
        .where({ tenant_id: id })
        .orderBy('name', 'asc');
      // Sync inspection: the most recent runs, whoever triggered them.
      const syncRuns = await trx('source_sync_runs')
        .select('id', 'connection_id', 'status', 'queued_at', 'started_at', 'completed_at')
        .where({ tenant_id: id })
        .orderBy('queued_at', 'desc')
        .limit(15);
      const usage = await trx('ai_usage')
        .select('period_start', 'total_tokens', 'call_count')
        .where({ tenant_id: id })
        .orderBy('period_start', 'desc')
        .limit(6);
      return { users, connections, syncRuns, usage };
    });

    res.json({
      ok: true,
      data: {
        tenant: shapeTenant(tenant),
        callerTenantId: req.user!.tenantId,
        ...detail,
      },
    });
  } catch (err) { next(err); }
});

// ───────────────────────────── suspend / resume ─────────────────────────────

async function setTenantStatus(
  req: Request,
  res: Response,
  next: NextFunction,
  status: 'active' | 'suspended',
): Promise<void> {
  try {
    const id = Number(req.params.id);

    if (status === 'suspended' && id === req.user!.tenantId) {
      // The operator signs into THIS console under a tenant; suspending it
      // would lock them out of the console itself within AUTH_STATUS_TTL_MS.
      res.status(400).json({ ok: false, error: 'You are signed in under this workspace — it cannot suspend itself.' });
      return;
    }

    const updated = await semanticDb('tenants').where({ id }).update({ status });
    if (updated === 0) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }

    await recordAuditForTenant(id, req, {
      action: status === 'suspended' ? 'tenant.suspend' : 'tenant.resume',
      entityType: 'tenant',
      entityId: id,
    });

    log.info({ tenantId: id, status, operator: req.user!.email }, 'tenant status changed by operator');
    res.json({ ok: true, data: { id, status } });
  } catch (err) { next(err); }
}

router.post('/:id/suspend', validate(adminTenantParamsSchema), (req, res, next) =>
  setTenantStatus(req, res, next, 'suspended'));

router.post('/:id/resume', validate(adminTenantParamsSchema), (req, res, next) =>
  setTenantStatus(req, res, next, 'active'));

// ─────────────────────────────── AI budget ──────────────────────────────────

router.patch('/:id/budget', validate(adminTenantBudgetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { monthlyTokenBudget } = req.body as { monthlyTokenBudget: number | null };

    const updated = await semanticDb('tenants')
      .where({ id })
      .update({ monthly_token_budget: monthlyTokenBudget });
    if (updated === 0) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }

    await recordAuditForTenant(id, req, {
      action: 'tenant.budget_change',
      entityType: 'tenant',
      entityId: id,
      context: { monthlyTokenBudget },
    });

    res.json({ ok: true, data: { id, monthlyTokenBudget } });
  } catch (err) { next(err); }
});

// ────────────────────────────── impersonation ───────────────────────────────

router.post('/:id/impersonate', validate(adminTenantImpersonateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { userId, reason } = req.body as { userId: number; reason: string };

    const tenant = await semanticDb('tenants').select('id', 'status', 'name').where({ id }).first();
    if (!tenant) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    if (tenant.status !== 'active') {
      // requireAuth would refuse the token within the TTL anyway (P1-3);
      // refusing here says so up front instead of minting a dead token.
      res.status(400).json({ ok: false, error: 'This workspace is suspended — resume it before impersonating.' });
      return;
    }

    // Explicit tenant_id filter, not just RLS: the house rule that an
    // authorization decision never rides the session variable alone.
    const user = await tenantQuery(id, (trx) =>
      trx('users')
        .select('id', 'email', 'display_name', 'role', 'is_active')
        .where({ id: userId, tenant_id: id })
        .first(),
    );
    if (!user) {
      res.status(404).json({ ok: false, error: 'No such user in this workspace' });
      return;
    }
    if (!user.is_active) {
      res.status(400).json({ ok: false, error: 'That user is deactivated — impersonate an active user.' });
      return;
    }

    const token = signImpersonationToken({
      sub: user.id,
      tenantId: id,
      email: user.email,
      displayName: user.display_name ?? user.email,
      role: user.role,
      impersonatedBy: req.user!.email,
    });

    // The audit row is the control: into the TARGET tenant's trail, naming
    // the operator and their stated reason. Written BEFORE the token is
    // returned so a failed audit path is at least visible in logs next to
    // the grant.
    await recordAuditForTenant(id, req, {
      action: 'tenant.impersonate',
      entityType: 'user',
      entityId: user.id,
      context: { reason, impersonatedUserEmail: user.email, expiresInMinutes: 15 },
    });

    log.info(
      { tenantId: id, userId: user.id, operator: req.user!.email },
      'operator impersonation token issued',
    );

    res.json({
      ok: true,
      data: {
        token,
        expiresInMinutes: 15,
        user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
        tenant: { id, name: tenant.name },
      },
    });
  } catch (err) { next(err); }
});

export default router;
