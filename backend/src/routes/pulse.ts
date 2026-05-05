/**
 * Pulse routes — per-user CRUD + AI-suggested seed.
 *
 * GET    /api/pulse                — list current user's pulse entries
 * POST   /api/pulse                — add an entry
 * PUT    /api/pulse/:id            — update sensitivity / frequency / label / position
 * DELETE /api/pulse/:id            — remove an entry
 * POST   /api/pulse/suggest        — AI suggests entries from existing KPIs (read-only)
 * POST   /api/pulse/apply-suggest  — accept a set of suggestions and persist them
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listPulse, createPulse, updatePulse, deletePulse,
  suggestPulse, applySuggestions,
  type PulseSensitivity, type PulseFrequency, type PulseKind,
} from '../services/pulseService';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    const entries = await listPulse(tenantId, userId);
    res.json({ ok: true, data: entries });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }

    const body = req.body as {
      kind: PulseKind;
      product_kpi_id?: number; data_product_id?: number;
      dimension_table?: string; dimension_column?: string;
      theme_text?: string;
      sensitivity?: PulseSensitivity; frequency?: PulseFrequency;
      label?: string;
    };
    if (!body.kind || !['metric', 'slice', 'theme'].includes(body.kind)) {
      res.status(400).json({ ok: false, error: 'kind is required (metric|slice|theme)' });
      return;
    }
    const entry = await createPulse(tenantId, userId, body);
    res.json({ ok: true, data: entry });
  } catch (err) { next(err); }
});

router.put('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }

    const body = req.body as {
      sensitivity?: PulseSensitivity;
      frequency?: PulseFrequency;
      label?: string | null;
      position?: number;
    };
    await updatePulse(tenantId, userId, Number(req.params.id), body);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    await deletePulse(tenantId, userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/suggest', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    // ?force=1 bypasses the 24h in-process cache — used by the explicit
    // "Refresh" button on the Pulse panel. Default (no param) returns
    // the cached result so a normal Home page load doesn't burn tokens.
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await suggestPulse(tenantId, userId, { force });
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

router.post('/apply-suggest', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId;
    const userId = req.user?.sub as number | undefined;
    if (!tenantId || !userId) { res.status(401).json({ ok: false, error: 'Auth required' }); return; }
    const { suggestions } = req.body as { suggestions: Array<Record<string, unknown>> };
    if (!Array.isArray(suggestions)) {
      res.status(400).json({ ok: false, error: 'suggestions[] required' });
      return;
    }
    const inserted = await applySuggestions(tenantId, userId, suggestions as never);
    res.json({ ok: true, data: { inserted } });
  } catch (err) { next(err); }
});

export default router;
