/**
 * The Studio coworker's history — the conversations a person had with it.
 *
 *   GET    /api/coworker/threads        my threads, newest first (no bodies)
 *   GET    /api/coworker/threads/:id    one thread, whole
 *   PUT    /api/coworker/threads/:id    save it (create or replace)
 *   DELETE /api/coworker/threads/:id    forget it
 *
 * Mounted on its own, ahead of the turn route, so reading and saving history
 * does not spend the AI rate limit — none of this calls a model.
 *
 * PER USER. RLS isolates tenants; every query here ALSO filters tenant_id and
 * user_id explicitly (the reqDb pool-race rule, and RLS has no notion of which
 * person inside a tenant is asking). The upsert's conflict branch carries the
 * same filter, so a guessed id belonging to a colleague updates nothing and
 * answers 404 instead of overwriting their thread.
 *
 * Deliberately NOT behind the `ai_coworker` flag: switching the coworker off
 * hides the panel, but a person's own record of what they asked stays theirs.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { saveCoworkerThreadSchema, coworkerThreadIdSchema } from '../middleware/schemas';
import { reqDb } from '../db/reqDb';

const router = Router();

/** One thread's body at most — far above a real conversation (40 messages). */
export const MAX_THREAD_BYTES = 1_500_000;
/** Threads kept per person; older ones are pruned on save. */
export const MAX_THREADS_PER_USER = 200;
const LIST_LIMIT = 100;

router.use(requireAuth, requireRole('admin', 'analyst'));

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await reqDb(req)('coworker_threads')
      .where({ tenant_id: req.user!.tenantId, user_id: req.user!.sub })
      .orderBy('updated_at', 'desc')
      .limit(LIST_LIMIT)
      .select('id', 'title', 'context_label', 'message_count', 'created_at', 'updated_at');
    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id, title: r.title, contextLabel: r.context_label,
        messageCount: r.message_count, createdAt: r.created_at, updatedAt: r.updated_at,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/:id', validate(coworkerThreadIdSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await reqDb(req)('coworker_threads')
      .where({ id: req.params.id, tenant_id: req.user!.tenantId, user_id: req.user!.sub })
      .first();
    if (!row) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }
    res.json({
      ok: true,
      data: {
        id: row.id, title: row.title, contextLabel: row.context_label,
        messages: row.messages ?? [], proposals: row.proposals ?? {},
        createdAt: row.created_at, updatedAt: row.updated_at,
      },
    });
  } catch (err) { next(err); }
});

router.put('/:id', validate(saveCoworkerThreadSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const userId = req.user!.sub;
    const { title, contextLabel, messages, proposals } = req.body as {
      title: string; contextLabel?: string | null;
      messages: Array<Record<string, unknown>>; proposals: Record<string, Record<string, unknown>>;
    };
    const messagesJson = JSON.stringify(messages);
    const proposalsJson = JSON.stringify(proposals);
    if (messagesJson.length + proposalsJson.length > MAX_THREAD_BYTES) {
      res.status(413).json({ ok: false, error: 'This conversation is too long to save. Start a new one.' });
      return;
    }

    // Upsert on the client's id. The conflict branch is filtered on the owner,
    // so a colleague's id matches the conflict and then updates nothing.
    const result = await db.raw(`
      INSERT INTO coworker_threads
        (id, tenant_id, user_id, title, context_label, message_count, messages, proposals, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        context_label = COALESCE(coworker_threads.context_label, EXCLUDED.context_label),
        message_count = EXCLUDED.message_count,
        messages = EXCLUDED.messages,
        proposals = EXCLUDED.proposals,
        updated_at = NOW()
      WHERE coworker_threads.tenant_id = EXCLUDED.tenant_id
        AND coworker_threads.user_id = EXCLUDED.user_id
      RETURNING id
    `, [req.params.id, tenantId, userId, title, contextLabel ?? null, messages.length, messagesJson, proposalsJson]);
    if (!result.rows?.length) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }

    // Keep the list bounded: a person's oldest threads beyond the cap go.
    await db('coworker_threads')
      .where({ tenant_id: tenantId, user_id: userId })
      .whereNotIn('id', db('coworker_threads')
        .where({ tenant_id: tenantId, user_id: userId })
        .orderBy('updated_at', 'desc')
        .limit(MAX_THREADS_PER_USER)
        .select('id'))
      .delete();

    res.json({ ok: true, data: { id: req.params.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', validate(coworkerThreadIdSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const n = await reqDb(req)('coworker_threads')
      .where({ id: req.params.id, tenant_id: req.user!.tenantId, user_id: req.user!.sub })
      .delete();
    if (!n) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
