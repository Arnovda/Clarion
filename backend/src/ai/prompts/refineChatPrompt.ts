/**
 * Refine Chat Prompt — single-turn intent classifier + proposal generator
 * for the per-product Refine chat.
 *
 * Input: the user's natural-language ask + product schema + (optional)
 * focus table + existing customization log + existing KPI names.
 * Output: structured JSON with intent + the change proposal.
 *
 * Phase 2 supports three apply intents:
 *   - add_column      : new column on an existing table
 *   - modify_column   : change a column's expression / role / description
 *   - add_kpi         : new KPI on the product
 * Plus two non-apply outcomes:
 *   - ask_clarification : the AI doesn't have enough info; surface a question
 *   - unsupported       : the request needs a feature we haven't built yet
 *
 * The proposal payload differs per intent — see ProposalPayload below.
 * The router (refineService) reads `intent` and dispatches to the right
 * apply handler when the user approves.
 */

export interface RefineChatProductContext {
  productName: string;
  productDescription: string | null;
  tables: Array<{
    tableId: number;
    tableName: string;
    tableRole: string;
    transformationSql: string | null;
    columns: Array<{
      columnId: number;
      columnName: string;
      dataType: string;
      columnRole: string | null;
      description: string | null;
      transformationExpression: string | null;
    }>;
  }>;
  existingKpiNames: string[];
  /** Optional table-id the user is currently focused on (set when chat
   *  was opened from a table-detail context). The AI uses this as a
   *  bias when the user says "this table" or omits a table reference. */
  focusedTableId: number | null;
  /** Recent customization history (last ~10) — gives the AI context for
   *  follow-up turns ("change that column to NUMERIC instead"). */
  recentCustomizations: Array<{
    intent: string;
    summary: string;
    status: string;
  }>;
}

/** Proposal payload — one of these shapes, picked by the `intent` field. */
export type ProposalPayload =
  | AddColumnPayload
  | ModifyColumnPayload
  | AddKpiPayload
  | AskClarificationPayload
  | UnsupportedPayload;

export interface AddColumnPayload {
  intent: 'add_column';
  product_table_id: number;
  table_name: string;
  /** New column metadata. */
  column_name: string;
  data_type: string;
  column_role: 'measure' | 'dimension' | 'attribute' | 'natural_key' | 'surrogate_key' | null;
  description: string | null;
  /** Expression as it would appear in the SELECT list of transformation_sql. */
  transformation_expression: string;
  /** FULL replacement transformation_sql for the table — the runner just
   *  writes this on approve, no SQL splicing. */
  new_transformation_sql: string;
}

export interface ModifyColumnPayload {
  intent: 'modify_column';
  product_table_id: number;
  product_column_id: number;
  table_name: string;
  column_name: string;
  /** Optional updates to the column metadata. Null = unchanged. */
  data_type: string | null;
  column_role: 'measure' | 'dimension' | 'attribute' | 'natural_key' | 'surrogate_key' | null;
  description: string | null;
  transformation_expression: string | null;
  /** FULL replacement transformation_sql for the table. */
  new_transformation_sql: string;
}

export interface AddKpiPayload {
  intent: 'add_kpi';
  name: string;
  description: string | null;
  formula_plain_text: string;
  formula_sql: string;
}

export interface AskClarificationPayload {
  intent: 'ask_clarification';
  question: string;
}

export interface UnsupportedPayload {
  intent: 'unsupported';
  reason: string;
  /** Optional: a manual path the user can take instead. */
  suggested_action: string | null;
}

export interface RefineChatResult {
  intent: ProposalPayload['intent'];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  /** One-line summary of the proposed change for the chat bubble. */
  summary: string;
  /** The structured proposal — shape depends on intent. */
  proposal: ProposalPayload;
}

