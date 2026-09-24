/**
 * The Studio coworker — one conversation that looks things up and proposes.
 *
 *   GET  /api/coworker/status   is the coworker on for me? (any signed-in user)
 *   POST /api/coworker/turn     one message → a stream of CoworkerEvents (SSE)
 *
 * Behind the `ai_coworker` feature flag, and that flag is the undo button the
 * owner asked for: switched off on /admin/features, `status` says so within
 * the flag cache's 20 seconds, the panel disappears, the catalog's previous
 * assistant returns, and `turn` answers 404 like a route that does not exist.
 * Curators only (admin + analyst): Studio is theirs, and every tool reaches
 * routes a viewer cannot call anyway.
 *
 * The turn never writes. Proposals travel to the browser, and the person's
 * Keep calls the write route itself — see services/coworker/tools.ts.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { coworkerTurnSchema } from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { startSSE } from '../services/sse';
import { isFeatureEnabled } from '../services/featureFlags';
import { runCoworkerTurn, type HistoryTurn } from '../services/coworker/agent';
import { AiBudgetExceededError, AiDisabledError } from '../services/aiBudget';
import { isOverloadedError } from '../ai/AIService';
import type { CoworkerPageContext } from '../shared/contract';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'coworker-route' });
const router = Router();

const CURATOR_ROLES = new Set(['admin', 'analyst']);

router.get('/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const curator = CURATOR_ROLES.has(String(req.user!.role));
    const on = curator && await isFeatureEnabled(req.user!.tenantId, 'ai_coworker');
    res.json({ ok: true, data: { enabled: on } });
  } catch (err) { next(err); }
});

router.post('/turn', requireAuth, requireRole('admin', 'analyst'), validate(coworkerTurnSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Refused like a route that is not there: switching the coworker off must
    // leave nothing behind that answers.
    if (!await isFeatureEnabled(req.user!.tenantId, 'ai_coworker')) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const { message, history, context } = req.body as {
      message: string; history?: HistoryTurn[]; context?: CoworkerPageContext;
    };
    const authorization = String(req.headers.authorization ?? '');

    // After this call the request transaction is released (11-1): every
    // reqDb(req) query below runs in its own short tenant-scoped transaction,
    // and the loopback calls the tools make get their own requests — nothing
    // pins a pool connection for the length of a turn.
    const sse = startSSE(res);
    try {
      await runCoworkerTurn({
        caller: { authorization, requestId: req.requestId, signal: sse.signal },
        tenantId: req.user!.tenantId,
        db: reqDb(req),
        message,
        history: history ?? [],
        context: context ?? { path: '' },
        signal: sse.signal,
        emit: (event) => sse.emit(event),
      });
    } catch (err) {
      if (!sse.signal.aborted) {
        const message = err instanceof AiDisabledError
          ? 'AI is switched off for this workspace (Settings › AI usage).'
          : err instanceof AiBudgetExceededError
            ? 'Your organisation has reached its monthly AI limit.'
            : isOverloadedError(err)
              ? 'The AI is very busy right now. Please try again in a moment.'
              : 'Something went wrong. Please try again.';
        if (!(err instanceof AiDisabledError) && !(err instanceof AiBudgetExceededError)) {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'coworker turn failed');
        }
        sse.emit({ type: 'error', message });
      }
    } finally {
      sse.end();
    }
  } catch (err) { next(err); }
});

export default router;
