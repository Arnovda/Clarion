/**
 * AI routing toggle — admin-only.
 *
 *   GET  /api/admin/ai-routing
 *     Returns { mode, azureConfigured } for the current tenant.
 *
 *   PUT  /api/admin/ai-routing  { mode: 'claude' | 'hybrid' | 'azure' }
 *     Updates tenants.ai_routing_mode + invalidates the in-process cache
 *     so the next AI call (within ~15s) picks up the new mode.
 *
 * Locked to Claude when Azure isn't configured — the PUT still accepts
 * 'hybrid' / 'azure' (so an operator can pre-stage the choice) but the
 * router falls back to Claude at call time. The UI surfaces this so
 * admins aren't confused why "Azure Full" isn't actually changing
 * behaviour.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { invalidateTenantAiMode, type AiRoutingMode } from '../services/ai/tenantAiMode';
import { isAzureConfigured } from '../services/ai/azureClient';
import { recordAudit } from '../services/auditService';

const router = Router();

router.use(requireAuth, requireRole('admin'));

function parseMode(raw: unknown): AiRoutingMode | null {
  return raw === 'claude' || raw === 'hybrid' || raw === 'azure' ? raw : null;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const row = await reqDb(req)('tenants')
      .select('ai_routing_mode')
      .where('id', tenantId)
      .first() as { ai_routing_mode?: string } | undefined;
    const mode = parseMode(row?.ai_routing_mode) ?? 'claude';
    res.json({
      ok: true,
      data: {
        mode,
        azureConfigured: isAzureConfigured(),
      },
    });
  } catch (err) { next(err); }
});

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const mode = parseMode((req.body as { mode?: unknown })?.mode);
    if (!mode) {
      res.status(400).json({ ok: false, error: 'mode must be one of: claude, hybrid, azure' });
      return;
    }
    await reqDb(req)('tenants').where('id', tenantId).update({ ai_routing_mode: mode });
    invalidateTenantAiMode(tenantId);
    await recordAudit(req, {
      action: 'ai_routing.update',
      entityType: 'tenant',
      entityId: tenantId,
      context: { mode, azure_configured: isAzureConfigured() },
    });
    res.json({
      ok: true,
      data: { mode, azureConfigured: isAzureConfigured() },
    });
  } catch (err) { next(err); }
});

export default router;
