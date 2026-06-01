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
  /** The product's tables — what already gets materialised. Each row
   *  exposes its current columns and the full transformation_sql so the
   *  AI can produce surgical edits. */
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
      /** From column_lineage — which source col fed this product col. */
      sourceLineage: Array<{ sourceTable: string; sourceColumn: string }>;
    }>;
    /** Set when this entry is a shared dimension owned by another product.
     *  tableId/columns already point at the owner (so proposals target the
     *  canonical rows); this records the blast radius for the UI. */
    sharedFrom?: { ownerProductName: string; affectedProducts: Array<{ id: number; name: string }> };
  }>;
  /** Source-layer schemas the product can pull from. Includes this
   *  product's own connection plus every dependency product's connection.
   *  The AI uses these to answer "add a column from source X" without
   *  having to guess what columns exist. */
  sourceConnections: Array<{
    connectionName: string;
    connectorType: string | null;
    tables: Array<{
      sourceTableName: string;
      description: string | null;
      columns: Array<{
        columnName: string;
        dataType: string;
        description: string | null;
        /** Sample values from quality profiling — null when unprofiled. */
        topValues: string[] | null;
        nullPct: number | null;
        distinctCount: number | null;
      }>;
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

/**
 * When a proposal targets a shared dimension (one product edits a
 * dimension owned by another), this records the blast radius so the UI
 * can warn "approving changes it for everyone" and offer to refresh the
 * affected products. Populated server-side after the AI responds; the
 * model never sees or sets it.
 */
export interface SharedDimImpact {
  ownerProductName: string;
  /** Every product that uses this dimension (owner + dependents). */
  affectedProducts: Array<{ id: number; name: string }>;
}

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
  /** Present only when product_table_id is a shared dimension. */
  shared?: SharedDimImpact;
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
  /** Present only when product_table_id is a shared dimension. */
  shared?: SharedDimImpact;
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

You see two layers of schema in every prompt:
- PRODUCT SCHEMA — the current output tables. This is what the user is editing.
- SOURCE SCHEMA — the raw tables those output tables were built from. The
  user may ask you to pull a column the AI initially missed ("add a
  birth_date column from the customers source"). Reference source columns
  as <table>.<column> in transformation_sql; the column lineage on each
  product column shows where existing fields came from for context.

Hard rules:
- You may only target tables and columns that appear in PRODUCT SCHEMA or
  SOURCE SCHEMA. Never invent a column that isn't listed.
- If the user asks for data from a source column that exists in SOURCE
  SCHEMA but is NOT yet in any product table, you can pull it in via a
  modify_column on the relevant transformation_sql (extending the SELECT
  to include the new source field).
- For add_column / modify_column you MUST emit new_transformation_sql
  containing the FULL replacement SELECT. The runner writes it verbatim
  — no splicing. Include every existing column unless the user is dropping it.
- new_transformation_sql must be a single statement, no trailing semicolon,
  no CREATE TABLE wrapper.
- If the user's request is ambiguous (which table? which column? what
  aggregation? which source if multiple have the same column name?),
  return ask_clarification with the single question that would unblock
  you. Do NOT guess.
- If a column you'd need is in SOURCE SCHEMA but its top values / null %
  suggest the data is unreliable for the user's stated purpose, surface
  that in the proposal's reasoning so the user can decide.
- If the request needs a capability beyond add_column / modify_column /
  add_kpi (add a new table, change grain, drop a column, restructure a
  join, ingest a new source), return unsupported with a one-line reason
  and a suggested manual action.
- Lowercase SQL keywords. Double-quote identifiers with uppercase, spaces,
  or special chars.
- summary should be readable by a non-technical user. ("Adds a margin_pct
  column to fact_sales", not "ALTER TABLE fact_sales ADD COLUMN margin_pct
  NUMERIC")
- For add_column and modify_column: the summary MUST end with a second
  sentence telling the user "Refresh the table to see this in your data."
  Approving only updates the table's metadata + transformation_sql; the
  parquet on disk doesn't change until the next refresh runs the new SQL.
  Don't bury this — it's the difference between "you can query it now"
  and "you can query it after the next refresh." add_kpi does NOT need
  a refresh (KPIs are formulas evaluated at query time against existing
  data) so don't add the refresh sentence there.`;

export function buildRefineChatUser(
  context: RefineChatProductContext,
  userMessage: string,
): string {
  // ── Product layer (current output schema) ────────────────────────────────
  const tableLines = context.tables.map((t) => {
    const focusMarker = context.focusedTableId === t.tableId ? '  ← USER IS FOCUSED HERE' : '';
    const cols = t.columns
      .map((c) => {
        const role = c.columnRole ? ` [${c.columnRole}]` : '';
        const expr = c.transformationExpression ? ` = ${c.transformationExpression}` : '';
        const lineage = c.sourceLineage.length > 0
          ? `  ← ${c.sourceLineage.map((l) => `${l.sourceTable}.${l.sourceColumn}`).join(', ')}`
          : '';
        return `      id=${c.columnId} ${c.columnName} (${c.dataType})${role}${expr}${lineage}`;
      })
      .join('\n');
    const sql = t.transformationSql
      ? `    transformation_sql:\n${t.transformationSql.split('\n').map((l) => '      ' + l).join('\n')}`
      : '    (no transformation_sql)';
    return `  id=${t.tableId} ${t.tableName} [${t.tableRole}]${focusMarker}\n    columns:\n${cols}\n${sql}`;
  }).join('\n\n');

  // ── Source layer (raw schemas the product can pull from) ─────────────────
  // Compact: connector / table / column with type + sample values + null %.
  // The AI references these by `<connection>.<table>.<column>` — Phase 2
  // SQL still scans single-source warehouses, so the connection name is
  // mostly informational, but it disambiguates when two sources share a
  // table name.
  const sourceLines = context.sourceConnections.map((conn) => {
    const tables = conn.tables.map((t) => {
      const cols = t.columns.map((c) => {
        const profile: string[] = [];
        if (c.distinctCount != null) profile.push(`${c.distinctCount} distinct`);
        if (c.nullPct != null) profile.push(`${(c.nullPct * 100).toFixed(0)}% null`);
        if (c.topValues && c.topValues.length > 0) {
          const sample = c.topValues.slice(0, 3).map((v) => JSON.stringify(v)).join(', ');
          profile.push(`top: ${sample}`);
        }
        const profileBlock = profile.length > 0 ? ` { ${profile.join(' · ')} }` : '';
        const desc = c.description ? `  — ${c.description}` : '';
        return `      ${c.columnName} (${c.dataType})${profileBlock}${desc}`;
      }).join('\n');
      const tdesc = t.description ? `  — ${t.description}` : '';
      return `    ${t.sourceTableName}${tdesc}\n${cols}`;
    }).join('\n\n');
    return `  ${conn.connectionName}${conn.connectorType ? ` [${conn.connectorType}]` : ''}:\n${tables}`;
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

  const sourceBlock = context.sourceConnections.length > 0
    ? `\nSOURCE SCHEMA (raw tables the product can pull from — reference by table.column):\n${sourceLines}\n`
    : '';

  return [
    `PRODUCT: ${context.productName}`,
    context.productDescription ? `DESCRIPTION: ${context.productDescription}` : '',
    '',
    'PRODUCT SCHEMA (the current output — what users see in dashboards):',
    tableLines,
    sourceBlock,
    kpiBlock,
    recentBlock,
    `USER REQUEST: ${userMessage}`,
    '',
    'Produce the JSON proposal now.',
  ].filter(Boolean).join('\n');
}
