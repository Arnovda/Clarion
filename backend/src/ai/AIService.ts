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
} from './prompts/dashboardPrompt';
import {
  STAR_SCHEMA_DESIGN_SYSTEM,
  buildStarSchemaDesignUser,
  StarSchemaDesignOutput,
  TRANSFORMATION_SQL_SYSTEM,
  buildTransformationSqlUser,
  TransformationSqlOutput,
  COLUMN_EDIT_SYSTEM,
  buildColumnEditUser,
} from './prompts/starSchemaPrompt';

// ---------------------------------------------------------------------------
// SQL dialect type — used to select the correct prompt variant
// ---------------------------------------------------------------------------
export type SqlDialect = 'sqlite' | 'duckdb';

import { logger } from '../utils/logger';
import { trackMetric, trackEvent } from '../utils/monitoring';

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000]; // ms — exponential-ish backoff

async function callClaude(systemPrompt: string, userPrompt: string, maxTokens = 4096, callLabel?: string): Promise<string> {
  // Auto-derive label from system prompt if not provided
  if (!callLabel) callLabel = systemPrompt.slice(0, 60).replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').toLowerCase();
  const start = Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await getClient().messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
      });

      const block = message.content[0];
      if (block.type !== 'text') {
        throw new Error('AIService: unexpected non-text response from Claude');
      }

      // Track AI call metrics
      const durationMs = Date.now() - start;
      const inputTokens  = message.usage?.input_tokens  ?? 0;
      const outputTokens = message.usage?.output_tokens ?? 0;
      const props = { callLabel, model: MODEL, attempt: String(attempt + 1) };
      trackMetric('ai_call_duration_ms', durationMs, props);
      trackMetric('ai_input_tokens',     inputTokens, props);
      trackMetric('ai_output_tokens',    outputTokens, props);
      trackMetric('ai_total_tokens',     inputTokens + outputTokens, props);
      logger.info({ callLabel, durationMs, inputTokens, outputTokens, attempt: attempt + 1 }, 'AI call completed');

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
      logger.error({ callLabel, status, durationMs, err }, 'AI call failed');
      trackEvent('ai_call_failed', { callLabel, model: MODEL, status: String(status ?? 'unknown'), durationMs: String(durationMs) });
      throw err;
    }
  }
  throw new Error('AIService: exhausted retries');
}

// Streaming version of callClaude — uses streaming API to avoid SDK timeout for large responses
// but collects the full text and returns it as a string (no event callbacks).
async function callClaudeStreaming(systemPrompt: string, userPrompt: string, maxTokens = 4096, callLabel?: string): Promise<string> {
  if (!callLabel) callLabel = 'stream_' + systemPrompt.slice(0, 50).replace(/[^a-zA-Z0-9_ ]/g, '').trim().replace(/\s+/g, '_').toLowerCase();
  const start = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
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
  // Stream API doesn't return usage easily; log what we can
  const props = { callLabel, model: MODEL, streaming: 'true' };
  trackMetric('ai_call_duration_ms', durationMs, props);
  logger.info({ callLabel, durationMs, outputChars: fullText.length, streaming: true }, 'AI streaming call completed');

  return fullText;
}

// Multi-turn version — used by the repair loop where Claude sees its own previous replies
export async function callClaudeMultiTurn(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    throw new Error('AIService: unexpected non-text response from Claude');
  }
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

// ---------------------------------------------------------------------------
// Call Type 1 — Schema Draft
// ---------------------------------------------------------------------------

/**
 * Generate schema draft in batches of BATCH_SIZE tables to avoid token limit
 * truncation. Each batch produces a partial SchemaDraftOutput; results are merged.
 * Calls onProgress(tableName) after each batch so callers can report status.
 */
const DRAFT_BATCH_SIZE = 3;

