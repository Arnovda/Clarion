import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import dotenv from 'dotenv';

import { TableInfo, FkCandidate } from '../connectors/BaseConnector';
import {
  SCHEMA_DRAFT_SYSTEM,
  buildSchemaDraftUser,
  SchemaDraftOutput,
  TableQualityStat,
  RELATIONSHIP_SUGGEST_SYSTEM,
  buildRelationshipSuggestUser,
  SemanticContext,
  RelationshipSuggestOutput,
} from './prompts/schemaDraftPrompt';
import {
  SCHEMA_CONVENTIONS_SYSTEM,
  buildConventionsUser,
  SchemaConventions,
  TABLE_CONTEXT_SYSTEM,
  buildTableContextUser,
  TableContextOutput,
  COLUMN_DESCRIPTIONS_SYSTEM,
  buildColumnDescriptionsUser,
  ColumnDescriptionsOutput,
  FkCandidateLike,
} from './prompts/schemaContextPrompt';
import {
  NL_TO_SQL_SYSTEM,
  buildNlToSqlUser,
  NlToSqlOutput,
  ANSWER_FORMAT_SYSTEM,
  buildAnswerFormatUser,
  RESULT_VALIDATION_SYSTEM,
  buildResultValidationUser,
  ResultValidationOutput,
  NL_TO_SQL_CROSS_SYSTEM,
  buildNlToSqlCrossUser,
} from './prompts/nlToSqlPrompt';
import {
  NL_TO_SQL_DUCKDB_SYSTEM,
  NL_TO_SQL_CROSS_DUCKDB_SYSTEM,
} from './prompts/nlToSqlPromptDuckDB';
import {
  REPORT_NARRATIVE_SYSTEM,
  buildReportNarrativeUser,
  KpiResult,
} from './prompts/answerFormatterPrompt';
import {
  DASHBOARD_SYSTEM,
  getDashboardSystem,
  buildDashboardUser,
  DashboardSpec,
  REFINEMENT_SYSTEM,
  buildRefinementUser,
  RefinementOutput,
  REFINE_SPEC_SYSTEM,
  buildRefineSpecUser,
  VALIDATE_DASHBOARD_SYSTEM,
  buildValidateUser,
  WidgetExecutionResult,
  SEMANTIC_CHECK_SYSTEM,
  buildSemanticCheckUser,
} from './prompts/dashboardPrompt';
import {
  STAR_SCHEMA_DESIGN_SYSTEM,
  buildStarSchemaDesignUser,
  StarSchemaDesignOutput,
  COLUMN_EDIT_SYSTEM,
  buildColumnEditUser,
} from './prompts/starSchemaPrompt';
import {
  REFINE_PRODUCT_SYSTEM,
  buildRefineProductUser,
  RefineProposal,
  ProductSummary,
} from './prompts/refineProductPrompt';
import {
  KPI_DRAFT_SYSTEM,
  buildKpiDraftUser,
  KpiDraftProductContext,
} from './prompts/kpiDraftPrompt';
import {
  REFINE_CHAT_SYSTEM,
  buildRefineChatUser,
  type RefineChatProductContext,
  type RefineChatResult,
  type ProposalPayload,
} from './prompts/refineChatPrompt';
import {
  PULSE_SUGGEST_SYSTEM,
  buildPulseSuggestUser,
  type PulseSuggestContext,
  type PulseSuggestResult,
} from './prompts/pulseSuggestPrompt';
import {
  MORNING_BRIEF_SYSTEM,
  buildMorningBriefUser,
  type MorningBriefContext,
  type MorningBriefOutput,
} from './prompts/morningBriefPrompt';
import {
  AGENT_PLAN_NEXT_SYSTEM,
  buildAgentPlanNextUser,
  AGENT_SUMMARISE_STEP_SYSTEM,
  buildAgentSummariseUser,
  AGENT_CONCLUDE_SYSTEM,
  buildAgentConcludeUser,
  type InvestigateAgentContext,
  type InvestigateAgentDecision,
  type InvestigateConclusion,
  type InvestigateConclusionInput,
} from './prompts/investigateAgentPrompt';
import {
  QUERY_STARTERS_SYSTEM,
  buildQueryStartersUser,
  type QueryStartersContext,
  type QueryStartersResult,
} from './prompts/queryStartersPrompt';
import {
  BUS_MATRIX_SYSTEM,
  buildBusMatrixUser,
  BusMatrixOutput,
} from './prompts/busMatrixPrompt';
import {
  FORECAST_SYSTEM,
  buildForecastUser,
  ForecastQueryOutput,
} from './prompts/forecastPrompt';
import {
  QUALITY_ALERT_SYSTEM,
  buildQualityAlertUser,
  QualityAlertInput,
} from './prompts/qualityAlertPrompt';
import {
  EXPLAIN_WIDGET_SYSTEM,
  buildExplainWidgetUser,
  INSIGHTS_SYSTEM,
  buildInsightsUser,
  WidgetSummary,
} from './prompts/insightsPrompt';
import {
  INVESTIGATE_PLAN_SYSTEM,
  buildInvestigatePlanUser,
  INVESTIGATE_SYNTHESIZE_SYSTEM,
  buildInvestigateSynthesizeUser,
  DiagnosticResult,
} from './prompts/investigatePrompt';
import {
  NARRATE_SYSTEM,
  buildNarrateUser,
  NarrativeOutput,
  WidgetNarrativeInput,
} from './prompts/narratePrompt';
import {
  PRODUCT_ICON_SYSTEM,
  buildProductIconUser,
} from './prompts/productIconPrompt';

// ---------------------------------------------------------------------------
// SQL dialect type — used to select the correct prompt variant
// ---------------------------------------------------------------------------
export type SqlDialect = 'sqlite' | 'duckdb';

import { logger } from '../utils/logger';
import { trackMetric, trackEvent } from '../utils/monitoring';
import {
  getTenantAiContext,
  checkTenantAiBudget,
  recordTenantAiUsage,
  AiBudgetExceededError,
} from '../services/aiBudget';
import { logAiCall } from '../services/aiCallLogger';
import { getGlossaryPromptBlock } from '../services/glossaryContext';
import { pickBackend, callAzureBackend, type AiCallKind } from '../services/ai/router';

/**
 * Load the tenant-wide business glossary block for inclusion in AI prompts.
 * Returns "" when there's no tenant context (CLI scripts, workers without
 * the wrapper) or when the glossary is empty. Failures are non-fatal —
 * losing the glossary should never break a query.
 */
async function loadGlossaryBlock(): Promise<string> {
  const tenantId = getTenantAiContext();
  if (!tenantId) return '';
  try {
    return await getGlossaryPromptBlock(tenantId);
  } catch (err) {
    logger.warn({ err }, 'Failed to load business glossary for AI prompt');
    return '';
  }
}

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

// Lazy singleton — created on first use.
// If the key still isn't in the environment by then (dotenv path resolution
// can be tricky in git worktrees), we make one more attempt from process.cwd()
// which is always the `backend/` directory when running `npm run dev`.
let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      dotenv.config({ path: path.resolve(process.cwd(), '../.env'), override: true });
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';
/** Cheaper model for summarisation-class calls (formatAnswer, validateQueryResult). ~12× cheaper than Sonnet. */
const MODEL_HAIKU = process.env.CLAUDE_MODEL_HAIKU ?? 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000]; // ms — exponential-ish backoff

/**
 * Check the tenant AI budget BEFORE a Claude call. Throws
 * AiBudgetExceededError if this tenant has hit its monthly cap. No-ops when
 * there's no tenant context (CLI scripts, workers that didn't opt in).
 */
async function enforceAiBudget(callLabel: string): Promise<number | null> {
  const tenantId = getTenantAiContext();
  if (!tenantId) return null;
  const status = await checkTenantAiBudget(tenantId);
  if (!status.allowed) {
    trackEvent('ai_budget_blocked', { tenantId: String(tenantId), callLabel, used: String(status.used), budget: String(status.budget ?? -1) });
    throw new AiBudgetExceededError(tenantId, status.used, status.budget ?? 0);
  }
  return tenantId;
}

interface CallClaudeOptions {
  /** Max output tokens. Default 4096. */
  maxTokens?: number;
  /** Telemetry label. Auto-derived from system prompt if omitted. */
  callLabel?: string;
  /**
   * Mark the system prompt as cacheable via Anthropic prompt caching.
   * When true the system content is wrapped in a `cache_control: ephemeral`
   * block so identical system prompts across calls re-use a cached version
   * at 10% of normal input cost. Anthropic requires ≥1024 tokens of stable
   * content to cache — our system prompts clear that comfortably.
   * Callers should set this to true for stable prompts (NL→SQL, dashboard,
   * star schema) and false for dynamic one-shot prompts.
   */
  cacheSystem?: boolean;
  /** Override the model — e.g. Haiku for summarisation-class calls. */
  model?: string;
  /**
   * Sampling temperature (0–1). Default = Anthropic's default (1).
   * Set to 0 for structured/deterministic calls (NL→SQL, validation,
   * SQL-emitting refinement) so the same input always returns the
   * same output. Leave default for prose calls (formatAnswer, brief,
   * starters) where variety is desirable.
   */
  temperature?: number;
  /**
   * Privacy classification of the prompt. Drives the tenant-level
   * Claude/Hybrid/Azure routing toggle. Defaults to 'schema' (safe
   * for any backend). Set to 'row' for any call that includes
   * customer row data in the prompt — insights, narration, format
   * answer, explain widget, schema sample values, investigation
   * step summaries, etc. In 'hybrid' mode those route to Azure
   * Foundry; everything else stays on Claude.
   */
  kind?: AiCallKind;
}

