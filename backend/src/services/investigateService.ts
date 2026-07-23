/**
 * Investigate service — runs the multi-step "why?" agent loop.
 *
 * Orchestration:
 *   1. AI plans the next step (hypothesis + SQL) OR signals "conclude"
 *   2. Backend executes the SQL against the product warehouse
 *   3. AI summarises the result into a one-sentence finding
 *   4. Repeat (max 6 steps) until AI says conclude
 *   5. AI writes the final 3-5 sentence conclusion
 *
 * Each step is persisted as it completes, and emitted via an event
 * callback so a SSE route can stream them to the user. Frontend
 * shows the trail building live — that's the magic the dream is
 * after.
 *
 * Hard caps:
 *   - 6 steps max (stops the agent looping forever)
 *   - 30s per SQL query (DuckDB connector default)
 *   - LIMIT 50 added to every query as a safety net
 *
 * Failure handling: a single step's failure (bad SQL, missing column)
 * doesn't abort the investigation — the error is recorded as that
 * step's "finding" and the agent gets to decide whether to retry,
 * pivot, or conclude with low confidence.
 */

import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import { logger } from '../utils/logger';
import { createProductConnector } from '../connectors/ConnectorFactory';
import { assertSafeReadQuery } from '../utils/sqlGuard';
import {
  type InvestigateAgentContext,
} from '../ai/prompts/investigateAgentPrompt';

const MAX_STEPS = 6;
const SAFETY_ROW_LIMIT = 50;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InvestigationStatus = 'running' | 'concluded' | 'failed' | 'cancelled';

export interface Investigation {
  id: number;
  user_id: number;
  data_product_id: number;
  pulse_entry_id: number | null;
  brief_id: number | null;
  question: string;
  focus: string | null;
  status: InvestigationStatus;
  conclusion: string | null;
  conclusion_confidence: 'high' | 'medium' | 'low' | null;
  /** AI-written next questions, set on conclude. Empty for older rows. */
  conclusion_followups: string[];
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
  steps: InvestigationStep[];
}