export const REFINE_CHAT_SYSTEM = `You are the Refine assistant for a Kimball-style data product. The user asks for a change in plain English; you produce a structured proposal that a human will review and approve.

Output ONLY valid JSON matching this shape — no markdown, no commentary:
{
  "intent": "add_column" | "modify_column" | "add_kpi" | "ask_clarification" | "unsupported",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<1 sentence — why you picked this intent>",
  "summary": "<1 sentence — what the change does, business reader voice>",
  "proposal": { ... }
}

Proposal payloads by intent:

add_column:
{
  "intent": "add_column",
  "product_table_id": <int>,
  "table_name": "<existing table>",
  "column_name": "<snake_case>",
  "data_type": "<DuckDB type>",
  "column_role": "measure" | "dimension" | "attribute" | "natural_key" | null,
  "description": "<one-line>",
  "transformation_expression": "<SQL expression as it would appear in the SELECT list>",
  "new_transformation_sql": "<FULL replacement SELECT for the table — include ALL existing columns plus the new one>"
}

modify_column:
{
  "intent": "modify_column",
  "product_table_id": <int>,
  "product_column_id": <int>,
  "table_name": "<table>",
  "column_name": "<column>",
  "data_type": "<new type or null if unchanged>",
  "column_role": "<new role or null>",
  "description": "<new description or null>",
  "transformation_expression": "<new expression or null>",
  "new_transformation_sql": "<FULL replacement SELECT>"
}

add_kpi:
{
  "intent": "add_kpi",
  "name": "<short business name>",
  "description": "<what it measures>",
  "formula_plain_text": "<plain English: 'Sum of invoice_amount on fact_sales'>",
  "formula_sql": "<DuckDB SELECT that returns one numeric value>"
}

ask_clarification:
{
  "intent": "ask_clarification",
  "question": "<a single direct question for the user>"
}

unsupported:
{
  "intent": "unsupported",
  "reason": "<why we can't do this>",
  "suggested_action": "<manual path the user can take instead, or null>"
}

Hard rules:
- You may only target tables and columns that appear in AVAILABLE SCHEMA. Never invent.
- For add_column / modify_column you MUST emit new_transformation_sql containing the FULL replacement SELECT. The runner writes it verbatim — no splicing. Include every existing column unless the user is dropping it.
- new_transformation_sql must be a single statement, no trailing semicolon, no CREATE TABLE wrapper.
- If the user's request is ambiguous (which table? which column? what aggregation?), return ask_clarification with the single question that would unblock you. Do NOT guess.
- If the request needs a capability beyond add_column / modify_column / add_kpi (add a new table, change grain, drop a column, restructure a join, ingest a new source), return unsupported with a one-line reason and a suggested manual action.
- Lowercase SQL keywords. Double-quote identifiers with uppercase, spaces, or special chars.
- summary should be readable by a non-technical user. ("Adds a margin_pct column to fact_sales", not "ALTER TABLE fact_sales ADD COLUMN margin_pct NUMERIC")`;

export function buildRefineChatUser(
  context: RefineChatProductContext,
  userMessage: string,
): string {
  const tableLines = context.tables.map((t) => {
    const focusMarker = context.focusedTableId === t.tableId ? '  ← USER IS FOCUSED HERE' : '';
    const cols = t.columns
      .map((c) => {
        const role = c.columnRole ? ` [${c.columnRole}]` : '';
        const expr = c.transformationExpression ? ` = ${c.transformationExpression}` : '';
        return `      id=${c.columnId} ${c.columnName} (${c.dataType})${role}${expr}`;
      })
      .join('\n');
    const sql = t.transformationSql
      ? `    transformation_sql:\n${t.transformationSql.split('\n').map((l) => '      ' + l).join('\n')}`
      : '    (no transformation_sql)';
    return `  id=${t.tableId} ${t.tableName} [${t.tableRole}]${focusMarker}\n    columns:\n${cols}\n${sql}`;
  }).join('\n\n');

  const recentBlock = context.recentCustomizations.length > 0
    ? `\nRECENT CUSTOMIZATIONS (most recent first):\n` +
      context.recentCustomizations
        .map((c) => `  [${c.status}] ${c.intent}: ${c.summary}`)
        .join('\n') + '\n'
    : '';

  const kpiBlock = context.existingKpiNames.length > 0
    ? `\nEXISTING KPIS (don't duplicate):\n  ${context.existingKpiNames.join(', ')}\n`
    : '';

  return [
    `PRODUCT: ${context.productName}`,
    context.productDescription ? `DESCRIPTION: ${context.productDescription}` : '',
    '',
    'AVAILABLE SCHEMA:',
    tableLines,
    kpiBlock,
    recentBlock,
    `USER REQUEST: ${userMessage}`,
    '',
    'Produce the JSON proposal now.',
  ].filter(Boolean).join('\n');
}