async function callClaude(
  systemPrompt: string,
  userPrompt: string,
  optsOrMaxTokens: CallClaudeOptions | number = {},
  legacyCallLabel?: string,
): Promise<string> {
  // Backwards compat: old signature was (system, user, maxTokens, callLabel)
  const opts: CallClaudeOptions = typeof optsOrMaxTokens === 'number'
    ? { maxTokens: optsOrMaxTokens, callLabel: legacyCallLabel }
    : optsOrMaxTokens;

  const maxTokens = opts.maxTokens ?? 4096;
  const model     = opts.model ?? MODEL;
  let callLabel   = opts.callLabel;
  if (!callLabel) callLabel = systemPrompt.slice(0, 60).replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').toLowerCase();

  // Build system parameter: plain string (default) or cacheable content array.
  const systemParam = opts.cacheSystem
    ? [{ type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } }]
    : systemPrompt;

  // Per-tenant budget gate (throws AiBudgetExceededError if capped).
  const tenantId = await enforceAiBudget(callLabel);

  // ── AI backend router (Phase B.1) ──────────────────────────────────────
  // Tenant-level Claude/Hybrid/Azure toggle. If the tenant has opted
  // into Azure for this call's `kind`, route to Foundry. On ANY Azure
  // failure (network, 5xx, malformed response) we silently fall back
  // to the Claude path below — never let a misconfigured Foundry break
  // the user-facing AI.
  const callKind: AiCallKind = opts.kind ?? 'schema';
  const backend = await pickBackend({ kind: callKind, tenantId: tenantId ?? undefined });
  if (backend === 'azure') {
    const azureStart = Date.now();
    try {
      const result = await callAzureBackend({
        kind:         callKind,
        tenantId:     tenantId ?? undefined,
        systemPrompt,
        userPrompt,
        maxTokens,
        temperature:  opts.temperature,
      });
      const durationMs = Date.now() - azureStart;
      const props = { callLabel, model: 'azure-foundry', attempt: '1' };
      trackMetric('ai_call_duration_ms', durationMs, props);
      trackMetric('ai_input_tokens',     result.inputTokens,  props);
      trackMetric('ai_output_tokens',    result.outputTokens, props);
      trackMetric('ai_total_tokens',     result.inputTokens + result.outputTokens, props);
      logger.info({ callLabel, backend: 'azure', durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, 'AI call completed via Azure');
      if (tenantId) recordTenantAiUsage(tenantId, result.inputTokens, result.outputTokens).catch(() => { /* noop */ });
      logAiCall({
        callLabel: callLabel!,
        model: 'azure-foundry',
        inputTokens:  result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs,
      });
      return result.text;
    } catch (err) {
      // Fall through to the Claude path below. The router already
      // logged the failure with context.
      logger.warn({ callLabel, err: err instanceof Error ? err.message : String(err) }, 'azure backend failed; falling back to Claude');
    }
  }

  const start = Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: userPrompt }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        system: systemParam as any,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });

      const block = message.content[0];
      if (block.type !== 'text') {
        throw new Error('AIService: unexpected non-text response from Claude');
      }

      // Track AI call metrics, including cache hit/miss breakdown.
      const durationMs = Date.now() - start;
      const inputTokens  = message.usage?.input_tokens  ?? 0;
      const outputTokens = message.usage?.output_tokens ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usage: any = message.usage ?? {};
      const cacheReadTokens     = usage.cache_read_input_tokens     ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      const props = { callLabel, model, attempt: String(attempt + 1) };
      trackMetric('ai_call_duration_ms', durationMs, props);
      trackMetric('ai_input_tokens',     inputTokens, props);
      trackMetric('ai_output_tokens',    outputTokens, props);
      trackMetric('ai_total_tokens',     inputTokens + outputTokens, props);
      if (cacheReadTokens > 0)     trackMetric('ai_cache_read_tokens',     cacheReadTokens, props);
      if (cacheCreationTokens > 0) trackMetric('ai_cache_creation_tokens', cacheCreationTokens, props);
      logger.info({
        callLabel, model, durationMs, inputTokens, outputTokens,
        cacheReadTokens, cacheCreationTokens, attempt: attempt + 1,
      }, 'AI call completed');

      // Record against the tenant's monthly budget (best-effort, never throws).
      if (tenantId) {
        recordTenantAiUsage(tenantId, inputTokens, outputTokens).catch(() => { /* logged inside */ });
      }

      // Per-call telemetry → ai_call_log (fire-and-forget, fuels the
      // /admin/ai-usage dashboard). Distinct from the monthly rollup
      // above — this captures attribution + cost for slicing by
      // category / user / call type.
      logAiCall({
        callLabel: callLabel!,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        durationMs,
      });

      return block.text;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const isRetryable = status === 529 || status === 503 || status === 500 || status === 429;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] ?? 10000;
        logger.warn({ callLabel, status, attempt: attempt + 1, retryIn: delay }, 'AI call retrying');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const durationMs = Date.now() - start;
      logger.error({ callLabel, model, status, durationMs, err }, 'AI call failed');
      trackEvent('ai_call_failed', { callLabel, model, status: String(status ?? 'unknown'), durationMs: String(durationMs) });
      logAiCall({
        callLabel: callLabel!,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs,
        failed: true,
        errorCode: status ? String(status) : 'error',
      });
      // Specifically tag the "your credit balance is too low" 400 from
      // Anthropic so callers in the refresh path can distinguish a real
      // SQL bug from a billing situation. Without this, the dock shows
      // the raw API JSON which looks like an internal error.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (status === 400 && /credit balance|too low to access|purchase credits/i.test(errMsg)) {
        throw new AiCreditExhaustedError(errMsg);
      }
      throw err;
    }
  }
  throw new Error('AIService: exhausted retries');
}

/**
 * Thrown when the upstream provider says the account is out of credits.
 * Refresh-path callers catch this specifically and produce a clear
 * user-facing message ("AI repair skipped — Anthropic credits exhausted")
 * instead of leaking provider JSON into the dock.
 */
export class AiCreditExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiCreditExhaustedError';
  }
}

// Streaming version of callClaude — uses streaming API to avoid SDK timeout for large responses
// but collects the full text and returns it as a string (no event callbacks).
async function callClaudeStreaming(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
  callLabel?: string,
  cacheSystem = true,
  temperature?: number,
): Promise<string> {
  if (!callLabel) callLabel = 'stream_' + systemPrompt.slice(0, 50).replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').toLowerCase();
  const tenantId = await enforceAiBudget(callLabel);
  const start = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: maxTokens,
    system: cacheSystem
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    ...(temperature !== undefined ? { temperature } : {}),
  };

  const stream = getClient().messages.stream(params);
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (event as any).delta as Record<string, unknown>;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        fullText += delta.text;
      }
    }
  }

  const durationMs = Date.now() - start;
  const props = { callLabel, model: MODEL, streaming: 'true' };
  trackMetric('ai_call_duration_ms', durationMs, props);

  // Usage attribution for streaming: the final message on the stream
  // carries the complete usage object. Record best-effort.
  try {
    const final = await stream.finalMessage();
    const inputTokens  = final.usage?.input_tokens  ?? 0;
    const outputTokens = final.usage?.output_tokens ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage: any = final.usage ?? {};
    const cacheReadTokens     = usage.cache_read_input_tokens     ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    trackMetric('ai_input_tokens',  inputTokens,  props);
    trackMetric('ai_output_tokens', outputTokens, props);
    if (tenantId) {
      recordTenantAiUsage(tenantId, inputTokens, outputTokens).catch(() => { /* logged inside */ });
    }
    logAiCall({
      callLabel: callLabel!,
      model: MODEL,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      durationMs,
    });
    logger.info({ callLabel, durationMs, outputChars: fullText.length, inputTokens, outputTokens, streaming: true }, 'AI streaming call completed');
  } catch {
    logger.info({ callLabel, durationMs, outputChars: fullText.length, streaming: true }, 'AI streaming call completed (usage unavailable)');
  }

  return fullText;
}

// Multi-turn version — used by the repair loop where Claude sees its own previous replies
export async function callClaudeMultiTurn(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { temperature?: number } = {},
): Promise<string> {
  const tenantId = await enforceAiBudget('multi_turn');
  const start = Date.now();
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    throw new Error('AIService: unexpected non-text response from Claude');
  }

  const inputTokens  = message.usage?.input_tokens  ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage: any = message.usage ?? {};
  const cacheReadTokens     = usage.cache_read_input_tokens     ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

  if (tenantId) {
    recordTenantAiUsage(tenantId, inputTokens, outputTokens).catch(() => { /* logged inside */ });
  }
  logAiCall({
    callLabel: 'multi_turn',
    model: MODEL,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    durationMs: Date.now() - start,
  });

  return block.text;
}

function parseJson<T>(raw: string): T {
  // Strip markdown code fences if Claude wraps the JSON
  let cleaned = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  // When extended thinking is on Claude sometimes emits prose before/after the JSON
  // object. Find the outermost { ... } and use only that.
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned) as T;
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets, braces, and strings.
 * Returns the repaired string or null if it can't be salvaged.
 */
function repairTruncatedJson(raw: string): string | null {
  // Strip markdown fences
  let text = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  const start = text.indexOf('{');
  if (start === -1) return null;
  text = text.slice(start);

  // Remove any trailing incomplete value (partial string, number, etc.)
  // Trim back to the last complete structure delimiter
  text = text.replace(/,\s*"[^"]*$/, '');         // trailing key without value
  text = text.replace(/,\s*$/, '');                // trailing comma
  text = text.replace(/:\s*"[^"]*$/, ': null');    // trailing incomplete string value
  text = text.replace(/:\s*-?[0-9]*\.?[0-9]*$/, ': null'); // trailing incomplete number

  // Count unclosed brackets and braces
  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
  }

  // If we're inside an unclosed string, close it
  if (inString) text += '"';

  // Close all unclosed brackets/braces in reverse order
  while (stack.length) {
    const open = stack.pop();
    text += open === '{' ? '}' : ']';
  }

  return text;
}

// ---------------------------------------------------------------------------
// Call Type 1 — Schema Draft
// ---------------------------------------------------------------------------

/**
 * Generate schema draft in batches of BATCH_SIZE tables to avoid token limit
 * truncation. Each batch produces a partial SchemaDraftOutput; results are merged.
 * Calls onProgress(tableName) after each batch so callers can report status.
 */
