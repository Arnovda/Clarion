/**
 * Endpoints for the Excel add-in.
 *
 *   GET  /api/addin/me                    — confirm a token works, and as whom
 *   GET  /api/addin/questions             — the saved questions available
 *   POST /api/addin/questions/:id/run     — run one, return columns + rows
 *
 * A DELIBERATELY NARROW SURFACE. Personal API tokens are accepted here and
 * nowhere else: a token is a long-lived credential that lives on somebody's
 * laptop inside Excel, so the blast radius of a leaked one should be the three
 * read-only endpoints the add-in actually needs, not the whole API. Widening
 * this later (an MCP endpoint is the obvious next caller) is a deliberate act
 * with its own review, not something that happens by default.
 *
 * Everything here is READ-ONLY by construction. There is no mutation route,
 * and the one query path runs SQL that was already validated when it was
 * saved AND re-validated here — because saving and running are different
 * moments, and a guard that only ran at save time is a guard that trusts the
 * database has not changed since.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { resolveApiToken } from '../middleware/apiToken';
import { validate } from '../middleware/validate';
import { runSavedQuestionSchema } from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { createConnector, createProductConnector } from '../connectors/ConnectorFactory';
import { getProductWarehousePath } from '../services/productContext';
import { applyDataPolicies } from '../services/policyEngine';
import { assertSafeReadQuery } from '../utils/sqlGuard';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'addin' });

const router = Router();
// Token first, session second: `resolveApiToken` swaps a valid personal token
// for a short-lived session token and steps aside, so `requireAuth` below runs
// unchanged and the two auth paths cannot drift apart.
router.use(resolveApiToken);
router.use(requireAuth);

/** Default page size when the add-in does not ask for one. */
const DEFAULT_LIMIT = 1000;

router.get('/me', async (req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      email: req.user!.email,
      displayName: req.user!.displayName,
      role: req.user!.role,
    },
  });
});

router.get('/questions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await reqDb(req)('saved_questions')
      .where({ tenant_id: req.user!.tenantId })
      .orderBy([{ column: 'verified', order: 'desc' }, { column: 'times_used', order: 'desc' }])
      .limit(200)
      .select('id', 'question', 'verified', 'data_layer', 'connection_id', 'last_used_at');
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/questions/:id/run', validate(runSavedQuestionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const limit = (req.body as { limit?: number } | undefined)?.limit ?? DEFAULT_LIMIT;

    // Explicit tenant filter as well as RLS — the reqDb pool-race rule.
    const sq = await db('saved_questions')
      .where({ id: Number(req.params.id), tenant_id: tenantId })
      .first();
    if (!sq) {
      res.status(404).json({ ok: false, error: 'Question not found' });
      return;
    }

    // Re-validate at RUN time, not just at save time. The row could have been
    // written by an older build whose guard was weaker, and running is the
    // moment that matters.
    try {
      assertSafeReadQuery(sq.sql as string);
    } catch {
      log.warn({ questionId: sq.id }, 'saved question failed the read-only guard at run time');
      res.status(400).json({ ok: false, error: 'This saved question can no longer be run safely.' });
      return;
    }

    // Row filters and column masks apply here exactly as they do in the app.
    // The add-in is a new way OUT of the platform, and a policy that held on
    // screen but not in Excel would be no policy at all.
    const policy = await applyDataPolicies(sq.sql as string, req.user!.sub, req.user!.role, tenantId);

    const connection = await db('connections')
      .where({ id: sq.connection_id, tenant_id: tenantId })
      .first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'The source for this question is no longer available.' });
      return;
    }

    let connector;
    if (sq.data_layer === 'product') {
      const warehousePath = await getProductWarehousePath(sq.connection_id as number);
      if (!warehousePath) {
        res.status(409).json({ ok: false, error: 'This data has not been prepared yet.' });
        return;
      }
      connector = await createProductConnector(warehousePath, sq.connection_id as number, tenantId);
    } else {
      connector = await createConnector(connection);
    }

    await connector.connect();
    let rows: Record<string, unknown>[];
    try {
      const result = await connector.executeQuery(policy.sql);
      rows = result.rows.slice(0, limit);
    } finally {
      connector.disconnect();
    }

    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({
      ok: true,
      data: {
        question: sq.question,
        columns,
        rows,
        // Reported so the add-in can say "first 1000 rows" rather than
        // silently handing the user a partial sheet.
        truncated: rows.length >= limit,
        policiesApplied: policy.policiesApplied,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
