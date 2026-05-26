/**
 * AI routing — admin-only.
 *
 *   GET  /api/admin/ai-routing
 *     Returns global mode, azure status, available models, per-category overrides.
 *
 *   PUT  /api/admin/ai-routing  { mode: 'claude' | 'hybrid' | 'azure' }
 *     Updates the global routing mode.
 *
 *   GET  /api/admin/ai-routing/categories
 *     Returns all call categories with their current model assignments.
 *
 *   PUT  /api/admin/ai-routing/categories/:category
 *     Set a per-category model override. Body: { provider, model_id }
 *
 *   DELETE /api/admin/ai-routing/categories/:category
 *     Remove a per-category override (revert to global mode).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { invalidateTenantAiMode, type AiRoutingMode } from '../services/ai/tenantAiMode';
import { isAzureConfigured, isAzureOpenAIConfigured, getAzureOpenAIDeployments } from '../services/ai/azureClient';
import { getAllCallCategoryConfigs, invalidateCallCategoryCache } from '../services/ai/callCategoryConfig';
import { ALL_CALL_CATEGORIES, CALL_CATEGORY_META } from '../services/ai/router';
import { recordAudit } from '../services/auditService';

const router = Router();

router.use(requireAuth, requireRole('admin'));

function parseMode(raw: unknown): AiRoutingMode | null {
  return raw === 'claude' || raw === 'hybrid' || raw === 'azure' ? raw : null;
}

const VALID_PROVIDERS = ['anthropic', 'azure-openai', 'azure-foundry'] as const;

// ─── GET / — global mode + available models ──────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const row = await reqDb(req)('tenants')
      .select('ai_routing_mode')
      .where('id', tenantId)
      .first() as { ai_routing_mode?: string } | undefined;
    const mode = parseMode(row?.ai_routing_mode) ?? 'claude';

    const availableModels: Array<{ provider: string; model_id: string; label: string }> = [
      { provider: 'anthropic', model_id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { provider: 'anthropic', model_id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ];
    if (isAzureOpenAIConfigured()) {
      const deployments = getAzureOpenAIDeployments();
      if (deployments.length > 0) {
        for (const d of deployments) {
          availableModels.push({ provider: 'azure-openai', model_id: d, label: `Azure OpenAI: ${d}` });
        }
      } else {
        availableModels.push(
          { provider: 'azure-openai', model_id: 'gpt-4o', label: 'Azure OpenAI: GPT-4o' },
          { provider: 'azure-openai', model_id: 'gpt-4o-mini', label: 'Azure OpenAI: GPT-4o-mini' },
          { provider: 'azure-openai', model_id: 'gpt-4.1', label: 'Azure OpenAI: GPT-4.1' },
          { provider: 'azure-openai', model_id: 'gpt-4.1-mini', label: 'Azure OpenAI: GPT-4.1-mini' },
          { provider: 'azure-openai', model_id: 'gpt-4.1-nano', label: 'Azure OpenAI: GPT-4.1-nano' },
        );
      }
    }
    if (isAzureConfigured()) {
      const deployment = process.env.AZURE_AI_DEPLOYMENT ?? 'unknown';
      availableModels.push({ provider: 'azure-foundry', model_id: deployment, label: `Azure Foundry: ${deployment}` });
    }

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

// ─── GET /categories — per-category overrides ────────────────────────────

router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const overrides = await getAllCallCategoryConfigs(tenantId);

    const categories = ALL_CALL_CATEGORIES.map((cat) => {
      const meta = CALL_CATEGORY_META[cat];
      const override = overrides[cat];
      return {
        category: cat,
        label: meta.label,
        description: meta.description,
        defaultModel: meta.defaultModel,
        override: override ?? null,
      };
    });

    res.json({ ok: true, data: { categories } });
  } catch (err) { next(err); }
});

// ─── PUT /categories/:category — set per-category override ───────────────

router.put('/categories/:category', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const { category } = req.params;
    if (!ALL_CALL_CATEGORIES.includes(category as any)) {
      res.status(400).json({ ok: false, error: `Unknown category: ${category}` });
      return;
    }
    const { provider, model_id } = req.body as { provider?: string; model_id?: string };
    if (!provider || !model_id) {
      res.status(400).json({ ok: false, error: 'provider and model_id are required' });
      return;
    }
    if (!VALID_PROVIDERS.includes(provider as any)) {
      res.status(400).json({ ok: false, error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
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

router.delete('/categories/:category', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const { category } = req.params;
    if (!ALL_CALL_CATEGORIES.includes(category as any)) {
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