// Adaptive batch sizing.
// Each table contributes ~1 table description + N column descriptions to the
// JSON output. Empirically a column entry runs ~150 chars (≈40 tokens), so we
// budget by total columns rather than table count: at ~150 cols per batch the
// expected output stays under ~7K output tokens, well below the 16K maxTokens
// cap, and leaves headroom for the formatter and extra fields.
//
// History: a fixed BATCH_SIZE=3 was unreliable on wide schemas (e.g. ExactOnline
// Accounts has 163 cols — a 3-table batch generated >50KB of JSON that
// truncated mid-stream). Switching to column-budgeted batches handles both
// narrow seed-data schemas (still packs many tables per call) and wide real
// schemas (one table per call when needed) without manual tuning.
// Empirical cap — at 150 cols per call, real-world schemas (e.g. ExactOnline's
// 163-column Accounts) hit the 16k output token cap and produced truncated JSON.
// 60 keeps the output comfortably under cap with headroom for richer descriptions.
const COLUMNS_PER_BATCH = 60;

function buildDraftBatches(tables: TableInfo[]): TableInfo[][] {
  const batches: TableInfo[][] = [];
  let current: TableInfo[] = [];
  let currentCols = 0;
  for (const t of tables) {
    const cols = t.columns?.length ?? 0;
    // A single table that exceeds the budget always gets its own batch.
    if (cols >= COLUMNS_PER_BATCH) {
      if (current.length) batches.push(current);
      batches.push([t]);
      current = [];
      currentCols = 0;
      continue;
    }
    if (current.length && currentCols + cols > COLUMNS_PER_BATCH) {
      batches.push(current);
      current = [];
      currentCols = 0;
    }
    current.push(t);
    currentCols += cols;
  }
  if (current.length) batches.push(current);
  return batches;
}

export async function generateSchemaDraft(
  sourceType: string,
  tables: TableInfo[],
  qualityStats?: TableQualityStat[],
  fkCandidates?: FkCandidate[],
  onProgress?: (tableNames: string[], batchIndex: number, totalBatches: number) => void,
): Promise<SchemaDraftOutput> {
  const merged: SchemaDraftOutput = { tables: [], columns: [] };
  const batches = buildDraftBatches(tables);

  const glossary = await loadGlossaryBlock();

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const partial = await draftOneBatch(sourceType, batch, qualityStats, fkCandidates, glossary, bi, batches.length, onProgress);
    merged.tables.push(...partial.tables);
    merged.columns.push(...partial.columns);
  }
  return merged;
}

/**
 * Draft a single batch with one-level fallback: if Claude truncates the
 * response (manifests as `parseJson` throwing SyntaxError), recursively
 * split the batch in half and retry. Never gives up entirely on a batch —
 * worst case, single-table batches eventually succeed.
 *
 * Triggered by EO real-world schemas where some tables produced richer
 * output than the static `COLUMNS_PER_BATCH` budget anticipated. The
 * recursive split makes the profiler resilient without us having to
 * hand-tune the batch size for every customer's schema shape.
 */
