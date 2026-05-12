import { Router, Request, Response, NextFunction } from 'express';
import { reqDb } from '../db/reqDb';
import { requireAuth, requireRole } from '../middleware/auth';

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

export default router;
