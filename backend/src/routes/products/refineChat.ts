/**
 * Products router (8/9): refine chat — per-product conversational editing
 * (list/create refinements, approve, reject, preview).
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { Database } from 'duckdb-async';
import { reqDb } from '../../db/reqDb';
import { buildConnectionWarehouseSession } from '../../services/productWarehouse';
import { log } from './shared';

const router = Router();

// ---------------------------------------------------------------------------
// Refine chat — per-product conversational editing.
//
// GET    /api/products/:id/refinements           — list (team-visible log)
// POST   /api/products/:id/refinements           — new chat message → AI proposal
// POST   /api/products/refinements/:id/approve   — apply the proposal
// POST   /api/products/refinements/:id/reject    — discard the proposal
// ---------------------------------------------------------------------------

router.get('/:id/refinements', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const { listRefinements } = await import('../../services/refineService');
    const rows = await listRefinements(tenantId, Number(req.params.id));
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

router.post('/:id/refinements', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const { message, focusedTableId } = req.body as { message: string; focusedTableId?: number | null };
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ ok: false, error: 'Message is required' });
      return;
    }

    const { createRefinement } = await import('../../services/refineService');
    const row = await createRefinement(
      tenantId,
      Number(req.params.id),
      (req.user?.sub as number | undefined) ?? null,
      (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? null,
      message.trim(),
      focusedTableId ?? null,
    );
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

router.post('/refinements/:id/approve', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const userId = req.user?.sub as number | undefined;
    const userName = (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? '';
    if (!userId) { res.status(401).json({ ok: false, error: 'User id required' }); return; }

    const { approveRefinement } = await import('../../services/refineService');
    const row = await approveRefinement(tenantId, Number(req.params.id), userId, userName);
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

router.post('/refinements/:id/reject', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }
    const userId = req.user?.sub as number | undefined;
    const userName = (req.user?.displayName as string | undefined) ?? (req.user?.email as string | undefined) ?? '';
    if (!userId) { res.status(401).json({ ok: false, error: 'User id required' }); return; }

    const { rejectRefinement } = await import('../../services/refineService');
    const row = await rejectRefinement(tenantId, Number(req.params.id), userId, userName);
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// POST /api/products/refinements/:id/preview — run the proposed transformation
// against live data and return sample rows so the user can SEE the change
// before approving. A SQL error here is the point: it surfaces a bad AI
// proposal pre-commit instead of after a failed refresh.
router.post('/refinements/:id/preview', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response) => {
  let duckDb: Database | null = null;
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }

    const { getRefinementPreviewPlan } = await import('../../services/refineService');
    const plan = await getRefinementPreviewPlan(tenantId, Number(req.params.id));
    if (!plan.previewable || !plan.sql || !plan.connectionId) {
      res.json({ ok: true, data: { previewable: false, reason: plan.reason ?? 'Not previewable' } });
      return;
    }

    duckDb = await buildConnectionWarehouseSession(reqDb(req), plan.connectionId);
    const inner = plan.sql.trim().replace(/;\s*$/, '');
    const rawRows = await duckDb.all(`SELECT * FROM (\n${inner}\n) AS _preview LIMIT 12`) as Record<string, unknown>[];
    const rows = rawRows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
      return out;
    });
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    res.json({
      ok: true,
      data: { previewable: true, rows, columns, targetColumn: plan.targetColumn ?? null, rowCount: rows.length },
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Preview failed' });
  } finally {
    if (duckDb) try { await duckDb.close(); } catch { /* ignore */ }
  }
});


export default router;