async function draftOneBatch(
  sourceType: string,
  batch: TableInfo[],
  qualityStats: TableQualityStat[] | undefined,
  fkCandidates: FkCandidate[] | undefined,
  glossary: string,
  bi: number,
  totalBatches: number,
  onProgress?: (tableNames: string[], batchIndex: number, totalBatches: number) => void,
): Promise<SchemaDraftOutput> {
  const batchStats = qualityStats?.filter((s) => batch.some((t) => t.tableName === s.table_name));
  onProgress?.(batch.map((t) => t.tableName), bi, totalBatches);

  const raw = await callClaude(
    SCHEMA_DRAFT_SYSTEM,
    buildSchemaDraftUser(sourceType, batch, batchStats, fkCandidates, glossary),
    { maxTokens: 16000, cacheSystem: true, kind: 'row' },
  );
  try {
    return parseJson<SchemaDraftOutput>(raw);
  } catch (err) {
    // Truncated / malformed JSON usually means Claude hit the output cap.
    // Halve the batch and retry. A 1-table batch that still truncates
    // bubbles up — at that point the table is genuinely too wide for
    // a single Claude call and a different strategy is needed.
    if (batch.length === 1) throw err;
    // eslint-disable-next-line no-console
    console.warn(`[AIService] schema draft JSON parse failed for ${batch.length}-table batch; splitting and retrying`, err instanceof Error ? err.message : err);
    const mid = Math.ceil(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);
    const merged: SchemaDraftOutput = { tables: [], columns: [] };
    for (const sub of [left, right]) {
      const part = await draftOneBatch(sourceType, sub, qualityStats, fkCandidates, glossary, bi, totalBatches, onProgress);
      merged.tables.push(...part.tables);
      merged.columns.push(...part.columns);
    }
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Three-pass schema profiling (replaces generateSchemaDraft for the new pipeline)
// ---------------------------------------------------------------------------
// Pass 1 — detectSchemaConventions: Haiku-grade question. Cheap, single call,
// output drives the next two prompts.
// ---------------------------------------------------------------------------

export async function detectSchemaConventions(
  sourceSystem: string | null,
  tables: TableInfo[],
): Promise<SchemaConventions | null> {
  if (tables.length === 0) return null;
  try {
    const raw = await callClaude(
      SCHEMA_CONVENTIONS_SYSTEM,
      buildConventionsUser(sourceSystem, tables),
      // temperature 0: convention detection is structured classification.
      { maxTokens: 1500, model: MODEL_HAIKU, callLabel: 'schema_conventions', temperature: 0 },
    );
    return parseJson<SchemaConventions>(raw);
  } catch (err) {
    console.warn('[AIService] detectSchemaConventions failed (non-fatal):', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — generateTableContext: ONE call, all tables, infers descriptions +
// relationships. Column descriptions come in Pass 3.
// ---------------------------------------------------------------------------

export async function generateTableContext(
  sourceSystem: string | null,
  conventions: SchemaConventions | null,
  tables: TableInfo[],
  qualityStats: TableQualityStat[],
  fkCandidates: FkCandidateLike[],
): Promise<TableContextOutput> {
  const glossary = await loadGlossaryBlock();
  const raw = await callClaude(
    TABLE_CONTEXT_SYSTEM,
    buildTableContextUser(sourceSystem, conventions, tables, qualityStats, fkCandidates, glossary),
    { maxTokens: 8000, cacheSystem: true, callLabel: 'table_context' },
  );
  return parseJson<TableContextOutput>(raw);
}

// ---------------------------------------------------------------------------
// Pass 3 — generateColumnDescriptions: per-batch, with table+relationship
// context. Same column-budget batching as the legacy schema draft.
// ---------------------------------------------------------------------------

export async function generateColumnDescriptions(
  sourceSystem: string | null,
  tableContext: TableContextOutput,
  tables: TableInfo[],
  qualityStats: TableQualityStat[],
  onProgress?: (tableNames: string[], batchIndex: number, totalBatches: number) => void,
): Promise<ColumnDescriptionsOutput> {
  const glossary = await loadGlossaryBlock();
  const batches = buildDraftBatches(tables);
  const merged: ColumnDescriptionsOutput = { columns: [] };

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchStats = qualityStats.filter((s) => batch.some((t) => t.tableName === s.table_name));
    onProgress?.(batch.map((t) => t.tableName), bi, batches.length);
    try {
      const raw = await callClaude(
        COLUMN_DESCRIPTIONS_SYSTEM,
        buildColumnDescriptionsUser(sourceSystem, tableContext, batch, batchStats, glossary),
        { maxTokens: 16000, cacheSystem: true, callLabel: 'column_descriptions', kind: 'row' },
      );
      const part = parseJson<ColumnDescriptionsOutput>(raw);
      merged.columns.push(...part.columns);
    } catch (err) {
      // If the batch is too wide and Claude truncates, fall back to halving.
      // Reuse the same recursive split as draftOneBatch.
      if (batch.length === 1) {
        console.warn(`[AIService] column descriptions failed for single-table batch ${batch[0].tableName}:`, err);
        continue;
      }
      console.warn(`[AIService] column descriptions JSON parse failed for ${batch.length}-table batch; splitting`);
      const mid = Math.ceil(batch.length / 2);
      for (const sub of [batch.slice(0, mid), batch.slice(mid)]) {
        const sub2Stats = qualityStats.filter((s) => sub.some((t) => t.tableName === s.table_name));
        try {
          const raw = await callClaude(
            COLUMN_DESCRIPTIONS_SYSTEM,
            buildColumnDescriptionsUser(sourceSystem, tableContext, sub, sub2Stats, glossary),
            { maxTokens: 16000, cacheSystem: true, callLabel: 'column_descriptions', kind: 'row' },
          );
          const part = parseJson<ColumnDescriptionsOutput>(raw);
          merged.columns.push(...part.columns);
        } catch (err2) {
          console.warn(`[AIService] column descriptions sub-batch failed:`, err2);
        }
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Relationship Re-Suggest — uses full semantic context
// ---------------------------------------------------------------------------

export async function suggestRelationships(
  ctx: SemanticContext,
): Promise<RelationshipSuggestOutput> {
  const raw = await callClaude(
    RELATIONSHIP_SUGGEST_SYSTEM,
    buildRelationshipSuggestUser(ctx),
    // temperature 0: relationship inference is structured pattern matching.
    { maxTokens: 8000, cacheSystem: true, temperature: 0 },
  );
  return parseJson<RelationshipSuggestOutput>(raw);
}

// ---------------------------------------------------------------------------
// AI-assisted FK suggestion — for unmatched key columns
// ---------------------------------------------------------------------------

export interface AiFkSuggestion {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  reasoning: string;
}

const FK_SUGGESTION_SYSTEM = `You are a database relationship expert. Given:
1. A list of UNMATCHED KEY COLUMNS from fact/transaction tables (with sample values)
2. A list of DIMENSION/REFERENCE tables with their columns and sample values

Your job: identify which unmatched fact columns are business keys that JOIN to which dimension table columns.

Rules:
- Only suggest relationships where you are reasonably confident the values would match
- Use domain knowledge: korting_code likely joins to a kortingen/discounts table, leverancier_id to a leveranciers/suppliers table, etc.
- Consider sample values — if values look like codes, IDs, or references, they likely join somewhere
- If a column has no plausible target dimension, do NOT force a match — skip it
- Each suggestion must specify BOTH the from and to column names exactly as given

Return JSON only:
{
  "suggestions": [
    { "from_table": "orders", "from_column": "korting_code", "to_table": "kortingen", "to_column": "code", "reasoning": "korting_code contains discount codes that reference the kortingen lookup table" }
  ]
}

If no suggestions, return: { "suggestions": [] }`;

export async function suggestFkMatches(
  unmatchedColumns: { table: string; column: string; sampleValues: unknown[] }[],
  dimensionTables: { tableName: string; columns: { name: string; sampleValues: unknown[] }[]; role: string }[],
): Promise<AiFkSuggestion[]> {
  if (unmatchedColumns.length === 0) return [];

  const userPrompt = `UNMATCHED KEY COLUMNS from fact/transaction tables:
${unmatchedColumns.map((c) => `  ${c.table}.${c.column} — samples: ${JSON.stringify(c.sampleValues.slice(0, 5))}`).join('\n')}

DIMENSION/REFERENCE tables:
${dimensionTables.map((t) => `  ${t.tableName} (${t.role}): columns = ${t.columns.map((c) => `${c.name} [${JSON.stringify(c.sampleValues.slice(0, 3))}]`).join(', ')}`).join('\n')}

Which unmatched columns are business keys to which dimension columns?`;

  console.log(`[FK AI] Asking Claude to match ${unmatchedColumns.length} unmatched key column(s) against ${dimensionTables.length} dimension table(s)…`);
  try {
    // temperature 0: same unmatched columns + dimension tables → same FK suggestions.
    const raw = await callClaude(FK_SUGGESTION_SYSTEM, userPrompt, { maxTokens: 4096, temperature: 0, kind: 'row' });
    const result = parseJson<{ suggestions: AiFkSuggestion[] }>(raw);
    console.log(`[FK AI] Claude suggested ${result.suggestions.length} match(es):`);
    for (const s of result.suggestions) {
      console.log(`[FK AI]   ${s.from_table}.${s.from_column} → ${s.to_table}.${s.to_column}: ${s.reasoning}`);
    }
    return result.suggestions;
  } catch (err) {
    console.warn('[FK AI] suggestion call failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entity extraction — keyword-based, no API call
// Matches question tokens against table/column names and display names.
// ---------------------------------------------------------------------------

export function extractEntitiesFromQuestion(
  question: string,
  catalog: { tableName: string; displayName: string; columnNames: string[] }[],
): string[] {
  const q = question.toLowerCase();
  const tokens = q.split(/\s+/).filter((w) => w.length > 2);
  const matched = new Set<string>();

  for (const entry of catalog) {
    const tn = entry.tableName.toLowerCase();
    const dn = (entry.displayName ?? '').toLowerCase();
    // Match table name (with underscore→space variants) or display name
    const tnWords = tn.replace(/_/g, ' ');
    // Simple singular/plural: if question has "order" match table "orders" and vice versa
    const tnVariants = [tn, tnWords, tn.replace(/s$/, ''), tn + 's', tnWords.replace(/s$/, ''), tnWords + 's'];
    const dnVariants = dn ? [dn, dn.replace(/s$/, ''), dn + 's'] : [];

    for (const variant of [...tnVariants, ...dnVariants]) {
      if (variant && q.includes(variant)) {
        matched.add(entry.tableName);
        break;
      }
    }

    // Also match column names (less weight — only if token is an exact column name)
    for (const col of entry.columnNames) {
      const colLower = col.toLowerCase();
      const colWords = colLower.replace(/_/g, ' ');
      if (tokens.includes(colLower) || q.includes(colWords)) {
        matched.add(entry.tableName);
        break;
      }
    }
  }
  return [...matched];
}

// ---------------------------------------------------------------------------
// Call Type 2a — Natural Language → SQL + confidence score
// ---------------------------------------------------------------------------

function defaultSubScores(parsed: Record<string, unknown>): NlToSqlOutput {
  const intentRaw = parsed.intent as string | undefined;
  const intent: 'data' | 'explain' | 'clarify' =
    intentRaw === 'explain' ? 'explain'
    : intentRaw === 'clarify' ? 'clarify'
    : 'data';
  // For non-data intents, the model gives no SQL; default confidence to 1 so
  // it bypasses the low-confidence gate (we're not executing anything anyway).
  const confidence = (parsed.confidence as number | undefined)
    ?? (intent !== 'data' ? 1 : 0);
  const viz = parsed.visualization as Record<string, unknown> | undefined;

  // Defensive parsing of assumption + clarify fields. The model occasionally
  // returns a single string instead of an array — coerce.
  const rawAssumptions = parsed.assumptions;
  const assumptions: string[] = Array.isArray(rawAssumptions)
    ? rawAssumptions.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
    : (typeof rawAssumptions === 'string' && rawAssumptions.trim() ? [rawAssumptions.trim()] : []);

  const rawOptions = parsed.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .filter((o): o is Record<string, unknown> => o != null && typeof o === 'object')
        .map((o) => ({
          label:          typeof o.label === 'string' ? o.label : '',
          interpretation: typeof o.interpretation === 'string' ? o.interpretation : '',
        }))
        .filter((o) => o.label && o.interpretation)
    : [];

  return {
    intent,
    explanation:         parsed.explanation as string | undefined,
    sql:                 (parsed.sql as string) ?? '',
    confidence,
    schema_confidence:   (parsed.schema_confidence as number)   ?? confidence,
    join_confidence:     (parsed.join_confidence as number)     ?? confidence,
    formula_confidence:  (parsed.formula_confidence as number)  ?? confidence,
    uncertainty_notes:   (parsed.uncertainty_notes as string[]) ?? [],
    tables_used:         (parsed.tables_used as string[]) ?? [],
    assumptions,
    ...(intent === 'clarify' ? {
      ambiguity: typeof parsed.ambiguity === 'string' ? parsed.ambiguity : '',
      options,
    } : {}),
    ...(viz && typeof viz.type === 'string' ? {
      visualization: {
        type: viz.type as 'bar' | 'line' | 'stacked_bar' | 'pie' | 'table',
        xKey: viz.xKey as string | undefined,
        yKey: viz.yKey as string | undefined,
        groupBy: viz.groupBy as string | undefined,
      },
    } : {}),
  };
}

const currentDateStr = () => new Date().toISOString().slice(0, 10);

export async function generateSql(
  question: string,
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
  dialect: SqlDialect = 'sqlite',
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<NlToSqlOutput> {
  const glossary = await loadGlossaryBlock();
  const systemPrompt = dialect === 'duckdb'
    ? NL_TO_SQL_DUCKDB_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), glossary)
    : NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), glossary);

  // If conversation history is provided, use multi-turn messages for follow-up context
  if (conversationHistory && conversationHistory.length > 0) {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...conversationHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: buildNlToSqlUser(question) },
    ];
    const raw = await callClaudeMultiTurn(systemPrompt, messages, { temperature: 0 });
    return defaultSubScores(parseJson<Record<string, unknown>>(raw));
  }

  // cacheSystem: the NL→SQL system prompt embeds the full semantic context
  // + relationship context + KPI formulas — identical across back-to-back
  // questions from the same tenant. Cache hit rate here is very high.
  // temperature 0: deterministic SQL — same question yields same SQL.
  const raw = await callClaude(systemPrompt, buildNlToSqlUser(question), { cacheSystem: true, temperature: 0 });
  return defaultSubScores(parseJson<Record<string, unknown>>(raw));
}

// ---------------------------------------------------------------------------
// Call Type 2c — Result sanity check
// Lightweight: runs fast, failure is non-blocking (returns a warning, not an error)
// Uses Haiku: this is a summarisation/classification task over small rows —
// frontier quality not required, and the call runs on every query.
// ---------------------------------------------------------------------------

export async function validateQueryResult(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
): Promise<ResultValidationOutput> {
  try {
    const raw = await callClaude(
      RESULT_VALIDATION_SYSTEM,
      buildResultValidationUser(question, sql, rows, rows.length),
      // temperature 0: validator should give the same verdict on the same evidence.
      { model: MODEL_HAIKU, cacheSystem: true, temperature: 0, kind: 'row' },
    );
    return parseJson<ResultValidationOutput>(raw);
  } catch {
    // Validation is best-effort — never let it break a successful query response
    return { ok: true };
  }
}

/**
 * Confidence-gated wrapper around validateQueryResult.
 *
 * When Claude is already ≥ 0.9 confident in the SQL, the second sanity-check
 * call rarely finds anything — skipping saves an API round-trip (and a
 * Haiku call's cost) on every high-confidence query. Below the threshold
 * we still run the validator because that's exactly where it earns its keep.
 *
 * Returns a synthetic `{ ok: true }` on skip so downstream code doesn't
 * need to branch.
 */
export async function validateQueryResultIfNeeded(
  confidence: number,
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  skipThreshold = 0.9,
): Promise<ResultValidationOutput> {
  if (confidence >= skipThreshold) {
    trackEvent('ai_validation_skipped', { reason: 'high_confidence', threshold: String(skipThreshold) });
    return { ok: true };
  }
  return validateQueryResult(question, sql, rows);
}

// ---------------------------------------------------------------------------
// Cross-source variant of Call Type 2a
// ---------------------------------------------------------------------------

export async function generateCrossSourceSql(
  question: string,
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
  dialect: SqlDialect = 'sqlite',
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<NlToSqlOutput> {
  const glossary = await loadGlossaryBlock();
  const systemPrompt = dialect === 'duckdb'
    ? NL_TO_SQL_CROSS_DUCKDB_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), glossary)
    : NL_TO_SQL_CROSS_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), glossary);

  if (conversationHistory && conversationHistory.length > 0) {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...conversationHistory.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: buildNlToSqlCrossUser(question) },
    ];
    const raw = await callClaudeMultiTurn(systemPrompt, messages, { temperature: 0 });
    return defaultSubScores(parseJson<Record<string, unknown>>(raw));
  }

  // Cross-source system prompt is stable per tenant — cache same as single-source.
  // temperature 0: deterministic SQL.
  const raw = await callClaude(systemPrompt, buildNlToSqlCrossUser(question), { cacheSystem: true, temperature: 0 });
  return defaultSubScores(parseJson<Record<string, unknown>>(raw));
}

// ---------------------------------------------------------------------------
// Call Type 2a (streaming) — NL → SQL with extended thinking tokens live
// Calls Claude with budget_tokens of thinking; fires onEvent for each delta
// so the caller (SSE route) can stream them to the browser in real time.
// ---------------------------------------------------------------------------

export async function generateSqlStreaming(
  question: string,
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
  onEvent: (type: 'thinking' | 'text', delta: string) => void,
  dialect: SqlDialect = 'sqlite',
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<NlToSqlOutput> {
  const tenantId = await enforceAiBudget('generate_sql_streaming');
  const streamCallLabel = 'generate_sql_streaming';
  const streamStart = Date.now();
  const glossary = await loadGlossaryBlock();
  const systemPrompt = dialect === 'duckdb'
    ? NL_TO_SQL_DUCKDB_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), glossary)
    : NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), glossary);

  // Build messages array — prepend conversation history if available
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (conversationHistory && conversationHistory.length > 0) {
    for (const m of conversationHistory) {
      messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }
  }
  messages.push({ role: 'user', content: buildNlToSqlUser(question) });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    // cache_control on the NL→SQL system prompt — same big context that's
    // stable across all questions from a tenant.
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  };

  const stream = getClient().messages.stream(params);
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (event as any).delta as Record<string, unknown>;
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent('thinking', delta.thinking);
      } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        fullText += delta.text;
        onEvent('text', delta.text);
      }
    }
  }

  try {
    const final = await stream.finalMessage();
    const inputTokens  = final.usage?.input_tokens  ?? 0;
    const outputTokens = final.usage?.output_tokens ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage: any = final.usage ?? {};
    const cacheReadTokens     = usage.cache_read_input_tokens     ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    if (tenantId) {
      recordTenantAiUsage(tenantId, inputTokens, outputTokens).catch(() => { /* logged inside */ });
    }
    logAiCall({
      callLabel: streamCallLabel,
      model: MODEL,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      durationMs: Date.now() - streamStart,
    });
  } catch { /* usage attribution is best-effort for streaming */ }

  return defaultSubScores(parseJson<Record<string, unknown>>(fullText));
}

