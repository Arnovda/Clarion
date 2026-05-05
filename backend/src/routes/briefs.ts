/**
 * Morning brief routes — read-only for the user, plus an admin-only
 * manual trigger so we can test the pipeline without waiting for cron.
 *
 * GET    /api/briefs/today          — today's brief (or null)
 * GET    /api/briefs                — last 14 briefs for history
 * POST   /api/briefs/:id/opened     — mark a brief as opened
 * POST   /api/briefs/run-now        — admin only — run the pipeline now
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getTodaysBrief, listBriefs, markBriefOpened,
  runDailyBriefs, generateBriefForUser,
} from '../services/morningBriefService';
import { logger } from '../utils/logger';

const router = Router();

router.get('/today', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    const brief = await getTodaysBrief(tenantId, userId);
    res.json({ ok: true, data: brief });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    const limit = Math.min(Math.max(Number(req.query.limit) || 14, 1), 60);
    const rows = await listBriefs(tenantId, userId, limit);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/:id/opened', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    await markBriefOpened(tenantId, userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Admin-only manual trigger — runs the pipeline for the caller's tenant
 * (or just for the caller if `mineOnly=true`). Used to:
 *   - smoke-test the AI prompt without waiting for cron
 *   - re-run after a fix when the scheduled job missed a day
 *
 * Returns counts so the caller knows the run was real.
 */
router.post('/run-now', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    const { mineOnly } = req.body as { mineOnly?: boolean };

    if (mineOnly) {
      const brief = await generateBriefForUser(tenantId, userId);
      res.json({ ok: true, data: { brief } });
      return;
    }

    // Full pipeline. Long-running — don't block the response if it takes
    // a while. For MVP we await it; if it gets slow we'll move to a job.
    const result = await runDailyBriefs();
    logger.info({ result }, 'briefs.run-now: completed');
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

export default router;
