import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import dotenv from 'dotenv';

import { TableInfo } from '../connectors/BaseConnector';
import {
  SCHEMA_DRAFT_SYSTEM,
  buildSchemaDraftUser,
  SchemaDraftOutput,
  TableQualityStat,
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
  REPORT_NARRATIVE_SYSTEM,
  buildReportNarrativeUser,
  KpiResult,
} from './prompts/answerFormatterPrompt';
import {
  DASHBOARD_SYSTEM,
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

async function callClaude(systemPrompt: string, userPrompt: string, maxTokens = 4096): Promise<string> {
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
  return block.text;
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

export async function generateSchemaDraft(
  sourceType: string,
  tables: TableInfo[],
  qualityStats?: TableQualityStat[],
): Promise<SchemaDraftOutput> {
  const raw = await callClaude(
    SCHEMA_DRAFT_SYSTEM,
    buildSchemaDraftUser(sourceType, tables, qualityStats),
    16000,
  );
  return parseJson<SchemaDraftOutput>(raw);
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
): Promise<NlToSqlOutput> {
  const raw = await callClaude(
    NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr()),
    buildNlToSqlUser(question),
  );
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
): Promise<NlToSqlOutput> {
  const raw = await callClaude(
    NL_TO_SQL_CROSS_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr()),
    buildNlToSqlCrossUser(question),
  );
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
): Promise<NlToSqlOutput> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    system: NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas, currentDateStr()),
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
): Promise<DashboardSpec> {
  const raw = await callClaude(
    DASHBOARD_SYSTEM,
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
