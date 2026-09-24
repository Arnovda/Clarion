/**
 * AI backend router — picks provider + model per call based on the
 * tenant's global mode AND per-category overrides.
 *
 * Two layers of configuration:
 *
 *   1. **Global mode** (tenants.ai_routing_mode):
 *      claude / hybrid / azure — the coarse toggle. Determines the
 *      default backend for all calls.
 *
 *   2. **Per-category overrides** (ai_model_config table):
 *      Fine-grained control. Each of the ~8 call categories can be
 *      independently assigned to a specific provider + model. When an
 *      override exists, it wins over the global mode.
 *
 * Categories map internal call labels to user-visible groups:
 *   schema_profiling, nl_to_sql, query_support, dashboards,
 *   products, investigation, formatting, suggestions
 *
 * Safety net: if Azure is selected but not configured, or an Azure
 * call fails, we fall back to Claude. The user-facing AI never goes
 * silent.
 */

import { isAzureConfigured, isAzureOpenAIConfigured, callAzureChat, callAzureOpenAIChat } from './azureClient';
import { getTenantAiMode, type AiRoutingMode } from './tenantAiMode';
import { getCallCategoryConfig, type ModelOverride } from './callCategoryConfig';
import { logger } from '../../utils/logger';
import { mainModel, lightModel } from '../../ai/modelCapabilities';
import { isApprovedModel } from './approvedModels';

const log = logger.child({ component: 'ai-router' });

export type AiCallKind = 'row' | 'schema';

/** The call categories visible in the admin UI. */
export type CallCategory =
  | 'schema_profiling'
  | 'nl_to_sql'
  | 'query_support'
  | 'dashboards'
  | 'products'
  | 'investigation'
  | 'formatting'
  | 'suggestions'
  | 'coworker';

export const ALL_CALL_CATEGORIES: CallCategory[] = [
  'schema_profiling',
  'nl_to_sql',
  'query_support',
  'dashboards',
  'products',
  'investigation',
  'formatting',
  'suggestions',
  'coworker',
];

export const CALL_CATEGORY_META: Record<CallCategory, {
  label: string;
  description: string;
  defaultModel: string;
  callLabels: string[];
}> = {
  schema_profiling: {
    label: 'Schema profiling',
    description: 'AI learns your source data — table/column descriptions, FK detection, naming conventions',
    defaultModel: mainModel(),
    callLabels: ['schema_conventions', 'table_context', 'column_descriptions', 'suggest_relationships', 'suggest_fk_matches', 'schema_draft', 'enrich_descriptions'],
  },
  nl_to_sql: {
    label: 'Ask AI (NL→SQL)',
    description: 'Natural language questions converted to SQL queries',
    defaultModel: mainModel(),
    callLabels: ['nl_to_sql', 'generate_sql_streaming', 'cross_source_sql', 'multi_turn', 'forecast_query', 'read_query_repair'],
  },
  query_support: {
    label: 'Query support',
    description: 'Result validation, answer formatting, SQL explanation',
    defaultModel: lightModel(),
    callLabels: ['validate_result', 'format_answer', 'explain_sql_plain'],
  },
  dashboards: {
    label: 'Dashboards',
    description: 'Dashboard generation, refinement, validation, narration, insights',
    defaultModel: mainModel(),
    callLabels: [
      'dashboard_spec', 'dashboard_refine', 'dashboard_refinement',
      'dashboard_validate', 'widget_semantic_check', 'narrate_dashboard',
      'dashboard_insights', 'explain_widget',
      'dashboard_edit_plan', 'dashboard_add_widget', 'widget_sql_edit',
    ],
  },
  products: {
    label: 'Data products',
    description: 'Star schema design, bus matrix, transformation SQL, product refinement',
    defaultModel: mainModel(),
    callLabels: [
      'star_schema', 'star_schema_streaming', 'bus_matrix_streaming',
      'edit_column_expression', 'refine_chat', 'refine_product',
      'refine_product_cross', 'transformation_from_scratch', 'transformation_repair',
      'transformation_propose', 'build_chat', 'key_upgrade',
    ],
  },
  investigation: {
    label: 'Investigation',
    description: 'Diagnostic query planning, step summarization, conclusion synthesis',
    defaultModel: mainModel(),
    callLabels: [
      'investigate_plan_next', 'investigate_summarise', 'investigate_conclude',
      'investigate_plan', 'investigate_synthesize',
    ],
  },
  formatting: {
    label: 'Formatting & summaries',
    description: 'Report narratives, quality alert context, morning briefs',
    defaultModel: lightModel(),
    callLabels: ['report_narrative', 'quality_alert_context', 'morning_brief'],
  },
  suggestions: {
    label: 'Suggestions & misc',
    description: 'KPI drafting, pulse entries, query starters, product icons',
    defaultModel: lightModel(),
    callLabels: ['kpi_draft', 'pulse_suggest', 'query_starters', 'product_icon'],
  },
  // The Studio coworker's OWN loop: understanding the ask, choosing the next
  // tool, phrasing the answer. The light model by default — the expensive
  // writing it hands off (a SQL change) runs through the existing call in its
  // own category ('products' → transformation_propose), at exactly the cost
  // that call has today. Kept separate so /admin/ai-usage shows what the
  // coworker itself adds.
  coworker: {
    label: 'Studio coworker',
    description: 'The Studio assistant deciding what to look at and what to propose — the writing it delegates is counted in its own category',
    defaultModel: lightModel(),
    callLabels: ['coworker_turn'],
  },
};