// ---------------------------------------------------------------------------
// Call Type 2b — Format query result as plain-language answer
// ---------------------------------------------------------------------------

export async function formatAnswer(
  question: string,
  rows: Record<string, unknown>[],
): Promise<string> {
  // Haiku: summarisation of query results into 1–3 plain sentences doesn't
  // need frontier-model quality; Haiku is ~12× cheaper and runs on every
  // successful query. cacheSystem: the ANSWER_FORMAT_SYSTEM prompt is a
  // small stable string — marginal caching value but zero downside.
  return callClaude(
    ANSWER_FORMAT_SYSTEM,
    buildAnswerFormatUser(question, rows),
    { model: MODEL_HAIKU, cacheSystem: true, kind: 'row' },
  );
}

// ---------------------------------------------------------------------------
// Call Type 3 — Report Narrative
// ---------------------------------------------------------------------------

export async function generateReportNarrative(
  title: string,
  period: string,
  kpiResults: KpiResult[],
): Promise<string> {
  return callClaude(
    REPORT_NARRATIVE_SYSTEM,
    buildReportNarrativeUser(title, period, kpiResults),
    { kind: 'row' },
  );
}

// ---------------------------------------------------------------------------
// Dashboard refinement — clarifying questions before generation
// ---------------------------------------------------------------------------

export async function generateDashboardRefinement(
  request: string,
  semanticContext: string,
  relationshipContext: string,
): Promise<RefinementOutput> {
  const glossary = await loadGlossaryBlock();
  const raw = await callClaude(
    REFINEMENT_SYSTEM,
    buildRefinementUser(request, semanticContext, relationshipContext, glossary),
    { cacheSystem: true },
  );
  return parseJson<RefinementOutput>(raw);
}

// ---------------------------------------------------------------------------
// Dashboard spec refinement — edits an existing spec based on user feedback
// ---------------------------------------------------------------------------

export async function refineDashboardSpec(
  refinement: string,
  currentSpec: DashboardSpec,
  semanticContext: string,
  relationshipContext: string,
): Promise<DashboardSpec> {
  const glossary = await loadGlossaryBlock();
  const raw = await callClaude(
    REFINE_SPEC_SYSTEM,
    buildRefineSpecUser(refinement, currentSpec, semanticContext, relationshipContext, glossary),
    // temperature 0: deterministic spec edits.
    { cacheSystem: true, temperature: 0 },
  );
  return parseJson<DashboardSpec>(raw);
}

// ---------------------------------------------------------------------------
// Dashboard spec generation
// ---------------------------------------------------------------------------

export async function generateDashboardSpec(
  request: string,
  semanticContext: string,
  relationshipContext: string,
  dialect: SqlDialect = 'sqlite',
): Promise<DashboardSpec> {
  const glossary = await loadGlossaryBlock();
  const raw = await callClaude(
    getDashboardSystem(dialect),
    buildDashboardUser(request, semanticContext, relationshipContext, glossary),
    // temperature 0: same request should produce the same dashboard. Users
    // are more frustrated by "same intent, different widgets" than by lack
    // of variety on regeneration.
    { maxTokens: 16000, cacheSystem: true, temperature: 0 },
  );
  return parseJson<DashboardSpec>(raw);
}

// ---------------------------------------------------------------------------
// Dashboard spec validation — fixes broken/empty widgets after a test run
// ---------------------------------------------------------------------------

export async function validateAndFixDashboardSpec(
  spec: DashboardSpec,
  executionResults: WidgetExecutionResult[],
  semanticContext: string,
  relationshipContext: string,
): Promise<DashboardSpec> {
  const raw = await callClaude(
    VALIDATE_DASHBOARD_SYSTEM,
    buildValidateUser(spec, executionResults, semanticContext, relationshipContext),
    // temperature 0: same broken spec should get the same fix.
    { maxTokens: 16000, cacheSystem: true, temperature: 0 },
  );
  return parseJson<DashboardSpec>(raw);
}

// ---------------------------------------------------------------------------
// Semantic alignment check — cheap Haiku call per widget. Returns null if ok,
// otherwise a short sentence describing the mismatch. Fails open on any error
// (never blocks dashboard generation).
// ---------------------------------------------------------------------------

export async function checkWidgetSemantics(
  title: string,
  chartType: string,
  sampleRows: Record<string, unknown>[],
): Promise<string | null> {
  if (!sampleRows.length) return null;
  try {
    const raw = await callClaude(
      SEMANTIC_CHECK_SYSTEM,
      buildSemanticCheckUser(title, chartType, sampleRows),
      // temperature 0: same title + sample → same verdict.
      { model: MODEL_HAIKU, maxTokens: 120, callLabel: 'widget_semantic_check', temperature: 0, kind: 'row' },
    );
    const parsed = parseJson<{ ok: boolean; issue?: string }>(raw);
    return parsed.ok ? null : (parsed.issue ?? 'Data does not match the title.');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Star Schema Design — AI designs a Kimball star schema from source tables
// ---------------------------------------------------------------------------

export async function generateStarSchemaDesign(
  dataProductName: string,
  dataProductDescription: string,
  sourceTablesContext: string,
): Promise<StarSchemaDesignOutput> {
  const raw = await callClaudeStreaming(
    STAR_SCHEMA_DESIGN_SYSTEM(sourceTablesContext, currentDateStr()),
    buildStarSchemaDesignUser(dataProductName, dataProductDescription, sourceTablesContext),
    64000,
    'star_schema_design',
    true,
    0, // temperature 0: deterministic schema design.
  );
  return parseJson<StarSchemaDesignOutput>(raw);
}

/**
 * Streaming version of star schema design — fires thinking + text deltas
 * so the frontend can show live AI reasoning and skeleton previews.
 */
export async function generateStarSchemaDesignStreaming(
  dataProductName: string,
  dataProductDescription: string,
  sourceTablesContext: string,
  onEvent: (type: 'thinking' | 'text', delta: string) => void,
): Promise<StarSchemaDesignOutput> {
  const tenantId = await enforceAiBudget('star_schema_streaming');
  const streamCallLabel = 'star_schema_streaming';
  const streamStart = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    system: [{
      type: 'text',
      text: STAR_SCHEMA_DESIGN_SYSTEM(sourceTablesContext, currentDateStr()),
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: buildStarSchemaDesignUser(dataProductName, dataProductDescription, sourceTablesContext) }],
  };

  const stream = getClient().messages.stream(params);
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delta = (event as any).delta as Record<string, unknown>;
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent('thinking', delta.thinking);
      } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        fullText += delta.text;
        onEvent('text', delta.text);
      }
    }
  }

  if (tenantId) {
    try {
      const final = await stream.finalMessage();
      recordTenantAiUsage(tenantId, final.usage?.input_tokens ?? 0, final.usage?.output_tokens ?? 0)
        .catch(() => { /* logged inside */ });
    } catch { /* best-effort */ }
  }

  return parseJson<StarSchemaDesignOutput>(fullText);
}

// ---------------------------------------------------------------------------
// Bus Matrix Design — designs ALL dims + facts for entire source in one call
// ---------------------------------------------------------------------------

/**
 * Streaming bus matrix design — designs all conformed dimensions and fact tables
 * for an entire source system in a single AI call. Replaces the old propose +
 * per-product design flow.
 */
