/**
 * Investigations routes — multi-step "why?" agent.
 *
 *   POST   /api/investigations              start a run (SSE in same response)
 *   GET    /api/investigations/:id          fetch the persisted record
 *   GET    /api/investigations              list current user's recent runs
 *
 * Why one combined POST-with-SSE instead of POST-then-GET-stream:
 *   - The agent loop runs once. There's no "join in progress" use case
 *     (no shared multi-user investigations yet) — the user who started
 *     it is the only consumer of the stream.
 *   - One round-trip is simpler than two.
 *   - If the connection drops, GET /api/investigations/:id has the
 *     persisted state so the UI can refresh.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  startInvestigation, getInvestigation,
  type InvestigateEvent,
} from '../services/investigateService';
import { tenantQuery } from '../services/tenantQuery';
import { startSSE } from '../services/sse';

const router = Router();

// ───────────────────────────────────────────────────────────────────────────
// POST /api/investigations
//
// Body: {
//   question: string,
//   data_product_id?: number,   // required if no pulse_entry_id / brief_id
//   focus?: string,
//   pulse_entry_id?: number,
//   brief_id?: number,
// }
//
// Streams events as SSE. The first event is `started` with the
// investigation id; the user can disconnect and rejoin via GET later.
// ───────────────────────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }

    const body = req.body as {
      question: string;
      data_product_id?: number;
      focus?: string;
      pulse_entry_id?: number;
      brief_id?: number;
    };
    if (!body.question || typeof body.question !== 'string' || !body.question.trim()) {
      res.status(400).json({ ok: false, error: 'question is required' });
      return;
    }

    // Resolve the data product. If not given, try to infer from the
    // pulse entry / brief — that's the common chat-from-bullet path.
    const dataProductId = await resolveProductId(tenantId, body);
    if (!dataProductId) {
      res.status(400).json({
        ok: false,
        error: 'data_product_id is required (or pass a pulse_entry_id / brief_id)',
      });
      return;
    }

    const sse = startSSE(res, { headers: { 'Cache-Control': 'no-cache, no-transform' } });

    const send = (event: InvestigateEvent) => sse.emit(event);

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      await startInvestigation({
        tenantId,
        userId,
        dataProductId,
        question: body.question.trim(),
        focus: body.focus ?? null,
        pulseEntryId: body.pulse_entry_id ?? null,
        briefId: body.brief_id ?? null,
      }, (e) => {
        if (!aborted) send(e);
      });
    } catch (err) {
      if (!aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: 'failed', investigation: null as never, reason: msg });
      }
    } finally {
      sse.end();
    }
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/investigations/:id
// ───────────────────────────────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    const inv = await getInvestigation(tenantId, Number(req.params.id));
    if (!inv) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    res.json({ ok: true, data: inv });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/investigations — recent runs by the current user
// ───────────────────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const rows = await tenantQuery(tenantId, (trx) =>
      trx('investigations as i')
        .leftJoin('data_products as dp', 'i.data_product_id', 'dp.id')
        .where('i.user_id', userId)
        .orderBy('i.created_at', 'desc')
        .limit(limit)
        .select(
          'i.id', 'i.question', 'i.focus', 'i.status', 'i.conclusion',
          'i.conclusion_confidence', 'i.created_at', 'i.completed_at',
          'i.data_product_id', 'dp.name as product_name',
        ),
    );
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────

async function resolveProductId(
  tenantId: number,
  body: { data_product_id?: number; pulse_entry_id?: number; brief_id?: number },
): Promise<number | null> {
  if (body.data_product_id) return Number(body.data_product_id);
  if (body.pulse_entry_id) {
    const row = await tenantQuery(tenantId, (trx) =>
      trx('user_pulse_entries').where({ id: body.pulse_entry_id }).first(),
    );
    if (row?.data_product_id) return Number(row.data_product_id);
  }
  if (body.brief_id) {
    // Brief has no FK to a single product — pick the first product in
    // the user's tenant as a fallback. Must run inside tenantQuery so
    // the SET LOCAL app.current_tenant is in effect for the RLS policy.
    const fallback = await tenantQuery(tenantId, (trx) =>
      trx('data_products').first('id'),
    );
    return fallback ? Number(fallback.id) : null;
  }
  return null;
}

export default router;
