/**
 * AI routing — admin-only.
 *
 *   GET  /api/admin/ai-routing
 *     Returns global mode, azure status, available models, per-category overrides.
 *
 *   PUT  /api/admin/ai-routing  { mode: 'claude' | 'hybrid' | 'azure' | 'off' }
 *     Updates the global routing mode. 'off' (4-3) refuses every AI call
 *     for the tenant — nothing leaves for any provider.
 *
 *   GET  /api/admin/ai-routing/categories
 *     Returns all call categories with their current model assignments.
 *
 *   PUT  /api/admin/ai-routing/categories/:category
 *     Set a per-category model override. Body: { provider, model_id }.
 *     Only a model on the platform's approved list is accepted
 *     (services/ai/approvedModels.ts) — the tenant admin chooses, the
 *     platform decides what can be chosen.
 *
 *   DELETE /api/admin/ai-routing/categories/:category
 *     Remove a per-category override (revert to global mode).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { invalidateTenantAiMode, parseAiRoutingMode, type AiRoutingMode } from '../services/ai/tenantAiMode';
import { isAzureConfigured, isAzureOpenAIConfigured } from '../services/ai/azureClient';
import { getAllCallCategoryConfigs, invalidateCallCategoryCache } from '../services/ai/callCategoryConfig';
import { approvedModels, isApprovedModel } from '../services/ai/approvedModels';
import { ALL_CALL_CATEGORIES, CALL_CATEGORY_META, type CallCategory } from '../services/ai/router';
import { validate } from '../middleware/validate';
import { setCategoryModelSchema, clearCategoryModelSchema } from '../middleware/schemas';
import { recordAudit } from '../services/auditService';

const router = Router();

router.use(requireAuth, requireRole('admin'));

function parseMode(raw: unknown): AiRoutingMode | null {
  return parseAiRoutingMode(raw);
}

// ─── GET / — global mode + available models ──────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const row = await reqDb(req)('tenants')
      .select('ai_routing_mode')
      .where('id', tenantId)
      .first() as { ai_routing_mode?: string } | undefined;
    const mode = parseMode(row?.ai_routing_mode) ?? 'claude';

    // The approved list — Anthropic models the platform has checked and
    // priced, plus only the Azure deployments this environment actually has.
    const availableModels = approvedModels();

    res.json({
      ok: true,
      data: {
        mode,
        azureConfigured: isAzureConfigured(),
        azureOpenAIConfigured: isAzureOpenAIConfigured(),
        availableModels,
      },
    });
  } catch (err) { next(err); }
});

// ─── PUT / — update global mode ──────────────────────────────────────────

router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const mode = parseMode((req.body as { mode?: unknown })?.mode);
    if (!mode) {
      res.status(400).json({ ok: false, error: 'mode must be one of: claude, hybrid, azure, off' });
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

// ─── GET /categories — per-category overrides ────────────────────────────

router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const overrides = await getAllCallCategoryConfigs(reqDb(req), tenantId);

    const categories = ALL_CALL_CATEGORIES.map((cat) => {
      const meta = CALL_CATEGORY_META[cat];
      const override = overrides[cat];
      return {
        category: cat,
        label: meta.label,
        description: meta.description,
        defaultModel: meta.defaultModel,
        override: override ?? null,
        // A stored choice the platform no longer offers is ignored at call
        // time; the screen says so instead of showing it as in force.
        overrideApproved: override ? isApprovedModel(override.provider, override.model_id) : null,
      };
    });

    res.json({ ok: true, data: { categories } });
  } catch (err) { next(err); }
});

// ─── PUT /categories/:category — set per-category override ───────────────

router.put('/categories/:category', validate(setCategoryModelSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const { category } = req.params;
    if (!ALL_CALL_CATEGORIES.includes(category as CallCategory)) {
      res.status(400).json({ ok: false, error: `Unknown category: ${category}` });
      return;
    }
    const { provider, model_id } = req.body as { provider: string; model_id: string };
    if (!isApprovedModel(provider, model_id)) {
      res.status(400).json({ ok: false, error: `${model_id} is not one of the models this platform offers. Pick one from the list.` });
      return;
    }

    const db = reqDb(req);
    await db('ai_model_config')
      .insert({
        tenant_id: tenantId,
        call_category: category,
        provider,
        model_id,
        updated_at: db.fn.now(),
      })
      .onConflict(['tenant_id', 'call_category'])
      .merge({ provider, model_id, updated_at: db.fn.now() });

    invalidateCallCategoryCache(tenantId);

    await recordAudit(req, {
      action: 'ai_routing.category_override',
      entityType: 'tenant',
      entityId: tenantId,
      context: { category, provider, model_id },
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE /categories/:category — remove override ──────────────────────

router.delete('/categories/:category', validate(clearCategoryModelSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const { category } = req.params;
    if (!ALL_CALL_CATEGORIES.includes(category as CallCategory)) {
      res.status(400).json({ ok: false, error: `Unknown category: ${category}` });
      return;
    }

    await reqDb(req)('ai_model_config')
      .where({ tenant_id: tenantId, call_category: category })
      .del();

    invalidateCallCategoryCache(tenantId);

    await recordAudit(req, {
      action: 'ai_routing.category_override_removed',
      entityType: 'tenant',
      entityId: tenantId,
      context: { category },
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