export async function generateSchemaDraft(
  sourceType: string,
  tables: TableInfo[],
  qualityStats?: TableQualityStat[],
  fkCandidates?: FkCandidate[],
  onProgress?: (tableNames: string[], batchIndex: number, totalBatches: number) => void,
): Promise<SchemaDraftOutput> {
  const merged: SchemaDraftOutput = { tables: [], columns: [] };
  const batches: TableInfo[][] = [];
  for (let i = 0; i < tables.length; i += DRAFT_BATCH_SIZE) {
    batches.push(tables.slice(i, i + DRAFT_BATCH_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchStats = qualityStats?.filter((s) =>
      batch.some((t) => t.tableName === s.table_name),
    );
    onProgress?.(batch.map((t) => t.tableName), bi, batches.length);

    const raw = await callClaude(
      SCHEMA_DRAFT_SYSTEM,
      buildSchemaDraftUser(sourceType, batch, batchStats, fkCandidates),
      16000,
    );
    const partial = parseJson<SchemaDraftOutput>(raw);
    merged.tables.push(...partial.tables);
    merged.columns.push(...partial.columns);
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
    8000,
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
    const raw = await callClaude(FK_SUGGESTION_SYSTEM, userPrompt, 4096);
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
  const confidence = parsed.confidence as number;
  return {
    sql:                 parsed.sql as string,
    confidence,
    schema_confidence:   (parsed.schema_confidence as number)   ?? confidence,
    join_confidence:     (parsed.join_confidence as number)     ?? confidence,
    formula_confidence:  (parsed.formula_confidence as number)  ?? confidence,
    uncertainty_notes:   (parsed.uncertainty_notes as string[]) ?? [],
    tables_used:         parsed.tables_used as string[],
  };
}

const currentDateStr = () => new Date().toISOString().slice(0, 10);

export async function generateSql(
  question: string,
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
  dialect: SqlDialect = 'sqlite',
): Promise<NlToSqlOutput> {
  const systemPrompt = dialect === 'duckdb'
    ? NL_TO_SQL_DUCKDB_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr())
    : NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr());
  const raw = await callClaude(systemPrompt, buildNlToSqlUser(question));
  return defaultSubScores(parseJson<Record<string, unknown>>(raw));
}

// ---------------------------------------------------------------------------
// Call Type 2c — Result sanity check
// Lightweight: runs fast, failure is non-blocking (returns a warning, not an error)
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
    );
    return parseJson<ResultValidationOutput>(raw);
  } catch {
    // Validation is best-effort — never let it break a successful query response
    return { ok: true };
  }
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
): Promise<NlToSqlOutput> {
  const systemPrompt = dialect === 'duckdb'
    ? NL_TO_SQL_CROSS_DUCKDB_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr())
    : NL_TO_SQL_CROSS_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr());
  const raw = await callClaude(systemPrompt, buildNlToSqlCrossUser(question));
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
): Promise<NlToSqlOutput> {
  const systemPrompt = dialect === 'duckdb'
    ? NL_TO_SQL_DUCKDB_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr())
    : NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    system: systemPrompt,
    messages: [{ role: 'user', content: buildNlToSqlUser(question) }],
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

  return defaultSubScores(parseJson<Record<string, unknown>>(fullText));
}

// ---------------------------------------------------------------------------
// Call Type 2b — Format query result as plain-language answer
// ---------------------------------------------------------------------------

export async function formatAnswer(
  question: string,
  rows: Record<string, unknown>[],
): Promise<string> {
  return callClaude(ANSWER_FORMAT_SYSTEM, buildAnswerFormatUser(question, rows));
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
  const raw = await callClaude(
    REFINEMENT_SYSTEM,
    buildRefinementUser(request, semanticContext, relationshipContext),
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
  const raw = await callClaude(
    REFINE_SPEC_SYSTEM,
    buildRefineSpecUser(refinement, currentSpec, semanticContext, relationshipContext),
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
  const raw = await callClaude(
    getDashboardSystem(dialect),
    buildDashboardUser(request, semanticContext, relationshipContext),
    16000,
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
    16000,
  );
  return parseJson<DashboardSpec>(raw);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    system: STAR_SCHEMA_DESIGN_SYSTEM(sourceTablesContext, currentDateStr()),
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

  return parseJson<StarSchemaDesignOutput>(fullText);
}

/**
 * Streaming version of transformation SQL generation.
 */
export async function generateTransformationSqlStreaming(
  starSchemaJson: string,
  sourceContext: string,
  onEvent: (type: 'thinking' | 'text', delta: string) => void,
): Promise<TransformationSqlOutput> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    system: TRANSFORMATION_SQL_SYSTEM(sourceContext),
    messages: [{ role: 'user', content: buildTransformationSqlUser(starSchemaJson) }],
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

  return parseJson<TransformationSqlOutput>(fullText);
}

// ---------------------------------------------------------------------------
// Transformation SQL Generation — generates DuckDB SQL for each product table
// (non-streaming fallback)
// ---------------------------------------------------------------------------

export async function generateTransformationSql(
  starSchemaJson: string,
  sourceContext: string,
): Promise<TransformationSqlOutput> {
  const raw = await callClaudeStreaming(
    TRANSFORMATION_SQL_SYSTEM(sourceContext),
    buildTransformationSqlUser(starSchemaJson),
    64000,
  );
  return parseJson<TransformationSqlOutput>(raw);
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
  );
}
