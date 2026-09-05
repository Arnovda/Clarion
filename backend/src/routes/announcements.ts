/**
 * GET /api/announcements — what every signed-in user should see right now
 * (6-4). Read by the shell's banner. Cached 20 s server-side; any role.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { activeAnnouncements } from '../services/announcements';

const router = Router();
router.get('/', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: { announcements: await activeAnnouncements() } });
  } catch (err) { next(err); }
});
export default router;
