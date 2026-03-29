import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import dotenv from 'dotenv';

import { TableInfo } from '../connectors/BaseConnector';
import {
  SCHEMA_DRAFT_SYSTEM,
  buildSchemaDraftUser,
  SchemaDraftOutput,
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
} from './prompts/dashboardPrompt';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function callClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
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
  const message = await client.messages.create({
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
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned) as T;
}

// ---------------------------------------------------------------------------
// Call Type 1 — Schema Draft
// ---------------------------------------------------------------------------

export async function generateSchemaDraft(
  sourceType: string,
  tables: TableInfo[],
): Promise<SchemaDraftOutput> {
  const raw = await callClaude(
    SCHEMA_DRAFT_SYSTEM,
    buildSchemaDraftUser(sourceType, tables),
  );
  return parseJson<SchemaDraftOutput>(raw);
}

// ---------------------------------------------------------------------------
// Call Type 2a — Natural Language → SQL + confidence score
// ---------------------------------------------------------------------------

export async function generateSql(
  question: string,
  semanticContext: string,
  relationshipContext: string,
  kpiFormulas: string,
): Promise<NlToSqlOutput> {
  const raw = await callClaude(
    NL_TO_SQL_SYSTEM(semanticContext, relationshipContext, kpiFormulas),
    buildNlToSqlUser(question),
  );
  return parseJson<NlToSqlOutput>(raw);
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
  );
  return parseJson<DashboardSpec>(raw);
}
