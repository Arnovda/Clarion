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
  adminTenantCustomerSchema,
  adminUsageCsvSchema,
  adminTenantUserPatchSchema,
  adminTenantUserResetMfaSchema,
  adminTenantInviteSchema,
} from '../middleware/schemas';
import { inviteUser } from '../services/invites';
import { checkSeatCap } from '../services/tenantLimits';
import { revokeAllForUser } from '../services/refreshTokenService';
import { disableMfa } from '../services/mfaService';
import { semanticDb } from '../db/knex';
import { tenantQuery } from '../services/tenantQuery';
import { isPlatformOperator } from '../services/featureFlags';
import { recordAuditForTenant } from '../services/auditService';
import { registerSchedulesForTenant, unregisterSchedulesForTenant } from '../jobs/tenantSchedules';
import { readTenantRequestStats } from '../services/tenantRequestStats';
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
        // 'failed' OR 'partial' (P0-6). This used to be `<> 'success'` —
        // a value the orchestrator never writes (it writes 'succeeded'), so
        // every healthy source counted as failing on the operator console.
        failed_connections: trx('connections')
          .where({ tenant_id: tenantId })
          .whereIn('last_sync_status', ['failed', 'partial'])
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
      .select('id', 'name', 'slug', 'status', 'monthly_token_budget', 'created_at', 'plan', 'seats', 'max_connections', 'trial_ends_at', 'billing_contact', 'legal_name', 'vat_number', 'address')
      .orderBy('created_at', 'desc')
      .limit(200);

    // P1-6: the last-24h per-tenant request window (error rate + latency)
    // from Redis, read ONCE for every tenant. readTenantRequestStats already
    // fails to an empty map — a Redis blip degrades these columns to
    // "no data", never blanks the console.
    const reqStats = await readTenantRequestStats();

    const enriched = await Promise.all(
      tenants.map(async (t) => {
        // null, not zero, when the window has nothing for this tenant —
        // "no traffic measured" and "0% errors over N requests" must stay
        // distinguishable on the console.
        const s = reqStats.get(t.id);
        const traffic = {
          requests24h: s?.requests ?? null,
          errors24h: s ? s.errors : null,
          avgMs24h: s?.avgMs ?? null,
          p95Ms24h: s?.p95Ms ?? null,
        };
        try {
          const health = await tenantHealth(t.id);
          return { ...shapeTenant(t), ...health, ...traffic };
        } catch (err) {
          // One broken tenant must not blank the whole console.
          log.warn({ err, tenantId: t.id }, 'tenant health read failed');
          return { ...shapeTenant(t), healthError: true, ...traffic };
        }
      }),
    );

    res.json({ ok: true, data: { tenants: enriched, callerTenantId: req.user!.tenantId } });
  } catch (err) { next(err); }
});

function shapeTenant(t: Record<string, unknown>) {
  const numOrNull = (v: unknown) => (v == null ? null : Number(v));
  const strOrNull = (v: unknown) => (v == null ? null : String(v));
  return {
    id: t.id as number,
    name: t.name as string,
    slug: t.slug as string,
    status: t.status as string,
    monthlyTokenBudget: numOrNull(t.monthly_token_budget),
    createdAt: t.created_at as string,
    // The customer record (P0-8). NULL caps = unlimited.
    plan: strOrNull(t.plan),
    seats: numOrNull(t.seats),
    maxConnections: numOrNull(t.max_connections),
    trialEndsAt: t.trial_ends_at == null ? null : new Date(t.trial_ends_at as string).toISOString(),
    billingContact: strOrNull(t.billing_contact),
    legalName: strOrNull(t.legal_name),
    vatNumber: strOrNull(t.vat_number),
    address: strOrNull(t.address),
  };
}

// ───────────────────────────── month-end usage export ───────────────────────
//
// Literal route, registered BEFORE `/:id` so "usage.csv" is never read as an
// id. One row per tenant for the month: the customer record beside what was
// consumed, so an invoice can be written from this file alone. Cost is in
// USD as ai_call_log records it — the FX decision is the owner's; the rate
// used goes on the invoice (assessment v2, P0-8).

