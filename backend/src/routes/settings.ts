import { Router, Request, Response, NextFunction } from 'express';
import { reqDb } from '../db/reqDb';
import { semanticDb } from '../db/knex';
import { requireAuth, requireRole, verifyPassword, refuseDuringSupportSession } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { deleteTenantSchema } from '../middleware/schemas';
import { purgeTenant } from '../services/accountDeletion';
import { recordAudit } from '../services/auditService';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'settings' });

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/settings/approval — returns current tenant's auto-approve settings
// ---------------------------------------------------------------------------

router.get('/approval', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const tenant = await db('tenants')
      .where({ id: tenantId })
      .select('auto_approve_ai_drafts', 'auto_approve_delay_days')
      .first();

    if (!tenant) {
      res.status(404).json({ ok: false, error: 'Tenant not found' });
      return;
    }

    res.json({
      ok: true,
      data: {
        autoApproveAiDrafts: tenant.auto_approve_ai_drafts ?? true,
        autoApproveDelayDays: tenant.auto_approve_delay_days ?? 7,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/settings/approval — update auto-approve settings (admin only)
// ---------------------------------------------------------------------------

router.put('/approval', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const { autoApproveAiDrafts, autoApproveDelayDays } = req.body as {
      autoApproveAiDrafts?: boolean;
      autoApproveDelayDays?: number;
    };

    const updates: Record<string, unknown> = {};

    if (autoApproveAiDrafts !== undefined) {
      updates.auto_approve_ai_drafts = Boolean(autoApproveAiDrafts);
    }

    if (autoApproveDelayDays !== undefined) {
      const days = Math.max(1, Math.min(90, Math.round(Number(autoApproveDelayDays))));
      updates.auto_approve_delay_days = days;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ ok: false, error: 'No valid fields to update' });
      return;
    }

    await db('tenants').where({ id: tenantId }).update(updates);

    // Return updated values
    const tenant = await db('tenants')
      .where({ id: tenantId })
      .select('auto_approve_ai_drafts', 'auto_approve_delay_days')
      .first();

    res.json({
      ok: true,
      data: {
        autoApproveAiDrafts: tenant.auto_approve_ai_drafts,
        autoApproveDelayDays: tenant.auto_approve_delay_days,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/settings/delete-tenant — IRREVERSIBLE full account closure.
// Purges every row, warehouse file, and graph node for the caller's tenant
// (the tenants row is kept but scrubbed + tombstoned). Guarded by password
// re-auth AND exact org-name confirmation — the GitHub/Stripe org-deletion
// pattern. Self-service within the caller's OWN tenant only; needs no
// cross-tenant operator role.
// ---------------------------------------------------------------------------
router.post('/delete-tenant', requireRole('admin'), refuseDuringSupportSession, validate(deleteTenantSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const { confirmName, password } = req.body as { confirmName: string; password: string };

    // Re-authenticate the admin.
    const me = await db('users').where({ id: req.user!.sub }).select('password_hash').first();
    if (!me || !(await verifyPassword(password, me.password_hash))) {
      res.status(403).json({ ok: false, error: 'Password is incorrect' });
      return;
    }

    // Exact org-name confirmation.
    const tenant = await db('tenants').where({ id: tenantId }).select('name').first();
    if (!tenant) {
      res.status(404).json({ ok: false, error: 'Tenant not found' });
      return;
    }
    if (confirmName.trim() !== tenant.name) {
      res.status(400).json({ ok: false, error: 'Confirmation name does not match your organisation name' });
      return;
    }

    // Audit BEFORE the purge — the audit_events row for this tenant is deleted
    // by the purge, but the structured log line survives in Log Analytics.
    log.warn({ tenantId, actor: req.user!.email }, 'tenant account closure requested — purging all data');
    try {
      await recordAudit(req, { action: 'tenant.delete', entityType: 'tenant', entityId: tenantId });
    } catch { /* the row is about to be purged anyway */ }

    // Run on semanticDb (its own top-level transaction) rather than the
    // request transaction — the purge deletes this very user and would
    // otherwise fight the reqDb commit-at-response-end.
    const result = await purgeTenant(semanticDb, tenantId);

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

export default router;
