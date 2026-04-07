import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';

const router = Router();

// GET /api/notifications?unread=true&limit=30
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const unreadOnly = req.query.unread === 'true';

    let query = semanticDb('notifications')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(limit);

    if (unreadOnly) query = query.where({ read: false });

    const rows = await query;

    // Also get unread count
    const countResult = await semanticDb('notifications')
      .where({ user_id: userId, read: false })
      .count('id as count')
      .first();
    const unreadCount = Number(countResult?.count ?? 0);

    res.json({ ok: true, data: rows, unreadCount });
  } catch (err) { next(err); }
});

// PUT /api/notifications/read-all
router.put('/read-all', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    await semanticDb('notifications')
      .where({ user_id: userId, read: false })
      .update({ read: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    await semanticDb('notifications')
      .where({ id: Number(req.params.id), user_id: userId })
      .update({ read: true });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