const LABEL_TO_CATEGORY = new Map<string, CallCategory>();
for (const [cat, meta] of Object.entries(CALL_CATEGORY_META)) {
  for (const label of meta.callLabels) {
    LABEL_TO_CATEGORY.set(label, cat as CallCategory);
  }
}

export function callLabelToCategory(callLabel: string): CallCategory | undefined {
  return LABEL_TO_CATEGORY.get(callLabel);
}

export interface RouterOptions {
  kind: AiCallKind;
  tenantId: number | undefined;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RouterResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  backend: 'claude' | 'azure-openai' | 'azure-foundry';
}

export type ResolvedModel = {
  provider: 'anthropic' | 'azure-openai' | 'azure-foundry';
  modelId: string;
} | null;

/** Warn once per process per stale override, not on every call. */
const warnedUnapproved = new Set<string>();

/**
 * Resolve which provider + model to use for a specific call.
 *
 * Priority:
 *   1. Per-category override in ai_model_config → use that exact provider + model
 *      (only while that model is approved — see approvedModels.ts)
 *   2. Global tenant mode (claude/hybrid/azure) → derive provider from kind
 *   3. Default → Claude with the model the caller specified
 */

export async function resolveModel(opts: {
  callLabel: string;
  kind: AiCallKind;
  tenantId: number | undefined;
}): Promise<ResolvedModel> {
  const category = callLabelToCategory(opts.callLabel);

  if (category && opts.tenantId) {
    const override = await getCallCategoryConfig(opts.tenantId, category);
    // An override is only honoured while the model is still on the
    // platform's approved list. A stored choice that fell off it (a model
    // retired, an Azure deployment removed) is ignored, not sent: the call
    // uses the category default and the log says why.
    if (override && !isApprovedModel(override.provider, override.model_id)) {
      const key = `${opts.tenantId}:${category}:${override.provider}:${override.model_id}`;
      if (!warnedUnapproved.has(key)) {
        warnedUnapproved.add(key);
        log.warn({ tenantId: opts.tenantId, category, provider: override.provider, model: override.model_id },
          'per-category override names a model that is not approved — using the default');
      }
    } else if (override) {
      if (override.provider === 'anthropic') {
        return { provider: 'anthropic', modelId: override.model_id };
      }
      if (override.provider === 'azure-openai') {
        if (!isAzureOpenAIConfigured()) {
          log.warn({ tenantId: opts.tenantId, category }, 'per-category override points to azure-openai but env not configured — falling back');
          return null;
        }
        return { provider: 'azure-openai', modelId: override.model_id };
      }
      if (override.provider === 'azure-foundry') {
        if (!isAzureConfigured()) {
          log.warn({ tenantId: opts.tenantId, category }, 'per-category override points to azure-foundry but env not configured — falling back');
          return null;
        }
        return { provider: 'azure-foundry', modelId: override.model_id };
      }
    }
  }

  return null;
}

/**
 * Legacy: decide backend from global mode + kind. Returns 'azure' only
 * when the tenant has explicitly opted in AND Azure is configured.
 */
export async function pickBackend(opts: { kind: AiCallKind; tenantId: number | undefined }): Promise<'claude' | 'azure'> {
  const mode: AiRoutingMode = await getTenantAiMode(opts.tenantId);
  const wantsAzure =
    mode === 'azure' ||
    (mode === 'hybrid' && opts.kind === 'row');
  if (!wantsAzure) return 'claude';
  if (!isAzureConfigured()) {
    log.warn({ tenantId: opts.tenantId, mode, kind: opts.kind }, 'tenant opted into Azure but AZURE_AI_* env vars missing — falling back to Claude');
    return 'claude';
  }
  return 'azure';
}

export async function callAzureBackend(opts: RouterOptions): Promise<RouterResult> {
  try {
    const res = await callAzureChat({
      systemPrompt: opts.systemPrompt,
      userPrompt:   opts.userPrompt,
      maxTokens:    opts.maxTokens,
      temperature:  opts.temperature,
    });
    return { ...res, backend: 'azure-foundry' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, kind: opts.kind, tenantId: opts.tenantId }, 'azure foundry backend failed');
    throw err;
  }
}

export async function callAzureOpenAIBackend(opts: RouterOptions & { model: string }): Promise<RouterResult> {
  try {
    const res = await callAzureOpenAIChat({
      systemPrompt: opts.systemPrompt,
      userPrompt:   opts.userPrompt,
      maxTokens:    opts.maxTokens,
      temperature:  opts.temperature,
      deploymentName: opts.model,
    });
    return { ...res, backend: 'azure-openai' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, kind: opts.kind, tenantId: opts.tenantId, model: opts.model }, 'azure openai backend failed');
    throw err;
  }
}