export async function generateBusMatrixStreaming(
  connectionName: string,
  sourceTablesContext: string,
  onEvent: (type: 'thinking' | 'text' | 'diag', delta: string) => void,
  abortSignal?: AbortSignal,
): Promise<BusMatrixOutput> {
  const tenantId = await enforceAiBudget('bus_matrix_streaming');
  const streamCallLabel = 'bus_matrix_streaming';
  const streamStart = Date.now();
  const currentDate = currentDateStr();
  const corrId = `bm-${Date.now().toString(36)}`;
  const t0 = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    system: [{
      type: 'text',
      text: BUS_MATRIX_SYSTEM(sourceTablesContext, currentDate),
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: buildBusMatrixUser(connectionName, sourceTablesContext) }],
  };

  const sendDiag = (msg: string) => {
    logger.info({ corrId, elapsedMs: Date.now() - t0, msg }, '[bus-matrix]');
    try { onEvent('diag', msg); } catch { /* ignore */ }
  };

  sendDiag(`AI call starting (model=${MODEL}, max_tokens=${params.max_tokens}, thinking_budget=${params.thinking.budget_tokens}, contextChars=${sourceTablesContext.length})`);

  const stream = getClient().messages.stream(params);

  // Wire external abort (user-initiated cancel) into the Anthropic stream.
  if (abortSignal) {
    if (abortSignal.aborted) {
      try { (stream as unknown as { controller?: { abort?: () => void } }).controller?.abort?.(); } catch { /* ignore */ }
    } else {
      abortSignal.addEventListener('abort', () => {
        sendDiag('external abort received — aborting Anthropic stream');
        try { (stream as unknown as { controller?: { abort?: () => void } }).controller?.abort?.(); } catch { /* ignore */ }
      }, { once: true });
    }
  }

  let fullText = '';
  let thinkingChars = 0;
  let textDeltaCount = 0;
  let thinkingDeltaCount = 0;
  let lastStopReason: string | null = null;
  let sawMessageStart = false;
  let sawMessageStop = false;
  let sawTextBlockStart = false;

  // Watchdog + heartbeat: emit periodic progress diag so the client can SEE
  // whether the stream is still making progress, and abort if Anthropic goes
  // silent for IDLE_ABORT_MS (otherwise the for-await hangs forever).
  let lastEventAt = Date.now();
  const IDLE_ABORT_MS = 90_000;
  const HEARTBEAT_MS = 10_000;
  let watchdogFired = false;

  const heartbeat = setInterval(() => {
    const idle = Date.now() - lastEventAt;
    sendDiag(`progress thinking=${thinkingChars}c/${thinkingDeltaCount}d text=${fullText.length}c/${textDeltaCount}d idle=${Math.round(idle / 1000)}s`);
    if (idle > IDLE_ABORT_MS && !watchdogFired) {
      watchdogFired = true;
      sendDiag(`watchdog: no Anthropic event for ${Math.round(idle / 1000)}s — aborting stream`);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (stream as any).controller?.abort?.();
      } catch { /* best-effort */ }
    }
  }, HEARTBEAT_MS);

  try {
    for await (const event of stream) {
      lastEventAt = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any;

      if (ev.type === 'message_start') {
        sawMessageStart = true;
        sendDiag(`message_start (model=${ev.message?.model ?? 'unknown'})`);
      } else if (ev.type === 'content_block_start') {
        const blockType = ev.content_block?.type;
        if (blockType === 'text') sawTextBlockStart = true;
        sendDiag(`content_block_start (index=${ev.index}, type=${blockType})`);
      } else if (ev.type === 'content_block_delta') {
        const delta = ev.delta as Record<string, unknown>;
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          thinkingChars += delta.thinking.length;
          thinkingDeltaCount += 1;
          onEvent('thinking', delta.thinking);
        } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          fullText += delta.text;
          textDeltaCount += 1;
          if (textDeltaCount === 1) sendDiag('first text_delta received (JSON output starting)');
          onEvent('text', delta.text);
        }
      } else if (ev.type === 'content_block_stop') {
        sendDiag(`content_block_stop (index=${ev.index})`);
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) {
          lastStopReason = ev.delta.stop_reason as string;
          sendDiag(`message_delta stop_reason=${lastStopReason} output_tokens=${ev.usage?.output_tokens ?? '?'}`);
        }
      } else if (ev.type === 'message_stop') {
        sawMessageStop = true;
        sendDiag('message_stop');
      }
    }
  } catch (streamErr) {
    clearInterval(heartbeat);
    const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    logger.error({ corrId, elapsedMs: Date.now() - t0, err: msg, watchdogFired, stack: streamErr instanceof Error ? streamErr.stack : undefined }, '[bus-matrix] Anthropic SDK stream threw');
    sendDiag(`Anthropic SDK stream threw: ${msg}`);
    // If we already have usable text, fall through and try to parse+repair it.
    if (!fullText.trim()) {
      throw new Error(`Anthropic stream error: ${msg}`);
    }
    sendDiag(`recovering with partial text (${fullText.length} chars) — will attempt JSON repair`);
  }
  clearInterval(heartbeat);

  const streamSummary = `stream finished: msg_start=${sawMessageStart} text_block_start=${sawTextBlockStart} msg_stop=${sawMessageStop} stop_reason=${lastStopReason ?? 'null'} thinking_chars=${thinkingChars} (${thinkingDeltaCount} deltas) text_chars=${fullText.length} (${textDeltaCount} deltas) duration=${Date.now() - t0}ms`;
  sendDiag(streamSummary);
  logger.info({ corrId, streamSummary }, '[bus-matrix] stream summary');

  if (tenantId) {
    try {
      const final = await stream.finalMessage();
      recordTenantAiUsage(tenantId, final.usage?.input_tokens ?? 0, final.usage?.output_tokens ?? 0)
        .catch(() => { /* logged inside */ });
    } catch { /* best-effort */ }
  }

  if (!fullText.trim()) {
    logger.error({ corrId, sourceContextLength: sourceTablesContext.length, thinkingChars, stopReason: lastStopReason, sawTextBlockStart }, 'Bus matrix AI returned no text output');
    throw new Error(`AI returned no text output (thinking_chars=${thinkingChars}, stop_reason=${lastStopReason}, text_block_started=${sawTextBlockStart}). Likely the model exhausted its token budget on thinking, or was blocked by Anthropic. Try reducing input size.`);
  }

  logger.info({ corrId, textLength: fullText.length, preview: fullText.slice(0, 300) }, 'Bus matrix AI raw output preview');

  try {
    return parseJson<BusMatrixOutput>(fullText);
  } catch (parseErr) {
    logger.warn({ corrId, textLength: fullText.length, last200: fullText.slice(-200) }, 'Bus matrix JSON parse failed — attempting truncation repair');

    const repaired = repairTruncatedJson(fullText);
    if (repaired) {
      try {
        const result = parseJson<BusMatrixOutput>(repaired);
        logger.info({ corrId }, 'Bus matrix JSON repaired after truncation');
        sendDiag('JSON was truncated but auto-repaired successfully');
        return result;
      } catch { /* fall through to error */ }
    }

    logger.error({ corrId, textLength: fullText.length, first500: fullText.slice(0, 500), last500: fullText.slice(-500) }, 'Bus matrix JSON repair also failed');
    const preview = fullText.slice(-200).replace(/\n/g, ' ');
    throw new Error(`Failed to parse AI output as JSON (stop_reason=${lastStopReason}, text_chars=${fullText.length}). Likely truncated. Tail: "${preview}"`);
  }
}

// ---------------------------------------------------------------------------
// Column Edit — surgical edit of one column's transformation expression
// ---------------------------------------------------------------------------

export async function editColumnExpression(
  columnName: string,
  currentExpression: string,
  editRequest: string,
  tableContext: string,
): Promise<string> {
  return callClaude(
    COLUMN_EDIT_SYSTEM,
    buildColumnEditUser(columnName, currentExpression, editRequest, tableContext),
    // temperature 0: same edit request → same SQL expression.
    { temperature: 0 },
  );
}

// ---------------------------------------------------------------------------
// KPI Draft — propose a SQL formula for a user-defined KPI on a product
// ---------------------------------------------------------------------------

export interface KpiDraftResult {
  formulaSql: string;
  formulaPlainText: string;
  primaryTable: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export async function draftKpiFormula(
  context: KpiDraftProductContext,
  kpiName: string,
  userDescription: string | null,
): Promise<KpiDraftResult> {
  const raw = await callClaude(
    KPI_DRAFT_SYSTEM,
    buildKpiDraftUser(context, kpiName, userDescription),
    // temperature 0: same KPI name + product context → same formula.
    { model: MODEL_HAIKU, maxTokens: 800, callLabel: 'kpi_draft', temperature: 0 },
  );

  // Strip code fences if Claude added them despite the system prompt.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn({ err, raw: cleaned.slice(0, 400) }, 'draftKpiFormula: failed to parse JSON');
    return {
      formulaSql: '',
      formulaPlainText: '',
      primaryTable: null,
      confidence: 'low',
      notes: 'I could not produce a structured formula for that KPI. Try rewording the description, or write the SQL by hand.',
    };
  }

  const obj = parsed as Partial<{
    formula_sql: string;
    formula_plain_text: string;
    primary_table: string;
    confidence: 'high' | 'medium' | 'low';
    notes: string;
  }>;

  return {
    formulaSql:       typeof obj.formula_sql === 'string' ? obj.formula_sql.trim() : '',
    formulaPlainText: typeof obj.formula_plain_text === 'string' ? obj.formula_plain_text.trim() : '',
    primaryTable:     typeof obj.primary_table === 'string' ? obj.primary_table : null,
    confidence:       obj.confidence === 'high' || obj.confidence === 'low' ? obj.confidence : 'medium',
    notes:            typeof obj.notes === 'string' ? obj.notes : '',
  };
}

// ---------------------------------------------------------------------------
// Pulse — propose a starter watchlist for a single user
// ---------------------------------------------------------------------------

export async function suggestPulseEntries(
  context: PulseSuggestContext,
): Promise<PulseSuggestResult> {
  const raw = await callClaude(
    PULSE_SUGGEST_SYSTEM,
    buildPulseSuggestUser(context),
    { model: MODEL_HAIKU, maxTokens: 1500, callLabel: 'pulse_suggest' },
  );

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn({ err, raw: cleaned.slice(0, 400) }, 'suggestPulseEntries: failed to parse JSON');
    return {
      suggestions: [],
      hint: 'I could not produce suggestions for your pulse — try again, or add entries by hand.',
    };
  }
  const obj = parsed as Partial<PulseSuggestResult>;
  return {
    suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : [],
    hint: typeof obj.hint === 'string' && obj.hint.trim() ? obj.hint : null,
  };
}

// ---------------------------------------------------------------------------
// Query starters — personalised "Try asking…" prompts for /query empty
// state. Cached upstream by queryStartersService.
// ---------------------------------------------------------------------------

export async function generateQueryStarters(
  context: QueryStartersContext,
): Promise<QueryStartersResult> {
  const raw = await callClaude(
    QUERY_STARTERS_SYSTEM,
    buildQueryStartersUser(context),
    { model: MODEL_HAIKU, maxTokens: 800, callLabel: 'query_starters' },
  );
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<QueryStartersResult>;
    return { starters: Array.isArray(obj.starters) ? obj.starters : [] };
  } catch {
    return { starters: [] };
  }
}

// ---------------------------------------------------------------------------
// Investigate Agent — multi-step "why?" loop
// ---------------------------------------------------------------------------