function csvCell(v: unknown): string {
  if (v == null) return '';
  const str = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** ['YYYY-MM-01', 'YYYY-MM-01' of the next month) for a YYYY-MM string. */
function monthBounds(month: string): { start: string; end: string; label: string } {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), label: month };
}

router.get('/usage.csv', validate(adminUsageCsvSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const month = (req.query.month as string | undefined)
      ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const { start, end, label } = monthBounds(month);

    const tenants = await semanticDb('tenants')
      .select('id', 'name', 'slug', 'status', 'monthly_token_budget', 'created_at', 'plan', 'seats', 'max_connections', 'trial_ends_at', 'billing_contact', 'legal_name', 'vat_number', 'address')
      .orderBy('id', 'asc')
      .limit(1000);

    const header = [
      'month', 'tenant_id', 'workspace', 'slug', 'status', 'plan', 'legal_name', 'vat_number', 'billing_contact', 'address',
      'trial_ends_at', 'seats', 'users_active', 'users_total', 'max_connections', 'connections',
      'sync_runs', 'sync_runs_failed', 'ai_calls', 'ai_input_tokens', 'ai_output_tokens', 'ai_total_tokens', 'ai_cost_usd',
      'monthly_token_budget',
    ];
    const lines = [header.join(',')];

    for (const t of tenants) {
      // Same discipline as tenantHealth: one SET LOCAL transaction per
      // tenant, every subquery ALSO filtering tenant_id explicitly.
      const u = await tenantQuery(Number(t.id), async (trx) => {
        const row = (await trx
          .select({
            users_active: trx('users').where({ tenant_id: t.id, is_active: true }).count('*'),
            users_total: trx('users').where({ tenant_id: t.id }).count('*'),
            connections: trx('connections').where({ tenant_id: t.id }).count('*'),
            sync_runs: trx('source_sync_runs').where({ tenant_id: t.id }).where('queued_at', '>=', start).where('queued_at', '<', end).count('*'),
            sync_runs_failed: trx('source_sync_runs').where({ tenant_id: t.id }).whereIn('status', ['failed', 'partial']).where('queued_at', '>=', start).where('queued_at', '<', end).count('*'),
            ai_calls: trx('ai_call_log').where({ tenant_id: t.id }).where('created_at', '>=', start).where('created_at', '<', end).count('*'),
            ai_input_tokens: trx('ai_call_log').where({ tenant_id: t.id }).where('created_at', '>=', start).where('created_at', '<', end).sum('input_tokens'),
            ai_output_tokens: trx('ai_call_log').where({ tenant_id: t.id }).where('created_at', '>=', start).where('created_at', '<', end).sum('output_tokens'),
            ai_cost_usd: trx('ai_call_log').where({ tenant_id: t.id }).where('created_at', '>=', start).where('created_at', '<', end).sum('cost_usd'),
          })
          .first()) as Record<string, unknown>;
        return row;
      }).catch((err) => {
        // One broken tenant must not blank the month's export; its row
        // says so instead of carrying zeros that read as "nothing used".
        log.warn({ err, tenantId: t.id }, 'usage export: tenant read failed');
        return null;
      });

      const inTok = Number(u?.ai_input_tokens ?? 0);
      const outTok = Number(u?.ai_output_tokens ?? 0);
      lines.push([
        label, t.id, t.name, t.slug, t.status, t.plan, t.legal_name, t.vat_number, t.billing_contact, t.address,
        t.trial_ends_at ? new Date(t.trial_ends_at as string).toISOString() : '',
        t.seats, u ? Number(u.users_active) : 'ERROR', u ? Number(u.users_total) : 'ERROR', t.max_connections, u ? Number(u.connections) : 'ERROR',
        u ? Number(u.sync_runs) : 'ERROR', u ? Number(u.sync_runs_failed) : 'ERROR',
        u ? Number(u.ai_calls) : 'ERROR', inTok, outTok, inTok + outTok, u ? Number(u.ai_cost_usd ?? 0).toFixed(6) : 'ERROR',
        t.monthly_token_budget,
      ].map(csvCell).join(','));
    }

    log.info({ month: label, tenants: tenants.length, operator: req.user!.email }, 'usage export produced');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clarion-usage-${label}.csv"`);
    res.send(lines.join('\r\n') + '\r\n');
  } catch (err) { next(err); }
});

// ───────────────────────────── one tenant in depth ──────────────────────────