export interface InvestigationStep {
  id: number;
  position: number;
  hypothesis: string;
  query_sql: string | null;
  finding: string | null;
  result_preview: Array<Record<string, unknown>> | null;
  result_row_count: number | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Events emitted by the agent loop. The SSE route translates these
 *  to `event:` lines and sends them to the browser as the run unfolds. */
export type InvestigateEvent =
  | { type: 'step_started'; step: InvestigationStep }
  | { type: 'step_completed'; step: InvestigationStep }
  | { type: 'concluded'; investigation: Investigation }
  | { type: 'failed'; investigation: Investigation; reason: string };

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

export async function getInvestigation(
  tenantId: number,
  investigationId: number,
): Promise<Investigation | null> {
  return tenantQuery(tenantId, async (trx) => {
    const inv = await trx('investigations').where({ id: investigationId }).first();
    if (!inv) return null;
    const steps = await trx('investigation_steps')
      .where({ investigation_id: investigationId })
      .orderBy('position', 'asc');
    return mapInvestigation(inv, steps);
  });
}

// ---------------------------------------------------------------------------
// Start an investigation — this is the long-running orchestration.
// Caller passes an `onEvent` callback so the SSE route can stream.
// Returns the final Investigation when done (or failed).
// ---------------------------------------------------------------------------

export interface StartInvestigationInput {
  tenantId: number;
  userId: number;
  dataProductId: number;
  question: string;
  focus?: string | null;
  pulseEntryId?: number | null;
  briefId?: number | null;
}

export async function startInvestigation(
  input: StartInvestigationInput,
  onEvent: (e: InvestigateEvent) => void,
): Promise<Investigation> {
  // 1. Persist the investigation row (status=running) immediately so
  //    a) the SSE consumer has an id to listen for, and b) a refresh
  //    after a connection drop can find the trail.
  const invId = await tenantQuery(input.tenantId, async (trx) => {
    const [row] = await trx('investigations').insert({
      user_id: input.userId,
      data_product_id: input.dataProductId,
      pulse_entry_id: input.pulseEntryId ?? null,
      brief_id: input.briefId ?? null,
      question: input.question,
      focus: input.focus ?? null,
      status: 'running',
    }).returning('id');
    return typeof row === 'object' ? Number((row as { id: number }).id) : Number(row);
  });

  try {
    return await runAgentLoop(input.tenantId, invId, onEvent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, invId }, 'investigateService: agent loop crashed');
    await tenantQuery(input.tenantId, (trx) =>
      trx('investigations').where({ id: invId }).update({
        status: 'failed',
        failure_reason: msg,
        completed_at: new Date().toISOString(),
      }),
    );
    const final = await getInvestigation(input.tenantId, invId);
    if (final) onEvent({ type: 'failed', investigation: final, reason: msg });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The agent loop (internal)
// ---------------------------------------------------------------------------

async function runAgentLoop(
  tenantId: number,
  invId: number,
  onEvent: (e: InvestigateEvent) => void,
): Promise<Investigation> {
  // Build context once — the schema doesn't change mid-investigation.
  const ctxBase = await loadAgentContext(tenantId, invId);
  if (!ctxBase) throw new Error('Investigation context could not be loaded');

  // Open a DuckDB connector for this product. One connector for the
  // whole loop — every step's query runs through it.
  const connector = await createProductConnector('warehouse', ctxBase.connectionId, tenantId);
  await connector.connect();

  const priorSteps: InvestigateAgentContext['priorSteps'] = [];
  const stepRecords: Array<{ position: number; hypothesis: string; finding: string; error: string | null }> = [];

  try {
    for (let position = 1; position <= MAX_STEPS; position++) {
      const decision = await planNext(ctxBase, priorSteps);

      if (decision.kind === 'conclude') {
        break;
      }

      // 1. Insert step row as running so the UI can show the spinner.
      const stepId = await insertStep(tenantId, invId, position, decision.hypothesis, decision.query_sql);
      const startedStep: InvestigationStep = {
        id: stepId,
        position,
        hypothesis: decision.hypothesis,
        query_sql: decision.query_sql,
        finding: null,
        result_preview: null,
        result_row_count: null,
        status: 'running',
        error_message: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      };
      onEvent({ type: 'step_started', step: startedStep });

      // 2. Execute the SQL. Wrap in try/catch — failure goes back to
      //    the agent as input, not as a hard stop.
      let finding = '';
      let preview: Array<Record<string, unknown>> | null = null;
      let rowCount: number | null = null;
      let stepStatus: InvestigationStep['status'] = 'success';
      let errorMsg: string | null = null;

      try {
        // Security guard on the agent-authored SQL (see sqlGuard).
        assertSafeReadQuery(decision.query_sql);
        const safeSql = withRowLimit(decision.query_sql);
        const result = await connector.executeQuery(safeSql);
        rowCount = result.rows.length;
        preview = result.rows.slice(0, 5) as Array<Record<string, unknown>>;
        finding = await summariseStep(decision.hypothesis, decision.query_sql, rowCount, preview);
      } catch (err) {
        stepStatus = 'failed';
        errorMsg = err instanceof Error ? err.message : String(err);
        finding = `error: ${errorMsg}`;
      }

      // 3. Persist the final state of this step + emit the completion event.
      await tenantQuery(tenantId, (trx) =>
        trx('investigation_steps').where({ id: stepId }).update({
          finding: stepStatus === 'success' ? finding : null,
          result_preview: preview ? JSON.stringify(preview) : null,
          result_row_count: rowCount,
          status: stepStatus,
          error_message: errorMsg,
          completed_at: new Date().toISOString(),
        }),
      );
      const completedStep: InvestigationStep = {
        ...startedStep,
        finding: stepStatus === 'success' ? finding : null,
        result_preview: preview,
        result_row_count: rowCount,
        status: stepStatus,
        error_message: errorMsg,
        completed_at: new Date().toISOString(),
      };
      onEvent({ type: 'step_completed', step: completedStep });

      // 4. Add to context for the next planNext call.
      priorSteps.push({
        position,
        hypothesis: decision.hypothesis,
        findingOrError: finding,
        rowCount,
      });
      stepRecords.push({
        position,
        hypothesis: decision.hypothesis,
        finding: stepStatus === 'success' ? finding : '',
        error: errorMsg,
      });
    }
  } finally {
    try { await connector.disconnect(); } catch { /* ignore */ }
  }

  // 5. Conclude.
  const { investigateConclude } = await import('../ai/AIService');
  const conclusion = await investigateConclude({
    question: ctxBase.question,
    focus: ctxBase.focus,
    productName: ctxBase.productName,
    steps: stepRecords,
  });

  await tenantQuery(tenantId, (trx) =>
    trx('investigations').where({ id: invId }).update({
      status: 'concluded',
      conclusion: conclusion.conclusion,
      conclusion_confidence: conclusion.confidence,
      conclusion_followups: JSON.stringify(conclusion.followUps ?? []),
      completed_at: new Date().toISOString(),
    }),
  );

  const final = await getInvestigation(tenantId, invId);
  if (!final) throw new Error('investigation vanished post-conclude');
  onEvent({ type: 'concluded', investigation: final });
  return final;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function planNext(
  ctxBase: InvestigateAgentContext & { connectionId: number },
  priorSteps: InvestigateAgentContext['priorSteps'],
): Promise<{ kind: 'step'; hypothesis: string; query_sql: string } | { kind: 'conclude'; reason: string }> {
  const { investigatePlanNext } = await import('../ai/AIService');
  return investigatePlanNext({ ...ctxBase, priorSteps });
}

async function summariseStep(
  hypothesis: string,
  querySql: string,
  rowCount: number,
  resultPreview: Array<Record<string, unknown>>,
): Promise<string> {
  const { investigateSummariseStep } = await import('../ai/AIService');
  return investigateSummariseStep({ hypothesis, querySql, rowCount, resultPreview });
}

async function insertStep(
  tenantId: number,
  invId: number,
  position: number,
  hypothesis: string,
  querySql: string,
): Promise<number> {
  return tenantQuery(tenantId, async (trx) => {
    const [row] = await trx('investigation_steps').insert({
      investigation_id: invId,
      position,
      hypothesis,
      query_sql: querySql,
      status: 'running',
    }).returning('id');
    return typeof row === 'object' ? Number((row as { id: number }).id) : Number(row);
  });
}

/**
 * Defensively append/clamp a LIMIT clause so a misjudged hypothesis
 * doesn't return a million rows. We don't try to parse the SQL — just
 * append `LIMIT N` if there's no existing one.
 */
function withRowLimit(sql: string): string {
  const stripped = sql.trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+\b/i.test(stripped)) return stripped;
  return `${stripped}\nLIMIT ${SAFETY_ROW_LIMIT}`;
}

async function loadAgentContext(
  tenantId: number,
  invId: number,
): Promise<(InvestigateAgentContext & { connectionId: number }) | null> {
  return tenantQuery(tenantId, async (trx) => {
    const inv = await trx('investigations').where({ id: invId }).first();
    if (!inv) return null;

    const product = await trx('data_products').where({ id: inv.data_product_id }).first();
    if (!product) return null;

    const tables = await trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .where('ss.data_product_id', inv.data_product_id)
      .select('pt.id', 'pt.table_name', 'pt.table_role')
      .orderBy(['pt.dag_order', 'pt.table_name']);

    const tableIds = tables.map((t) => Number(t.id));
    const columns = tableIds.length > 0
      ? await trx('product_columns')
          .whereIn('product_table_id', tableIds)
          // Hide technical columns (`_row_hash`; future SCD2 metadata) from
          // the investigate-agent's schema context.
          .andWhere((qb) => qb.where('is_technical', false).orWhereNull('is_technical'))
          .orderBy(['product_table_id', 'sort_order'])
          .select('product_table_id', 'column_name', 'data_type', 'column_role', 'description')
      : [];

    const colsByTable = new Map<number, typeof columns>();
    for (const c of columns) {
      const list = colsByTable.get(Number(c.product_table_id)) ?? [];
      list.push(c);
      colsByTable.set(Number(c.product_table_id), list);
    }

    const kpis = await trx('product_kpis')
      .where({ data_product_id: inv.data_product_id })
      .select('name', 'description', 'formula_sql');

    return {
      question: String(inv.question),
      focus: inv.focus ? String(inv.focus) : null,
      productName: String(product.name),
      productDescription: product.description ? String(product.description) : null,
      connectionId: Number(product.connection_id),
      tables: tables.map((t) => ({
        tableName: String(t.table_name),
        tableRole: String(t.table_role),
        columns: (colsByTable.get(Number(t.id)) ?? []).map((c) => ({
          columnName: String(c.column_name),
          dataType: String(c.data_type),
          columnRole: c.column_role ? String(c.column_role) : null,
          description: c.description ? String(c.description) : null,
        })),
      })),
      kpis: kpis.map((k) => ({
        name: String(k.name),
        description: k.description ? String(k.description) : null,
        formulaSql: k.formula_sql ? String(k.formula_sql) : null,
      })),
      priorSteps: [],
      maxSteps: MAX_STEPS,
    };
  });
}

function mapInvestigation(inv: Record<string, unknown>, stepRows: Array<Record<string, unknown>>): Investigation {
  return {
    id: Number(inv.id),
    user_id: Number(inv.user_id),
    data_product_id: Number(inv.data_product_id),
    pulse_entry_id: inv.pulse_entry_id != null ? Number(inv.pulse_entry_id) : null,
    brief_id: inv.brief_id != null ? Number(inv.brief_id) : null,
    question: String(inv.question),
    focus: inv.focus ? String(inv.focus) : null,
    status: String(inv.status) as InvestigationStatus,
    conclusion: inv.conclusion ? String(inv.conclusion) : null,
    conclusion_confidence: (inv.conclusion_confidence as Investigation['conclusion_confidence']) ?? null,
    conclusion_followups: parseFollowUps(inv.conclusion_followups),
    failure_reason: inv.failure_reason ? String(inv.failure_reason) : null,
    created_at: String(inv.created_at),
    completed_at: inv.completed_at ? String(inv.completed_at) : null,
    steps: stepRows.map((s) => mapStep(s)),
  };
}

/** jsonb may arrive as a parsed array or a string depending on the driver. */
function parseFollowUps(raw: unknown): string[] {
  if (!raw) return [];
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).map((q) => q.trim());
}

function mapStep(s: Record<string, unknown>): InvestigationStep {
  let preview: Array<Record<string, unknown>> | null = null;
  if (s.result_preview) {
    try {
      preview = typeof s.result_preview === 'string'
        ? JSON.parse(s.result_preview as string) as Array<Record<string, unknown>>
        : s.result_preview as Array<Record<string, unknown>>;
    } catch { preview = null; }
  }
  return {
    id: Number(s.id),
    position: Number(s.position),
    hypothesis: String(s.hypothesis),
    query_sql: s.query_sql ? String(s.query_sql) : null,
    finding: s.finding ? String(s.finding) : null,
    result_preview: preview,
    result_row_count: s.result_row_count != null ? Number(s.result_row_count) : null,
    status: String(s.status) as InvestigationStep['status'],
    error_message: s.error_message ? String(s.error_message) : null,
    created_at: String(s.created_at),
    completed_at: s.completed_at ? String(s.completed_at) : null,
  };
}