/** Plan-next: returns the next step OR a signal to conclude. */
export async function investigatePlanNext(
  context: InvestigateAgentContext,
): Promise<InvestigateAgentDecision> {
  const raw = await callClaude(
    AGENT_PLAN_NEXT_SYSTEM,
    buildAgentPlanNextUser(context),
    // cacheSystem: AGENT_PLAN_NEXT_SYSTEM is stable across all 6 turns of an
    // investigation. Without caching, the ~2K-token system prompt is paid
    // fresh on every PLAN_NEXT call. With caching, turns 2–6 read it at 10×
    // discount → ~40% drop on Investigate cost.
    { model: MODEL, maxTokens: 800, callLabel: 'investigate_plan_next', cacheSystem: true, kind: 'row' },
  );
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { return { kind: 'conclude', reason: 'AI output was not valid JSON.' }; }
  const obj = parsed as { kind?: string; hypothesis?: string; query_sql?: string; reason?: string };
  if (obj.kind === 'step' && obj.hypothesis && obj.query_sql) {
    return { kind: 'step', hypothesis: String(obj.hypothesis), query_sql: String(obj.query_sql) };
  }
  return { kind: 'conclude', reason: typeof obj.reason === 'string' ? obj.reason : 'enough evidence' };
}

/** Summarise-step: turn the rows of one query into a one-sentence finding. */
export async function investigateSummariseStep(opts: {
  hypothesis: string;
  querySql: string;
  rowCount: number;
  resultPreview: Array<Record<string, unknown>>;
}): Promise<string> {
  const raw = await callClaude(
    AGENT_SUMMARISE_STEP_SYSTEM,
    buildAgentSummariseUser(opts),
    { model: MODEL_HAIKU, maxTokens: 200, callLabel: 'investigate_summarise', kind: 'row' },
  );
  return raw.trim().replace(/^["']|["']$/g, '');
}

/** Conclude: synthesise the trail into a 3-5 sentence answer. */
export async function investigateConclude(
  input: InvestigateConclusionInput,
): Promise<InvestigateConclusion> {
  const raw = await callClaude(
    AGENT_CONCLUDE_SYSTEM,
    buildAgentConcludeUser(input),
    // cacheSystem: same stable conclude-system prompt across every
    // investigation. Cheap win since the prompt is ≥1K tokens.
    // temperature 0: same evidence trail should produce the same conclusion.
    { model: MODEL, maxTokens: 600, callLabel: 'investigate_conclude', cacheSystem: true, temperature: 0, kind: 'row' },
  );
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<InvestigateConclusion>;
    return {
      conclusion: typeof obj.conclusion === 'string' ? obj.conclusion : '',
      confidence: obj.confidence === 'high' || obj.confidence === 'low' ? obj.confidence : 'medium',
    };
  } catch {
    return { conclusion: 'Unable to synthesise a conclusion from the trail.', confidence: 'low' };
  }
}

// ---------------------------------------------------------------------------
// Morning Brief — narrate the day's pulse deltas in business voice
// ---------------------------------------------------------------------------

export async function composeMorningBrief(
  context: MorningBriefContext,
): Promise<MorningBriefOutput> {
  const raw = await callClaude(
    MORNING_BRIEF_SYSTEM,
    buildMorningBriefUser(context),
    // cacheSystem: brief system prompt is stable. Haiku cache reads are
    // tiny ($0.03/MTok) but still strictly cheaper than fresh input —
    // and the cron fires once per user per day, so cache hits on the
    // 2nd+ user re-use the same system prompt.
    { model: MODEL_HAIKU, maxTokens: 1000, callLabel: 'morning_brief', cacheSystem: true, kind: 'row' },
  );

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn({ err, raw: cleaned.slice(0, 400) }, 'composeMorningBrief: failed to parse JSON');
    return {
      summary: 'Brief unavailable today — the narrator could not produce structured output.',
      bullets: [],
      suggested_focus: 'Check the pulse panel on Home for raw values.',
      confidence: 'low',
    };
  }

  const obj = parsed as Partial<MorningBriefOutput>;
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    bullets: Array.isArray(obj.bullets) ? obj.bullets : [],
    suggested_focus: typeof obj.suggested_focus === 'string' ? obj.suggested_focus : '',
    confidence: obj.confidence === 'high' || obj.confidence === 'low' ? obj.confidence : 'medium',
  };
}

// ---------------------------------------------------------------------------
// Refine Chat — per-product conversational editing.
//
// Phase 2 supports three apply intents (add_column / modify_column /
// add_kpi) plus two non-apply outcomes (ask_clarification / unsupported).
// Service-side persistence + apply lives in services/refineService.ts.
// ---------------------------------------------------------------------------

export async function proposeRefinement(
  context: RefineChatProductContext,
  userMessage: string,
): Promise<RefineChatResult> {
  const raw = await callClaude(
    REFINE_CHAT_SYSTEM,
    buildRefineChatUser(context, userMessage),
    // cacheSystem: REFINE_CHAT_SYSTEM is the stable rules + JSON schema; the
    // dynamic per-product context lives in the user message. Caching the
    // system prompt across consecutive turns of the same Refine thread
    // (and across all tenants — same prompt) is a ~50% drop on Refine cost.
    // temperature 0: same user message + same product state should produce
    // the same diff every time — "add a column called X" isn't a creative task.
    { model: MODEL, maxTokens: 2500, callLabel: 'refine_chat', cacheSystem: true, temperature: 0 },
  );

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn({ err, raw: cleaned.slice(0, 400) }, 'proposeRefinement: failed to parse JSON');
    return {
      intent: 'unsupported',
      confidence: 'low',
      reasoning: 'The model returned non-JSON output.',
      summary: 'I could not understand that request well enough to propose a change.',
      proposal: {
        intent: 'unsupported',
        reason: 'Internal: the model output was not valid JSON. Try rewording.',
        suggested_action: null,
      },
    };
  }

  const obj = parsed as Partial<RefineChatResult> & { proposal?: unknown };
  const intent = (obj.proposal as { intent?: string } | undefined)?.intent ?? obj.intent;
  if (!intent) {
    return {
      intent: 'unsupported',
      confidence: 'low',
      reasoning: 'No intent in model output.',
      summary: 'I could not produce a structured proposal for that.',
      proposal: { intent: 'unsupported', reason: 'no intent', suggested_action: null },
    };
  }

  return {
    intent: intent as RefineChatResult['intent'],
    confidence: (obj.confidence === 'high' || obj.confidence === 'low') ? obj.confidence : 'medium',
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    proposal: obj.proposal as ProposalPayload,
  };
}

// ---------------------------------------------------------------------------
// Product Refinement — NL instruction → structured metadata diff
// ---------------------------------------------------------------------------

export async function refineProduct(
  product: ProductSummary,
  instruction: string,
): Promise<RefineProposal> {
  const raw = await callClaude(
    REFINE_PRODUCT_SYSTEM,
    buildRefineProductUser(product, instruction),
    // temperature 0: deterministic refinement diff for the same instruction.
    { model: MODEL_HAIKU, maxTokens: 1500, callLabel: 'refine_product', temperature: 0 },
  );

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn({ err, raw: cleaned.slice(0, 400) }, 'refineProduct: failed to parse JSON');
    return {
      summary: 'I could not understand that request well enough to propose changes.',
      changes: [],
      reasoning: 'The model returned non-JSON output.',
    };
  }

  const obj = parsed as Partial<RefineProposal>;
  return {
    summary:   typeof obj.summary === 'string' ? obj.summary : '',
    changes:   Array.isArray(obj.changes) ? (obj.changes as RefineProposal['changes']) : [],
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
  };
}

// ---------------------------------------------------------------------------
// Transformation SQL repair — surgical fix for a failing dim/fact CREATE TABLE
// ---------------------------------------------------------------------------

const REPAIR_TRANSFORMATION_SYSTEM = `You repair a single failing DuckDB transformation SELECT for a Kimball dim or fact table. Output ONLY the corrected SELECT — no markdown, no commentary, no explanation, no CREATE TABLE wrapper.

Common failure patterns and how to fix them:
- "Values list X does not have a column named Y" — the SQL references dim_X.Y but Y was never defined in dim_X. Fix by REMOVING that reference (drop the AND clause, drop the SELECT column) — never invent a column.
- "Referenced column X not found" — same root cause: the column doesn't exist on the table or alias used. Drop the reference or use a column that does exist.
- "Conversion Error" / "Could not convert" — wrap the offending expression with TRY_CAST(... AS <type>) and NULLIF(TRIM(CAST(... AS VARCHAR)), '') for string→number paths.

Hard rules:
- Reference ONLY columns that appear in the AVAILABLE SCHEMAS section. If a column is not listed there, you may not reference it.
- Preserve the table's intended grain and surrogate-key strategy (ROW_NUMBER for dims, COALESCE(dim_key, -1) for fact FKs).
- Keep TRY_CAST for type conversions; never use plain CAST.
- Output a single self-contained SELECT statement. No semicolons at the end. No comments.`;

// ---------------------------------------------------------------------------
// Last-resort: generate transformation SQL from scratch when the stored
// value is unparseable / corrupted (e.g. LLM apology text leaked into
// transformation_sql). No "FAILING SQL" in the prompt — that's the whole
// point: the failing version is gibberish, we don't want Claude anchoring
// on it. Pure "build a SELECT for this table given these schemas".
// ---------------------------------------------------------------------------
const FROM_SCRATCH_TRANSFORMATION_SYSTEM = `You are a SQL generation expert for a DuckDB-based data warehouse.

Your job: given a table name, its role (fact / dimension / bridge), and the AVAILABLE SCHEMAS in the warehouse, write the SELECT statement that materialises this table.

Hard rules:
- Reference ONLY columns that appear in the AVAILABLE SCHEMAS section.
- For dimensions: surrogate key via ROW_NUMBER() OVER (...) AS <table>_key. Include the natural key + descriptive attributes.
- For facts: foreign keys via COALESCE((SELECT key FROM dim_x WHERE …), -1) AS <dim>_key. Plus measures.
- Use TRY_CAST for type conversions; never plain CAST.
- Output a single self-contained SELECT statement starting with the keyword SELECT or WITH. No semicolons. No comments. No prose.
- If you genuinely cannot infer the table from the schemas, output exactly the keyword SELECT followed by a clear FROM clause referencing the most relevant schema — don't apologise; the platform handles the empty-result case.`;