router.get('/:id', validate(adminTenantParamsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const tenant = await semanticDb('tenants')
      .select('id', 'name', 'slug', 'status', 'monthly_token_budget', 'created_at', 'plan', 'seats', 'max_connections', 'trial_ends_at', 'billing_contact', 'legal_name', 'vat_number', 'address')
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

    // Suspend stops the tenant's scheduled syncs and report emails right
    // away; resume brings them back without waiting for the next boot (the
    // loaders only read ACTIVE tenants — P0-2). Best-effort: a queue blip
    // must not fail the status change, and the reconciler catches up.
    try {
      if (status === 'suspended') await unregisterSchedulesForTenant(id);
      else await registerSchedulesForTenant(id);
    } catch (err) {
      log.warn({ err, tenantId: id, status }, 'tenant schedule (un)registration failed after status change');
    }

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

// ───────────────────────────── customer record ──────────────────────────────

router.patch('/:id/customer', validate(adminTenantCustomerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const b = req.body as {
      plan?: string | null; seats?: number | null; maxConnections?: number | null; trialEndsAt?: string | null;
      billingContact?: string | null; legalName?: string | null; vatNumber?: string | null; address?: string | null;
    };
    // Only the keys sent are changed; an absent key leaves the column alone
    // (a partial edit from the console must not wipe the rest).
    const updates: Record<string, unknown> = {};
    if ('plan' in b) updates.plan = b.plan || null;
    if ('seats' in b) updates.seats = b.seats;
    if ('maxConnections' in b) updates.max_connections = b.maxConnections;
    if ('trialEndsAt' in b) updates.trial_ends_at = b.trialEndsAt ? new Date(b.trialEndsAt) : null;
    if ('billingContact' in b) updates.billing_contact = b.billingContact || null;
    if ('legalName' in b) updates.legal_name = b.legalName || null;
    if ('vatNumber' in b) updates.vat_number = b.vatNumber || null;
    if ('address' in b) updates.address = b.address || null;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ ok: false, error: 'Nothing to change' });
      return;
    }
    updates.updated_at = semanticDb.fn.now();

    const updated = await semanticDb('tenants').where({ id }).update(updates);
    if (updated === 0) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }

    await recordAuditForTenant(id, req, {
      action: 'tenant.customer_change',
      entityType: 'tenant',
      entityId: id,
      context: { ...b },
    });

    const row = await semanticDb('tenants')
      .select('id', 'name', 'slug', 'status', 'monthly_token_budget', 'created_at', 'plan', 'seats', 'max_connections', 'trial_ends_at', 'billing_contact', 'legal_name', 'vat_number', 'address')
      .where({ id })
      .first();
    res.json({ ok: true, data: shapeTenant(row as Record<string, unknown>) });
  } catch (err) { next(err); }
});

// ───────────────────────── user administration (6-5) ────────────────────────
//
// Every support task used to need impersonation: reset-MFA, role change,
// deactivate and invite were tenant-admin-only. These act on the TARGET
// tenant under its own SET LOCAL context, require a stated reason, and
// audit into the customer's trail as `platform_operator` — the same
// contract as impersonation, without the session.

router.post('/:id/users/invite', validate(adminTenantInviteSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { email, displayName, role, reason } = req.body as { email: string; displayName: string; role: 'admin' | 'analyst' | 'viewer'; reason: string };
    const tenant = await semanticDb('tenants').select('id', 'status').where({ id }).first();
    if (!tenant) { res.status(404).json({ ok: false, error: 'Not found' }); return; }

    const result = await tenantQuery(id, async (trx) => {
      const seats = await checkSeatCap(trx, id);
      if (!seats.ok) return { refused: { status: 409 as const, error: seats.message!, code: 'seat_cap' } };
      const r = await inviteUser(trx, { tenantId: id, email, displayName, role, inviter: req.user!.email });
      if (r.kind === 'refused') return { refused: { status: r.status, error: r.error } };
      return { invited: r };
    });
    if ('refused' in result) {
      res.status(result.refused.status).json({ ok: false, error: result.refused.error, code: (result.refused as { code?: string }).code });
      return;
    }
    await recordAuditForTenant(id, req, {
      action: 'user.invite', entityType: 'user', entityId: result.invited.user.id,
      context: { invited_email: result.invited.user.email, role, reason, by_operator: true },
    });
    res.status(201).json({ ok: true, data: { user: result.invited.user, emailed: result.invited.emailed } });
  } catch (err) { next(err); }
});

