/**
 * AI backend router — picks Claude or Azure AI Foundry per call based
 * on the tenant's mode and the call's `kind`.
 *
 * Kinds:
 *   - 'row'    : prompt includes customer row data (insights, narration,
 *                explain widget, format answer, schema sample values,
 *                investigation step summaries, etc.). Goes to Azure
 *                under 'hybrid' or 'azure' mode so customer data never
 *                leaves the Azure tenancy.
 *   - 'schema' : prompt is schema/metadata only — table names, column
 *                names, descriptions, KPI formulas, etc. NL→SQL,
 *                dashboard spec generation, transformation design.
 *                Stays on Claude under 'claude' or 'hybrid' mode;
 *                moves to Azure under 'azure' mode.
 *
 * Routing matrix:
 *
 *               |  row     |  schema
 *   ------------|----------|---------
 *   claude      |  Claude  |  Claude
 *   hybrid      |  Azure   |  Claude
 *   azure       |  Azure   |  Azure
 *
 * Safety net: if Azure is selected but not configured (env vars
 * missing) OR an Azure call fails for any reason, we fall back to
 * Claude. Logged so misconfigurations surface in monitoring, but the
 * user-facing AI never goes silent.
 */

import { isAzureConfigured, callAzureChat } from './azureClient';
import { getTenantAiMode, type AiRoutingMode } from './tenantAiMode';
import { logger } from '../../utils/logger';

const log = logger.child({ component: 'ai-router' });

export type AiCallKind = 'row' | 'schema';

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
  /** Which backend actually answered. Useful for telemetry + the
   *  admin UI's "running on …" indicator. */
  backend: 'claude' | 'azure';
}

/**
 * Decide which backend should answer a call. Returns 'azure' only
 * when the tenant has explicitly opted in AND Azure is configured.
 * Otherwise returns 'claude' — the safe default.
 */
export async function pickBackend(opts: { kind: AiCallKind; tenantId: number | undefined }): Promise<'claude' | 'azure'> {
  const mode: AiRoutingMode = await getTenantAiMode(opts.tenantId);
  const wantsAzure =
    mode === 'azure' ||
    (mode === 'hybrid' && opts.kind === 'row');
  if (!wantsAzure) return 'claude';
  if (!isAzureConfigured()) {
    // Tenant wants Azure but env isn't configured. Log loudly so the
    // operator notices, then fall back to Claude.
    log.warn({ tenantId: opts.tenantId, mode, kind: opts.kind }, 'tenant opted into Azure but AZURE_AI_* env vars missing — falling back to Claude');
    return 'claude';
  }
  return 'azure';
}

/**
 * Run a single chat completion against whichever backend the tenant's
 * mode dictates. The Claude path is intentionally NOT inlined here —
 * the existing `callClaude` helper in AIService.ts already does
 * budget enforcement, retry-on-overload, and prompt caching. This
 * router's job is just to decide AND to provide the Azure path.
 *
 * For the Azure branch: any error (network, 5xx, malformed response)
 * is logged + caught; the router re-throws a sentinel so the caller
 * (AIService.callClaude wrapper) can fall back to the Claude path.
 * That fallback keeps the dashboard alive even when a freshly-pointed
 * Foundry endpoint is misconfigured.
 */
export async function callAzureBackend(opts: RouterOptions): Promise<RouterResult> {
  try {
    const res = await callAzureChat({
      systemPrompt: opts.systemPrompt,
      userPrompt:   opts.userPrompt,
      maxTokens:    opts.maxTokens,
      temperature:  opts.temperature,
    });
    return { ...res, backend: 'azure' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, kind: opts.kind, tenantId: opts.tenantId }, 'azure backend failed');
    throw err;
  }
}