export async function generateTransformationFromScratch(
  tableName: string,
  tableRole: string,
  availableSchemas: string,
): Promise<string> {
  const userPrompt = `Build the transformation SELECT for ${tableRole} table "${tableName}".

━━━ AVAILABLE SCHEMAS (these are the only tables/views/columns you may reference) ━━━
${availableSchemas}

Return only the SELECT statement.`;

  const raw = await callClaude(FROM_SCRATCH_TRANSFORMATION_SYSTEM, userPrompt, {
    model: MODEL,
    maxTokens: 2048,
    callLabel: 'transformation_from_scratch',
    // temperature 0: same available schemas → same SELECT.
    temperature: 0,
  });
  return raw
    .replace(/^```(?:sql)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

export async function repairTransformationSql(
  tableName: string,
  tableRole: string,
  failingSql: string,
  errorMessage: string,
  availableSchemas: string,
): Promise<string> {
  const userPrompt = `Repair the transformation SELECT for ${tableRole} table "${tableName}".

━━━ FAILING SQL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${failingSql}

━━━ DUCKDB ERROR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${errorMessage}

━━━ AVAILABLE SCHEMAS (these are the only tables/views/columns you may reference) ━━━
${availableSchemas}

Return only the corrected SELECT.`;

  const raw = await callClaude(REPAIR_TRANSFORMATION_SYSTEM, userPrompt, {
    model: MODEL,
    maxTokens: 2048,
    callLabel: 'transformation_repair',
    // temperature 0: same failing SQL + same error → same fix.
    temperature: 0,
  });

  // Strip any markdown code fences the model may add despite instructions.
  return raw
    .replace(/^```(?:sql)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Forecast Query — detect forecast intent and generate historical SQL
// ---------------------------------------------------------------------------

export async function forecastQuery(
  question: string,
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
  dialect: SqlDialect = 'sqlite',
): Promise<ForecastQueryOutput> {
  const raw = await callClaude(
    FORECAST_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr(), dialect),
    buildForecastUser(question),
    // temperature 0: forecast SQL is structured — same question → same SQL.
    { maxTokens: 4096, callLabel: 'forecast_query', cacheSystem: true, temperature: 0 },
  );
  return parseJson<ForecastQueryOutput>(raw);
}

// ---------------------------------------------------------------------------
// Quality Alert Context — 2-sentence business explanation for a quality alert
// ---------------------------------------------------------------------------

export async function generateQualityAlertContext(input: QualityAlertInput): Promise<string> {
  return callClaude(
    QUALITY_ALERT_SYSTEM,
    buildQualityAlertUser(input),
    { model: MODEL_HAIKU, maxTokens: 120, callLabel: 'quality_alert_context' },
  );
}

// ---------------------------------------------------------------------------
// Product icon generation — single line-style SVG per data product
// ---------------------------------------------------------------------------

/**
 * Validate that AI output is a clean, safe, single-element <svg> matching
 * our line-icon contract. Returns the trimmed SVG string, or null if it
 * fails sanitisation. Caller should fall back to a default icon when null.
 */
function sanitizeProductIconSvg(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^```(?:svg|xml|html)?\s*/i, '').replace(/\s*```\s*$/m, '').trim();
  text = text.replace(/^<\?xml[^?]*\?>\s*/i, '');
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start === -1 || end === -1 || end <= start) return null;
  text = text.slice(start, end + '</svg>'.length).trim();

  // Reject anything dangerous or off-aesthetic.
  const banned = /<\s*(script|foreignObject|image|iframe|style|defs|use|filter|text)\b/i;
  if (banned.test(text)) return null;
  if (/on\w+\s*=/i.test(text)) return null;        // inline event handlers
  if (/javascript:/i.test(text)) return null;
  if (/xlink:href|href\s*=/i.test(text)) return null;
  if (/data:/i.test(text)) return null;
  if (/url\s*\(/i.test(text)) return null;

  // Must be a 24×24 viewBox icon.
  if (!/viewBox\s*=\s*["']0 0 24 24["']/i.test(text)) return null;

  // Cap size — a sane line icon is well under this.
  if (text.length > 4000) return null;

  return text;
}

export async function generateProductIcon(
  name: string,
  description?: string | null,
): Promise<string | null> {
  try {
    const raw = await callClaude(
      PRODUCT_ICON_SYSTEM,
      buildProductIconUser(name, description),
      { model: MODEL_HAIKU, maxTokens: 600, callLabel: 'product_icon', cacheSystem: true },
    );
    return sanitizeProductIconSvg(raw);
  } catch (err) {
    logger.warn({ name, err: err instanceof Error ? err.message : String(err) }, 'generateProductIcon failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sprint 3.1 — Explain widget + Dashboard insights
// ---------------------------------------------------------------------------

export async function explainWidget(
  title: string,
  chartType: string,
  rows: Record<string, unknown>[],
): Promise<string> {
  return callClaude(
    EXPLAIN_WIDGET_SYSTEM,
    buildExplainWidgetUser(title, chartType, rows),
    { model: MODEL_HAIKU, maxTokens: 150, callLabel: 'explain_widget', kind: 'row' },
  );
}

// ---------------------------------------------------------------------------
// Phase B (provenance) — translate widget SQL into plain English so users
// can verify "where does this number come from" without reading SQL. This
// is the trust-layer feature: a finance team will not bet a board meeting
// on a number whose origin they can't audit.
// ---------------------------------------------------------------------------

const SQL_TO_PLAIN_ENGLISH_SYSTEM = `You are a data analyst translating a SQL query into one paragraph of plain business English. Your audience: a non-technical user (CFO, ops manager) who wants to verify what a dashboard number actually represents before trusting it.

Rules:
- 2-3 sentences, no more.
- Describe WHAT is computed, not how. Say "total revenue per month for this year" not "SUM with GROUP BY date_trunc".
- If there's a filter (WHERE clause), state it in business terms: "for the current quarter", "where the customer is in Belgium", etc.
- If there's an aggregation (SUM, COUNT, AVG, percentile), name it: "total", "count of", "average", "median".
- If the SQL joins multiple tables, mention the join briefly: "combining sales with the customer dimension".
- Do NOT mention column names verbatim unless their business meaning is non-obvious.
- Do NOT use SQL keywords (SELECT, JOIN, GROUP BY, WHERE, etc).
- Do NOT use markdown formatting. Plain prose.
- Output ONLY the explanation text. No preamble, no "Here is the explanation:".`;

function buildSqlToPlainEnglishUser(title: string, sql: string, tableContext?: string): string {
  const ctx = tableContext ? `\nTABLES + COLUMNS REFERENCED:\n${tableContext}\n` : '';
  return `Widget title: ${title}
${ctx}
SQL:
${sql}

Translate the SQL into 2-3 sentences of plain business English.`;
}

export async function explainSqlInPlainEnglish(
  title: string,
  sql: string,
  tableContext?: string,
): Promise<string> {
  return callClaude(
    SQL_TO_PLAIN_ENGLISH_SYSTEM,
    buildSqlToPlainEnglishUser(title, sql, tableContext),
    { model: MODEL_HAIKU, maxTokens: 300, callLabel: 'explain_sql_plain' },
  );
}

// ---------------------------------------------------------------------------
// Sprint 3.2 — Causal investigation
// ---------------------------------------------------------------------------

export interface InvestigationPlan {
  hypothesis: string;
  queries: { label: string; sql: string }[];
}

export async function planInvestigation(
  widgetTitle: string,
  widgetSql: string,
  widgetRows: Record<string, unknown>[],
  question: string,
): Promise<InvestigationPlan> {
  const raw = await callClaude(
    INVESTIGATE_PLAN_SYSTEM,
    buildInvestigatePlanUser(widgetTitle, widgetSql, widgetRows, question),
    // temperature 0: same widget context → same diagnostic plan.
    { model: MODEL_HAIKU, maxTokens: 800, callLabel: 'investigate_plan', temperature: 0, kind: 'row' },
  );
  try {
    return parseJson<InvestigationPlan>(raw);
  } catch {
    return { hypothesis: 'Investigating…', queries: [] };
  }
}

export async function synthesizeInvestigation(
  question: string,
  hypothesis: string,
  results: DiagnosticResult[],
): Promise<string> {
  return callClaude(
    INVESTIGATE_SYNTHESIZE_SYSTEM,
    buildInvestigateSynthesizeUser(question, hypothesis, results),
    { model: MODEL_HAIKU, maxTokens: 300, callLabel: 'investigate_synthesize', kind: 'row' },
  );
}

// ---------------------------------------------------------------------------
// Sprint 3.3 — Dashboard story narration
// ---------------------------------------------------------------------------

export async function narrateDashboard(
  dashboardTitle: string,
  widgets: WidgetNarrativeInput[],
): Promise<NarrativeOutput> {
  const raw = await callClaude(
    NARRATE_SYSTEM,
    buildNarrateUser(dashboardTitle, widgets),
    { maxTokens: 1200, callLabel: 'narrate_dashboard', kind: 'row' },
  );
  try {
    return parseJson<NarrativeOutput>(raw);
  } catch {
    return {
      headline: dashboardTitle,
      period: 'Current period',
      summary: raw.slice(0, 500),
      sections: [],
      recommendation: '',
    };
  }
}

export async function generateDashboardInsights(
  dashboardTitle: string,
  widgets: WidgetSummary[],
): Promise<string[]> {
  const raw = await callClaude(
    INSIGHTS_SYSTEM,
    buildInsightsUser(dashboardTitle, widgets),
    { model: MODEL_HAIKU, maxTokens: 300, callLabel: 'dashboard_insights', kind: 'row' },
  );
  try {
    // Strip markdown code fences, then extract the outermost [...] array
    let cleaned = raw.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length >= 1) {
      return parsed.slice(0, 3).map(String);
    }
  } catch { /* fall through */ }
  // Fallback: extract quoted strings from the raw response
  const matches = raw.match(/"([^"]{20,})"/g);
  if (matches && matches.length >= 1) {
    return matches.slice(0, 3).map((s) => s.slice(1, -1));
  }
  return [];
}