router.patch('/:id/users/:userId', validate(adminTenantUserPatchSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.params.userId);
    const { role, isActive, reason } = req.body as { role?: 'admin' | 'analyst' | 'viewer'; isActive?: boolean; reason: string };
    if (role === undefined && isActive === undefined) {
      res.status(400).json({ ok: false, error: 'Nothing to change' });
      return;
    }

    const outcome = await tenantQuery(id, async (trx) => {
      const user = await trx('users').select('id', 'email', 'role', 'is_active').where({ id: userId, tenant_id: id }).first();
      if (!user) return { status: 404 as const, error: 'No such user in this workspace' };

      // Never leave a workspace without an active admin — the customer
      // would be locked out of their own settings (assessment's
      // last-admin note, applied here where the operator acts).
      const losesAdmin = user.role === 'admin' && user.is_active
        && ((role !== undefined && role !== 'admin') || isActive === false);
      if (losesAdmin) {
        const others = await trx('users').where({ tenant_id: id, role: 'admin', is_active: true }).whereNot({ id: userId }).count<{ n: string }>('* as n').first();
        if (Number(others?.n ?? 0) === 0) {
          return { status: 400 as const, error: 'That is the workspace\'s only active admin — make someone else admin first.' };
        }
      }
      if (isActive === true) {
        const seats = await checkSeatCap(trx, id);
        if (!user.is_active && !seats.ok) return { status: 409 as const, error: seats.message! };
      }

      const updates: Record<string, unknown> = { updated_at: trx.fn.now() };
      if (role !== undefined) updates.role = role;
      if (isActive !== undefined) updates.is_active = isActive;
      await trx('users').where({ id: userId, tenant_id: id }).update(updates);
      const after = await trx('users').select('id', 'email', 'display_name', 'role', 'is_active').where({ id: userId, tenant_id: id }).first();
      return { status: 200 as const, before: user, after };
    });
    if (outcome.status !== 200) {
      res.status(outcome.status).json({ ok: false, error: outcome.error });
      return;
    }

    // A demoted or deactivated user must feel it now, not at token expiry.
    const roleChanged = role !== undefined && outcome.before.role !== role;
    if (roleChanged || isActive === false) {
      try { await revokeAllForUser(userId, id, isActive === false ? 'user_deactivated' : 'role_change'); }
      catch (err) { log.warn({ err, tenantId: id, userId }, 'revokeAllForUser failed after operator change'); }
    }
    await recordAuditForTenant(id, req, {
      action: isActive === false ? 'user.deactivate' : isActive === true && !outcome.before.is_active ? 'user.reactivate' : 'user.update',
      entityType: 'user', entityId: userId,
      context: { reason, by_operator: true, before: { role: outcome.before.role, is_active: outcome.before.is_active }, after: { role: outcome.after?.role, is_active: outcome.after?.is_active } },
    });
    res.json({ ok: true, data: outcome.after });
  } catch (err) { next(err); }
});

router.post('/:id/users/:userId/reset-mfa', validate(adminTenantUserResetMfaSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const userId = Number(req.params.userId);
    const { reason } = req.body as { reason: string };
    const user = await tenantQuery(id, (trx) =>
      trx('users').select('id', 'email', 'mfa_enabled_at').where({ id: userId, tenant_id: id }).first());
    if (!user) { res.status(404).json({ ok: false, error: 'No such user in this workspace' }); return; }
    if (!user.mfa_enabled_at) { res.status(400).json({ ok: false, error: '2FA is not enabled for this user' }); return; }

    await disableMfa(userId);
    try { await revokeAllForUser(userId, id, 'mfa_reset_by_admin'); }
    catch (err) { log.warn({ err, tenantId: id, userId }, 'revokeAllForUser failed after operator MFA reset'); }
    await recordAuditForTenant(id, req, {
      action: 'mfa.disable', entityType: 'user', entityId: userId,
      context: { reason, by_operator: true, target_email: user.email },
    });
    res.json({ ok: true });
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
