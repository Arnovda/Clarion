import { Router, Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createDashboardSchema, updateDashboardSchema, batchExecuteSchema, refineDashboardSchema, fixWidgetSchema, generateDashboardSchema, refineSpecSchema, pinWidgetSchema, saveMyViewSchema, clearMyViewSchema } from '../middleware/schemas';
import { semanticDb } from '../db/knex';
import { createConnector, createProductConnector } from '../connectors/ConnectorFactory';
import { generateDashboardSpec, generateDashboardRefinement, refineDashboardSpec, validateAndFixDashboardSpec, checkWidgetSemantics, SqlDialect, explainWidget, generateDashboardInsights, planInvestigation, synthesizeInvestigation, narrateDashboard, planDashboardEdit, editWidgetSql, generateSingleWidget } from '../ai/AIService';
import { DashboardSpec, WidgetSpec, RefinementOutput, WidgetExecutionResult } from '../ai/prompts/dashboardPrompt';
import { buildSemanticContextForQuery } from '../db/semanticGraph';
import { buildProductSemanticContext, getProductWarehousePath } from '../services/productContext';
import { parsePagination, paginatedResponse } from '../utils/paginate';
import { buildXlsxFromRows, buildCsvFromRows, buildXlsx } from '../utils/xlsxBuilder';
import { getWidgetCache, putWidgetCache } from '../services/widgetCache';
import { getFilterOptionsCache, putFilterOptionsCache } from '../services/filterOptionsCache';
import { reqDb } from '../db/reqDb';
import { validateWidgetColumns } from '../shared/widgetContracts';
import { preserveSpecCarryover, diffSpecChanges } from '../services/dashboardSpecMerge';
import { applyEditOps, pendingSqlEdits, realRefusals, isDeterministicOp, type DashboardEditOp } from '../services/dashboardEditOps';
import { startSSE } from '../services/sse';
import { assertSafeReadQuery, isSafeReadQuery, assertNoExternalAccess } from '../utils/sqlGuard';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'dashboards' });

const router = Router();

// ---------------------------------------------------------------------------
// Helper — build semantic + relationship context strings for a connection
// ---------------------------------------------------------------------------

async function buildSemanticContext(
  connectionId: number,
  tenantId: number,
): Promise<{ semanticContext: string; relationshipContext: string }> {
  const { tables, columns, relationships } = await buildSemanticContextForQuery(connectionId, tenantId);

  const semanticContext = (tables as { id: number; table_name: string; description: string }[])
    .map((t) => {
      const cols = (columns as { table_id: number; column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }[])
        .filter((c) => c.table_id === t.id)
        .map((c) =>
          `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`,
        )
        .join('\n');
      return `Table: ${t.table_name} — ${t.description ?? ''}\n  Columns:\n${cols}`;
    })
    .join('\n\n');

  const relationshipContext = relationships.length
    ? (relationships as { from_table: string; from_column: string | null; to_table: string; to_column: string | null; relationship_type: string; description: string | null }[])
        .map((r) => {
          const from = r.from_column ? `${r.from_table}.${r.from_column}` : r.from_table;
          const to   = r.to_column   ? `${r.to_table}.${r.to_column}`     : r.to_table;
          return `- ${from} → ${to} (${r.relationship_type})${r.description ? `: ${r.description}` : ''}`;
        })
        .join('\n')
    : 'No relationships defined yet — avoid JOINs unless you are certain of the key columns.';

  return { semanticContext, relationshipContext };
}

// ---------------------------------------------------------------------------
// Helper — apply default filter values to SQL placeholders
// ---------------------------------------------------------------------------

function applyDefaultFilters(sql: string): string {
  return sql
    .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
    .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
    .replace(/\{\{[^}]+\}\}/g, 'all');
}

// ---------------------------------------------------------------------------
// Helper — rewrite PostgreSQL-only SQL functions to DuckDB equivalents
// ---------------------------------------------------------------------------

function fixDuckDbDialect(sql: string): string {
  let fixed = sql;
  // to_char(date_col, 'YYYY-MM') → strftime(date_col, '%Y-%m')
  fixed = fixed.replace(
    /to_char\s*\(\s*([^,]+?)\s*,\s*'([^']+)'\s*\)/gi,
    (_match, col, fmt) => {
      const duckFmt = fmt
        .replace(/YYYY/g, '%Y').replace(/YY/g, '%y')
        .replace(/MM/g, '%m').replace(/DD/g, '%d')
        .replace(/HH24/g, '%H').replace(/MI/g, '%M').replace(/SS/g, '%S')
        .replace(/Mon/g, '%b').replace(/Month/g, '%B')
        .replace(/Dy/g, '%a').replace(/Day/g, '%A')
        .replace(/-/g, '-');
      return `strftime(${col.trim()}, '${duckFmt}')`;
    },
  );
  // to_date(str, fmt) → CAST(str AS DATE)
  fixed = fixed.replace(
    /to_date\s*\(\s*([^,]+?)\s*,\s*'[^']*'\s*\)/gi,
    (_match, val) => `CAST(${val.trim()} AS DATE)`,
  );
  return fixed;
}

// ---------------------------------------------------------------------------
// Helper — resolve filter placeholders in widget SQL and normalise dialect
// ---------------------------------------------------------------------------

function resolveWidgetFilters(sql: string, filterValues: Record<string, string>): string {
  let resolved = sql;
  for (const [key, value] of Object.entries(filterValues)) {
    const raw = value || (key.endsWith('_from') ? '1900-01-01' : key.endsWith('_to') ? '2099-12-31' : 'all');
    // Escape single quotes so a filter value can't break out of the string
    // literal it's substituted into (fixes both the O'Brien functional bug and
    // quote-context SQL injection). Values in numeric context contain no quotes.
    const replacement = raw.replace(/'/g, "''");
    resolved = resolved.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), replacement);
  }
  const out = fixDuckDbDialect(
    resolved
      .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
      .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
      .replace(/\{\{[^}]+\}\}/g, 'all'),
  );
  // Re-check the FULLY-SUBSTITUTED SQL for external access: escaping stops
  // string-context breakouts, but a placeholder in numeric/identifier context
  // (`WHERE id = {{x}}`) could still smuggle a path/URI. The template was
  // already validated; this catches injection via the substituted value.
  assertNoExternalAccess(out);
  return out;
}

// ---------------------------------------------------------------------------
// Helper — execute all widgets with default filters, return results for validation
// ---------------------------------------------------------------------------

async function executeSpecForValidation(
  spec: DashboardSpec,
  connectionId: number,
  tenantId?: number,
  dataLayer?: 'product' | 'source',
): Promise<WidgetExecutionResult[]> {
  // Wrap all RLS-dependent queries in a single transaction
  const useSource = dataLayer === 'source';
  const { connection, productPath } = await semanticDb.transaction(async (trx) => {
    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
    const conn = await trx('connections').where({ id: connectionId }).first();
    const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
    return { connection: conn, productPath: pp };
  });
  if (!connection) return [];

  const connector = productPath
    ? await createProductConnector(productPath, connection.id, tenantId)
    : await createConnector(connection);
  await connector.connect();

  try {
    const results = await Promise.all(
      spec.widgets.map(async (widget) => {
        if (!isSafeReadQuery(widget.sql)) {
          return {
            id: widget.id,
            title: widget.title,
            type: widget.type,
            rowCount: 0,
            error: 'Widget SQL refused for safety',
            sampleRows: [],
          } satisfies WidgetExecutionResult;
        }
        const resolvedSql = fixDuckDbDialect(applyDefaultFilters(widget.sql));
        try {
          const result = await connector.executeQuery(resolvedSql);
          const rows = result.rows as Record<string, unknown>[];
          return {
            id: widget.id,
            title: widget.title,
            type: widget.type,
            rowCount: rows.length,
            sampleRows: rows.slice(0, 3),
          } satisfies WidgetExecutionResult;
        } catch (err: unknown) {
          return {
            id: widget.id,
            title: widget.title,
            type: widget.type,
            rowCount: 0,
            error: err instanceof Error ? err.message : String(err),
            sampleRows: [],
          } satisfies WidgetExecutionResult;
        }
      }),
    );
    return results;
  } finally {
    connector.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Helper — full validation + repair pass over a spec (best-effort).
//
// Executes widget SQLs with default filters, runs the deterministic
// column-contract check (shared/widgetContracts.ts), the Haiku semantic
// check, and — if anything is broken — one Sonnet repair call. Never throws:
// on failure the input spec is returned unrepaired and the failure is logged
// loudly. `onlyWidgetIds` scopes execution to a subset (used by refine-spec
// to validate just the widgets the refinement changed).
// ---------------------------------------------------------------------------

async function validateAndRepairSpec(
  spec: DashboardSpec,
  connectionId: number,
  tenantId: number | undefined,
  dataLayer: 'product' | 'source' | undefined,
  semanticCtx: { semanticContext: string; relationshipContext: string },
  onlyWidgetIds?: Set<string>,
): Promise<DashboardSpec> {
  try {
    const widgetsToCheck = onlyWidgetIds
      ? spec.widgets.filter((w) => onlyWidgetIds.has(w.id))
      : spec.widgets;
    if (widgetsToCheck.length === 0) return spec;

    const executionResults = await executeSpecForValidation(
      { ...spec, widgets: widgetsToCheck },
      connectionId,
      tenantId,
      dataLayer,
    );

    // Deterministic column-contract check — a widget whose SQL doesn't
    // return the exact column names its type requires (label/value/series/…)
    // renders as an EMPTY card, not an error, so it would otherwise slip
    // through validation entirely.
    for (const r of executionResults) {
      if (!r.error && r.rowCount > 0) {
        const issue = validateWidgetColumns(r.type, r.sampleRows);
        if (issue) r.contractIssue = issue;
      }
    }

    // Semantic check in parallel — skip widgets that already failed (error or 0 rows).
    const semanticIssues = await Promise.all(
      executionResults.map(async (r) => {
        if (r.error || r.rowCount === 0) return null;
        return checkWidgetSemantics(r.title, r.type, r.sampleRows);
      }),
    );
    semanticIssues.forEach((issue, idx) => {
      if (issue) executionResults[idx].semanticIssue = issue;
    });

    const hasIssues = executionResults.some(
      (r) => r.error || r.rowCount === 0 || r.semanticIssue || r.contractIssue
        || (r.type === 'pie_chart' && r.rowCount > 3),
    );
    if (hasIssues) {
      const repaired = await validateAndFixDashboardSpec(
        spec, executionResults, semanticCtx.semanticContext, semanticCtx.relationshipContext,
      );
      // The pass ran, so clear any stale marker carried in from a previous
      // generation (refine-spec re-validates an existing spec).
      delete repaired.validation;
      return repaired;
    }
    delete spec.validation;
    return spec;
  } catch (validationErr) {
    // Still best-effort: a transient warehouse timeout must not throw away a
    // dashboard that is probably fine. But it no longer passes silently — the
    // spec is MARKED unvalidated so the UI can say so. Returning an unchecked
    // spec that looks exactly like a checked one is the part that was wrong.
    const reason = validationErr instanceof Error ? validationErr.message : String(validationErr);
    log.warn({ err: reason }, 'dashboard validation pass failed — returning spec marked unvalidated');
    return { ...spec, validation: { ok: false, reason } };
  }
}

// ---------------------------------------------------------------------------
// POST /api/dashboards/generate
// ---------------------------------------------------------------------------

router.post('/generate', requireAuth, validate(generateDashboardSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, request, answers, productIds, dataLayer } = req.body as {
      connectionId: number;
      request: string;
      /** {question, answer} pairs from the refinement step; legacy clients send bare strings. */
      answers?: Array<string | { question: string; answer: string }>;
      productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    // Append the refinement answers WITH their questions — an answer like
    // "Last 30 days" carries no meaning as a bare bullet; the model needs to
    // know what it was answering to honour it (e.g. as a filter defaultPreset).
    const answerLines = (answers ?? [])
      .map((a) => {
        if (typeof a === 'string') return a.trim() ? `- ${a.trim()}` : null;
        const q = a.question?.trim();
        const ans = a.answer?.trim();
        if (!ans) return null;
        return q ? `- ${q} → ${ans}` : `- ${ans}`;
      })
      .filter((l): l is string => l !== null);
    const fullRequest = answerLines.length
      ? `${request}\n\nThe user answered these clarifying questions — honour every answer (time windows become the date filter's defaultPreset):\n${answerLines.join('\n')}`
      : request;

    // Default = product layer (cleaner Kimball star schema). Honour explicit
    // 'source' opt-in for users who want raw source-layer dashboards.
    const productCtx = dataLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId, req.user!.tenantId);

    // Determine SQL dialect from the connection's query engine
    const connection = await db('connections').where({ id: connectionId }).first();
    const dialect: SqlDialect = productCtx ? 'duckdb' : (connection?.query_engine === 'duckdb' ? 'duckdb' : 'sqlite');

    let spec = await generateDashboardSpec(
      fullRequest,
      semanticCtx.semanticContext,
      semanticCtx.relationshipContext,
      dialect,
      productCtx?.kpiFormulas ?? '',
    );

    spec = await validateAndRepairSpec(spec, connectionId, req.user!.tenantId, dataLayer, semanticCtx);

    // Stamp the generation context onto the spec so a saved dashboard restores
    // the SAME context on open (refinements would otherwise fall back to every
    // approved product on the wrong connection).
    spec.dataLayer = dataLayer === 'source' ? 'source' : 'product';
    if (productIds?.length) spec.productIds = productIds;

    res.json({ ok: true, data: { spec } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine — get clarifying questions before generation
// ---------------------------------------------------------------------------

router.post('/refine', requireAuth, validate(refineDashboardSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, request, productIds, dataLayer } = req.body as {
      connectionId: number; request: string; productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    const productCtx = dataLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId, req.user!.tenantId);
    const result: RefinementOutput = await generateDashboardRefinement(request, semanticCtx.semanticContext, semanticCtx.relationshipContext);

    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine-spec — update an existing spec based on user feedback
// ---------------------------------------------------------------------------

router.post('/refine-spec', requireAuth, validate(refineSpecSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, refinement, currentSpec, productIds, dataLayer } = req.body as {
      connectionId: number;
      refinement: string;
      currentSpec: DashboardSpec;
      productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    // Prefer the context stamped on the spec at generation time — a reopened
    // dashboard's client state may not carry the original product scope.
    const effectiveProductIds = productIds?.length ? productIds : currentSpec.productIds;
    const effectiveLayer = dataLayer ?? currentSpec.dataLayer;

    const productCtx = effectiveLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, effectiveProductIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId, req.user!.tenantId);

    // Strip app-managed noise from what the model sees: `insights` describe
    // the pre-refine dashboard (stale after any change, and pure token cost),
    // `validation` is a transient marker.
    const { insights: _insights, validation: _validation, ...specForAI } = currentSpec;
    let spec = await refineDashboardSpec(
      refinement,
      specForAI as DashboardSpec,
      semanticCtx.semanticContext,
      semanticCtx.relationshipContext,
      productCtx?.kpiFormulas ?? '',
    );

    // Deterministic carryover: user-arranged layout survives the full-spec
    // regeneration even when the model failed to echo it; productIds/dataLayer
    // are inherited; stale insights are dropped.
    spec = preserveSpecCarryover(currentSpec, spec);

    // Validate only what the refinement actually changed — new widgets and
    // widgets whose SQL/type was rewritten. Untouched widgets were already
    // validated when first generated; re-executing them would double the
    // pass's cost and latency for no signal.
    const before = new Map(currentSpec.widgets.map((w) => [w.id, w]));
    const changedIds = new Set(
      spec.widgets
        .filter((w) => {
          const prev = before.get(w.id);
          return !prev || prev.sql !== w.sql || prev.type !== w.type;
        })
        .map((w) => w.id),
    );
    spec = await validateAndRepairSpec(spec, connectionId, req.user!.tenantId, effectiveLayer, semanticCtx, changedIds);
    // The repair call can also drop carryover fields — re-apply after it too.
    spec = preserveSpecCarryover(currentSpec, spec);
    // Stamp the context this refine actually ran against.
    spec.dataLayer = effectiveLayer === 'source' ? 'source' : 'product';
    if (effectiveProductIds?.length) spec.productIds = effectiveProductIds;

    // Tell the client exactly what changed so it can say more than
    // "Dashboard updated" — and clear its caches for just those widgets.
    const changes = diffSpecChanges(currentSpec, spec);

    res.json({ ok: true, data: { spec, changes } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine-spec-stream — the tiered, VISIBLE refine path
//
// The plain /refine-spec above is one opaque full-spec regeneration: slow in
// proportion to the dashboard rather than to the request, destructive to
// widgets nobody asked about, and silent for the whole minute it runs (the
// user saw three dots and nothing else — the complaint that prompted this
// endpoint). This route replaces it for interactive use; the non-stream
// endpoint stays for API compatibility.
//
// Tiers, cheapest first:
//   PLAN     — one Haiku call over a SQL-free digest decides WHAT to change
//              (ai/prompts/dashboardEditPlanPrompt). Milliseconds of tokens.
//   APPLY    — structural ops (filters, chart-type swaps, renames, removals,
//              top-N) are executed by the app itself, exactly, with no AI call
//              (services/dashboardEditOps).
//   SCOPED   — ops that need a model (rewrite ONE widget's SQL, create ONE
//              widget) run as small parallel calls that each see one statement.
//   CHECK    — only the widgets that changed are executed against the real
//              warehouse; a failure gets ONE scoped repair, then reverts to
//              its previous working self rather than shipping broken.
//   ESCALATE — a request the planner can't express as ops ("rebuild this as an
//              executive overview") falls back to the full-spec path above.
//
// Every stage is an SSE event, so the chat can show a live checklist instead
// of dots — which is the other half of the fix: the same minute feels short
// when you can watch it, and most requests no longer take a minute at all.
//
// Events: `phase {text}` · `plan {summary, steps[]}` · `step {id, status,
// note?, label?, parentId?}` · `done {spec, changes, notes, refusals}` ·
// `error {error}`. A `step` carrying a `label` for an id the client has not
// seen APPENDS a step — the server discovers work during APPLY (one filter
// can need N cards rewritten) and each of those gets its own visible line
// under the op that caused it, rather than one line sitting silent.
//
// `scopeWidgetId` in the body narrows the whole pipeline to a single card:
// the planner is shown only that widget, every returned op is filtered to it
// in code, and escalation is disabled — regenerating a dashboard is the one
// thing "change this card" must never do.
// ---------------------------------------------------------------------------

/** Business-language label for a plan step (never says SQL/spec/widget-id). */
function editOpLabel(op: DashboardEditOp, spec: DashboardSpec): string {
  const widgetTitle = (id: string) => spec.widgets.find((w) => w.id === id)?.title ?? 'a card';
  switch (op.op) {
    case 'add_filter': return `Add a ${op.filter.label || op.filter.column} filter`;
    case 'remove_filter': {
      const f = spec.filters.find((x) => x.id === op.filterId);
      return `Remove the ${f?.label ?? op.filterId} filter`;
    }
    case 'set_filter_default': {
      const f = spec.filters.find((x) => x.id === op.filterId);
      return `Change the default of the ${f?.label ?? op.filterId} filter`;
    }
    case 'remove_widget': return `Remove "${widgetTitle(op.widgetId)}"`;
    case 'retitle_widget': return `Rename "${widgetTitle(op.widgetId)}"`;
    case 'set_widget_type': return `Change "${widgetTitle(op.widgetId)}" to a ${op.widgetType.replace(/_/g, ' ').replace(' chart', '')} chart`;
    case 'set_widget_format': return `Show "${widgetTitle(op.widgetId)}" as ${op.format === 'currency' ? 'an amount' : op.format === 'percentage' ? 'a percentage' : 'a number'}`;
    case 'set_widget_limit': return `Show ${op.limit} rows in "${widgetTitle(op.widgetId)}"`;
    case 'retitle_dashboard': return 'Update the dashboard title';
    case 'sql_edit': return `Rework "${widgetTitle(op.widgetId)}"`;
    case 'add_widget': return `Add ${op.instruction}`;
  }
}

router.post('/refine-spec-stream', requireAuth, validate(refineSpecSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, refinement, currentSpec, productIds, dataLayer, scopeWidgetId } = req.body as {
      connectionId: number;
      refinement: string;
      currentSpec: DashboardSpec;
      productIds?: number[];
      dataLayer?: 'product' | 'source';
      /** Set when the user is editing ONE card rather than the dashboard. */
      scopeWidgetId?: string;
    };
    const tenantId = req.user!.tenantId;

    // Scoped edit: "change this card". The scope is enforced in CODE below —
    // the prompt is told about it, but every op the planner returns is filtered
    // against this widget id, because a request aimed at one card must not be
    // able to rearrange the dashboard around it.
    const scopeWidget = scopeWidgetId
      ? currentSpec.widgets.find((w) => w.id === scopeWidgetId)
      : undefined;
    if (scopeWidgetId && !scopeWidget) {
      res.status(400).json({ ok: false, error: 'That card is no longer on this dashboard.' });
      return;
    }

    const effectiveProductIds = productIds?.length ? productIds : currentSpec.productIds;
    const effectiveLayer = dataLayer ?? currentSpec.dataLayer;

    // Semantic context BEFORE the SSE handshake, so a context failure is a
    // normal JSON error, not a broken stream.
    const productCtx = effectiveLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, effectiveProductIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId, req.user!.tenantId);

    const sse = startSSE(res, { headers: { 'Cache-Control': 'no-cache, no-transform' } });
    const stamp = (spec: DashboardSpec): DashboardSpec => {
      const out = preserveSpecCarryover(currentSpec, spec);
      out.dataLayer = effectiveLayer === 'source' ? 'source' : 'product';
      if (effectiveProductIds?.length) out.productIds = effectiveProductIds;
      return out;
    };
    const finish = (spec: DashboardSpec, notes: string[], refusals: string[]) => {
      const finalSpec = stamp(spec);
      sse.emit({ type: 'done', spec: finalSpec, changes: diffSpecChanges(currentSpec, finalSpec), notes, refusals });
      sse.end();
    };
    // The full-spec path — used when the planner asks for it, and as the
    // safety net when the fast path itself fails.
    const escalate = async (why: string) => {
      // A scoped edit must never escalate: regenerating the whole dashboard is
      // the opposite of what "change just this card" asked for.
      if (scopeWidget) {
        log.warn({ why, widgetId: scopeWidget.id }, 'scoped edit failed — refusing to regenerate the dashboard');
        finish(currentSpec, [], [`Could not change "${scopeWidget.title}" — it was left as it was.`]);
        return;
      }
      sse.emit({ type: 'phase', text: 'Reworking the dashboard as a whole — this takes a little longer…' });
      log.info({ why }, 'refine-spec-stream: escalating to full regeneration');
      const { insights: _i, validation: _v, ...specForAI } = currentSpec;
      let spec = await refineDashboardSpec(
        refinement, specForAI as DashboardSpec,
        semanticCtx.semanticContext, semanticCtx.relationshipContext,
        productCtx?.kpiFormulas ?? '',
      );
      spec = preserveSpecCarryover(currentSpec, spec);
      const before = new Map(currentSpec.widgets.map((w) => [w.id, w]));
      const changedIds = new Set(
        spec.widgets.filter((w) => {
          const prev = before.get(w.id);
          return !prev || prev.sql !== w.sql || prev.type !== w.type;
        }).map((w) => w.id),
      );
      sse.emit({ type: 'phase', text: 'Checking the changed cards against your data…' });
      spec = await validateAndRepairSpec(spec, connectionId, tenantId, effectiveLayer, semanticCtx, changedIds);
      finish(spec, [], []);
    };

    try {
      sse.emit({
        type: 'phase',
        text: scopeWidget ? `Reading your request for "${scopeWidget.title}"…` : 'Reading your request…',
      });

      // The tiered fast path used to sit behind the August release, so that an
      // operator chose who got it. That gate is gone with the train: everyone
      // takes this path now. `escalate()` below is unchanged and still the
      // safety net — any failure in the planner or a scoped edit falls back to
      // the full-spec regeneration, which is the same result, slower.

      // ── PLAN ────────────────────────────────────────────────────────────
      // A scoped edit shows the planner ONLY the card in question, so it
      // cannot propose changes to cards it cannot see, and keeps the cheap
      // deterministic ops available: "show 20 rows" and "make it a bar chart"
      // stay instant, and only a genuine query change costs a model call.
      const planSpec = scopeWidget ? { ...currentSpec, widgets: [scopeWidget] } : currentSpec;
      const planRequest = scopeWidget
        ? `The user is editing ONLY the card titled "${scopeWidget.title}" (widget id ${scopeWidget.id}). `
          + 'Every op must target that widget id. Do not add or remove filters, do not add or remove cards, '
          + `do not retitle the dashboard.\n\nTheir request: ${refinement}`
        : refinement;

      let plan;
      try {
        plan = await planDashboardEdit(planRequest, planSpec, semanticCtx.semanticContext, semanticCtx.relationshipContext);
      } catch (planErr) {
        log.warn({ err: planErr instanceof Error ? planErr.message : String(planErr) }, 'edit planner failed — escalating');
        await escalate('planner error');
        return;
      }
      let rawOps = Array.isArray(plan.ops) ? (plan.ops as DashboardEditOp[]) : [];
      let summary = plan.summary;

      if (scopeWidget) {
        // Enforce the scope rather than trusting the prompt: drop anything
        // aimed elsewhere or at the dashboard as a whole.
        rawOps = rawOps.filter((op) => 'widgetId' in op && op.widgetId === scopeWidget.id);
        if (rawOps.length === 0) {
          // Either the planner asked to regenerate, or its whole plan was out
          // of scope. Both mean the same thing here: rewrite this one query.
          rawOps = [{ op: 'sql_edit', widgetId: scopeWidget.id, instruction: refinement }];
          summary = `Updating "${scopeWidget.title}".`;
        }
      } else if (plan.strategy !== 'ops' || rawOps.length === 0) {
        await escalate(plan.strategy === 'regenerate' ? 'planner chose regenerate' : 'empty plan');
        return;
      }
      if (sse.closed) return;

      // The plan, as a checklist the user can watch fill in.
      const steps = rawOps.map((op, i) => ({ id: `s${i}`, label: editOpLabel(op, currentSpec) }));
      sse.emit({ type: 'plan', summary, steps });

      // ── APPLY (deterministic, instant) ─────────────────────────────────
      const { spec: appliedSpec, applied } = applyEditOps(currentSpec, rawOps);
      let spec = appliedSpec;
      const notes: string[] = [];
      const refusals = realRefusals(applied);
      /** Widgets whose SQL gained a textually-injected filter predicate — if
       *  one fails the check below, the repair hands the model the ORIGINAL
       *  query and asks it to wire the filter in properly (usually a join). */
      const filterInjected = new Set<string>();

      // ── SCOPED model calls, in parallel ────────────────────────────────
      // Each handover gets its OWN step, appended under the op that produced
      // it. That is the difference between "Add a Customer filter ⟳" sitting
      // silent for half a minute and watching four named cards be rewritten
      // one by one — the same wait, legible.
      const sqlEdits = pendingSqlEdits(applied);
      const perOpHandovers = new Map<number, number>(); // planIndex → count still open
      const stepIdFor = new Map<typeof sqlEdits[number], string>();
      const subCounter = new Map<number, number>();
      for (const edit of sqlEdits) {
        if (!edit.label) { stepIdFor.set(edit, `s${edit.planIndex}`); continue; } // declared sql_edit owns its plan line
        const n = subCounter.get(edit.planIndex) ?? 0;
        subCounter.set(edit.planIndex, n + 1);
        stepIdFor.set(edit, `s${edit.planIndex}h${n}`);
        perOpHandovers.set(edit.planIndex, (perOpHandovers.get(edit.planIndex) ?? 0) + 1);
      }

      applied.forEach((a, i) => {
        if (a.op.op === 'add_filter') for (const id of a.changedWidgetIds) filterInjected.add(id);
        if (!isDeterministicOp(a.op)) return;
        // An op with handovers is not finished — it stays running until every
        // card it handed over has settled, so the tick means the whole thing.
        // Checked BEFORE the refusal, because an op can do both: a filter can
        // hand over its first twelve cards and refuse the rest, and settling
        // it as failed here would be overwritten by the handovers landing.
        if (perOpHandovers.get(i)) {
          sse.emit({ type: 'step', id: `s${i}`, status: 'running' });
          return;
        }
        if (a.refusal) {
          sse.emit({ type: 'step', id: `s${i}`, status: 'failed', note: a.refusal });
          return;
        }
        sse.emit({ type: 'step', id: `s${i}`, status: 'done' });
      });

      /** Settle a parent step once its last handover lands. */
      const handoverFailures = new Map<number, number>();
      const settleParent = (planIndex: number, ok: boolean) => {
        if (!ok) handoverFailures.set(planIndex, (handoverFailures.get(planIndex) ?? 0) + 1);
        const left = (perOpHandovers.get(planIndex) ?? 1) - 1;
        perOpHandovers.set(planIndex, left);
        if (left > 0) return;
        const failed = handoverFailures.get(planIndex) ?? 0;
        // An op that also refused (the cap) reports that as its note, so the
        // partial outcome is on the line the user is watching, not only in
        // the refusal list at the end.
        const ownRefusal = applied[planIndex]?.refusal;
        const note = failed
          ? `${failed} card(s) could not take it`
          : ownRefusal;
        sse.emit({
          type: 'step', id: `s${planIndex}`,
          status: failed || ownRefusal ? 'failed' : 'done',
          ...(note ? { note } : {}),
        });
      };

      const addOps = applied
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.op.op === 'add_widget');

      if (sqlEdits.length + addOps.length > 0) {
        // Announce the sub-steps before the calls start, so the checklist is
        // complete on screen while it fills in rather than growing under you.
        for (const edit of sqlEdits) {
          if (!edit.label) continue;
          sse.emit({
            type: 'step', id: stepIdFor.get(edit)!, parentId: `s${edit.planIndex}`,
            label: edit.label, status: 'pending',
          });
        }
        const n = sqlEdits.length + addOps.length;
        sse.emit({ type: 'phase', text: `Writing ${n === 1 ? 'the query' : `${n} queries`}…` });
      }

      await Promise.all([
        ...sqlEdits.map(async (edit) => {
          const stepId = stepIdFor.get(edit)!;
          const isSub = !!edit.label;
          const widget = spec.widgets.find((w) => w.id === edit.widgetId);
          if (!widget) {
            sse.emit({ type: 'step', id: stepId, status: 'failed', note: 'Could not find that card.' });
            if (isSub) settleParent(edit.planIndex, false);
            return;
          }
          sse.emit({ type: 'step', id: stepId, status: 'running' });
          try {
            const out = await editWidgetSql(edit.instruction, widget, semanticCtx.semanticContext, semanticCtx.relationshipContext);
            assertSafeReadQuery(out.sql);
            spec = {
              ...spec,
              widgets: spec.widgets.map((w) => w.id === edit.widgetId
                ? { ...w, sql: out.sql, ...(out.title ? { title: out.title } : {}) }
                : w),
            };
            filterInjected.delete(edit.widgetId); // the model now owns this SQL
            sse.emit({ type: 'step', id: stepId, status: 'done', note: out.note });
            if (out.note) notes.push(out.note);
            if (isSub) settleParent(edit.planIndex, true);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.warn({ widgetId: edit.widgetId, err: msg }, 'scoped widget edit failed — widget left unchanged');
            sse.emit({ type: 'step', id: stepId, status: 'failed', note: `Could not change "${widget.title}" — left it as it was.` });
            refusals.push(`Could not change "${widget.title}" — left it as it was.`);
            if (isSub) settleParent(edit.planIndex, false);
          }
        }),
        ...addOps.map(async ({ a, i }) => {
          const stepId = `s${i}`;
          const instruction = (a.op as Extract<DashboardEditOp, { op: 'add_widget' }>).instruction;
          sse.emit({ type: 'step', id: stepId, status: 'running' });
          try {
            const out = await generateSingleWidget(instruction, spec, semanticCtx.semanticContext, semanticCtx.relationshipContext);
            assertSafeReadQuery(out.widget.sql);
            const takenIds = new Set(spec.widgets.map((w) => w.id));
            const id = takenIds.has(out.widget.id) ? `${out.widget.id}_${Date.now().toString(36)}` : out.widget.id;
            const widget = { ...out.widget, id } as WidgetSpec;
            spec = { ...spec, widgets: [...spec.widgets, widget] };
            sse.emit({ type: 'step', id: stepId, status: 'done', note: out.note });
            if (out.note) notes.push(out.note);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.warn({ err: msg }, 'scoped widget add failed');
            sse.emit({ type: 'step', id: stepId, status: 'failed', note: 'Could not build that card.' });
            refusals.push(`Could not add "${instruction}".`);
          }
        }),
      ]);
      if (sse.closed) return;

      // ── CHECK: execute only what changed; repair scoped; never ship broken ─
      // "Changed" is measured, not tracked: a widget whose SQL is byte-equal
      // to the pre-edit spec (retitles, in-group type swaps) cannot fail in a
      // new way and is not re-executed.
      const beforeById = new Map(currentSpec.widgets.map((w) => [w.id, w]));
      const changedIds = spec.widgets
        .filter((w) => beforeById.get(w.id)?.sql !== w.sql)
        .map((w) => w.id);
      if (changedIds.length > 0) {
        sse.emit({ type: 'phase', text: `Checking ${changedIds.length === 1 ? 'the changed card' : `the ${changedIds.length} changed cards`} against your data…` });
        const idSet = new Set(changedIds);
        const results = await executeSpecForValidation(
          { ...spec, widgets: spec.widgets.filter((w) => idSet.has(w.id)) },
          connectionId, tenantId, effectiveLayer,
        );
        for (const r of results) {
          if (!r.error && r.rowCount > 0) {
            const issue = validateWidgetColumns(r.type, r.sampleRows);
            if (issue) r.contractIssue = issue;
          }
        }
        const failing = results.filter((r) => r.error || r.contractIssue);
        for (const fail of failing) {
          if (sse.closed) return;
          const original = currentSpec.widgets.find((w) => w.id === fail.id);
          const current = spec.widgets.find((w) => w.id === fail.id);
          if (!current) continue;
          const cause = filterInjected.has(fail.id) ? 'filter' : 'model';
          const problem = fail.error ?? fail.contractIssue ?? 'returned no usable data';
          try {
            // One scoped repair. For a broken filter injection the model gets
            // the ORIGINAL query and wires the filter in properly (usually an
            // added join); for its own edit it gets the error to fix.
            const filterList = spec.filters
              .map((f) => `"${f.label}" (id ${f.id}, ${f.type} on ${f.table}.${f.column})`).join('; ');
            const instruction = cause === 'filter' && original
              ? `Wire the dashboard filters into this query — the automatic version failed with: ${problem}. Filters: ${filterList}. Add whatever JOIN is needed; if a filter's column genuinely cannot apply to this data, leave that filter out.`
              : `The previous edit produced a query that failed with: ${problem}. Fix it.`;
            const base = cause === 'filter' && original ? { ...current, sql: original.sql } : current;
            const out = await editWidgetSql(instruction, base, semanticCtx.semanticContext, semanticCtx.relationshipContext);
            assertSafeReadQuery(out.sql);
            const recheck = await executeSpecForValidation(
              { ...spec, widgets: [{ ...current, sql: out.sql }] },
              connectionId, tenantId, effectiveLayer,
            );
            const ok = recheck[0] && !recheck[0].error &&
              !(recheck[0].rowCount > 0 && validateWidgetColumns(recheck[0].type, recheck[0].sampleRows));
            if (ok) {
              spec = { ...spec, widgets: spec.widgets.map((w) => w.id === fail.id ? { ...w, sql: out.sql } : w) };
              continue;
            }
            throw new Error('repair did not validate');
          } catch (repairErr) {
            log.warn(
              { widgetId: fail.id, err: repairErr instanceof Error ? repairErr.message : String(repairErr) },
              'scoped repair failed — reverting widget',
            );
            if (original) {
              // Revert to the last version that worked. An unfiltered-but-
              // correct card beats a broken one; say so instead of hiding it.
              spec = { ...spec, widgets: spec.widgets.map((w) => w.id === fail.id ? original : w) };
              refusals.push(`"${original.title}" could not take this change and was left as it was.`);
            } else {
              spec = { ...spec, widgets: spec.widgets.filter((w) => w.id !== fail.id) };
              refusals.push(`The new "${fail.title}" card did not work against your data and was not added.`);
            }
          }
        }
      }

      finish(spec, notes, refusals);
    } catch (err) {
      // The fast path failed somewhere unrecoverable. If the stream is still
      // open, fall back to the full-spec path once; if that also fails, say so.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'refine-spec-stream fast path failed');
      if (!sse.closed) {
        try {
          await escalate('fast path error: ' + msg);
        } catch (escErr) {
          sse.emit({ type: 'error', error: escErr instanceof Error ? escErr.message : 'Refinement failed' });
          sse.end();
        }
      }
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/fix-widget — render-time self-heal for ONE widget
//
// A saved dashboard can break long after generation (schema drift, renamed
// column, dropped rollup). Until now the user's only recourse was "regenerate
// the whole dashboard". This endpoint re-runs the execute → contract-check →
// AI-repair loop scoped to a single widget and returns the fixed widget so
// the client can patch it into the spec in place.
// ---------------------------------------------------------------------------

router.post('/fix-widget', requireAuth, validate(fixWidgetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, spec, widgetId, productIds, dataLayer } = req.body as {
      connectionId: number;
      spec: DashboardSpec;
      widgetId: string;
      productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    if (!spec || !Array.isArray(spec.widgets)) {
      res.status(400).json({ ok: false, error: 'spec is required' });
      return;
    }
    const widget = spec.widgets.find((w) => w.id === widgetId);
    if (!widget) {
      res.status(404).json({ ok: false, error: 'widget not found in spec' });
      return;
    }

    const productCtx = dataLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId, req.user!.tenantId);

    const repaired = await validateAndRepairSpec(
      spec, connectionId, req.user!.tenantId, dataLayer, semanticCtx, new Set([widgetId]),
    );
    const fixedWidget = repaired.widgets.find((w) => w.id === widgetId) ?? widget;
    const fixed = JSON.stringify(fixedWidget) !== JSON.stringify(widget);

    res.json({ ok: true, data: { widget: fixedWidget, fixed } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/execute
// ---------------------------------------------------------------------------

router.post('/execute', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, sql, filterValues = {}, dataLayer } = req.body as {
      connectionId: number;
      sql: string;
      filterValues: Record<string, string>;
      dataLayer?: 'product' | 'source';
    };

    // Security guard: validate the client-supplied template SQL as a safe
    // read-only query before substitution (see sqlGuard).
    if (!isSafeReadQuery(sql)) {
      res.status(400).json({ ok: false, error: 'This query was refused for safety.' });
      return;
    }

    // Substitute {{key}} placeholders with filter values
    let resolvedSql = sql;
    for (const [key, value] of Object.entries(filterValues)) {
      let resolved: string;
      if (!value) {
        if (key.endsWith('_from')) {
          resolved = '1900-01-01';
        } else if (key.endsWith('_to')) {
          resolved = '2099-12-31';
        } else {
          resolved = 'all';
        }
      } else {
        resolved = value;
      }
      // Escape single quotes so a value can't break out of its string literal.
      resolvedSql = resolvedSql.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), resolved.replace(/'/g, "''"));
    }

    // Also apply defaults for any remaining unsubstituted placeholders
    resolvedSql = resolvedSql
      .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
      .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
      .replace(/\{\{[^}]+\}\}/g, 'all');

    // Fix any PostgreSQL-only functions that slipped through AI generation
    resolvedSql = fixDuckDbDialect(resolvedSql);

    // Re-check the fully-substituted SQL: a value in numeric/identifier context
    // could smuggle external access past the template guard above (see sqlGuard).
    if (!isSafeReadQuery(resolvedSql)) {
      res.status(400).json({ ok: false, error: 'This query was refused for safety.' });
      return;
    }

    // Wrap all RLS-dependent queries in a single transaction to guarantee tenant context
    const tenantId = req.user!.tenantId;
    const useSource = dataLayer === 'source';
    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = productPath
      ? await createProductConnector(productPath, connection.id, tenantId)
      : await createConnector(connection);
    await connector.connect();

    try {
      const result = await connector.executeQuery(resolvedSql);
      res.json({ ok: true, data: { rows: result.rows } });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      log.warn({ raw }, '[dashboards/execute] Widget SQL error');
      const friendly = raw.includes('does not exist')
        ? 'This chart references data that is not yet available. Try regenerating the dashboard.'
        : raw.includes('Serialization')
          ? 'This chart encountered a data format issue. Try regenerating the dashboard.'
          : 'This chart could not load data. Try regenerating the dashboard.';
      res.json({ ok: false, error: friendly });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/batch-execute — run all widget SQLs in one request
// ---------------------------------------------------------------------------

router.post('/batch-execute', requireAuth, validate(batchExecuteSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, widgets, dataLayer, crossFilter } = req.body as {
      connectionId: number;
      widgets: Array<{ id: string; sql: string; filterValues: Record<string, string> }>;
      dataLayer?: 'product' | 'source';
      crossFilter?: { sourceWidgetId: string; dimension: string; value: string };
    };

    const tenantId = req.user!.tenantId;
    const useSource = dataLayer === 'source';
    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    // Latency instrumentation (free, log-only): separates the three places the
    // wall-clock goes — pool connect (cold extension load + view registration),
    // SQL exec over Parquet/blob (cache misses), and cache hits. Surfaces in
    // structured logs / App Insights so we optimise measured latency, not
    // assumed latency. See docs/DASHBOARD_PERF.md.
    const reqStart = Date.now();
    const connectStart = Date.now();
    const connector = productPath
      ? await createProductConnector(productPath, connection.id, tenantId)
      : await createConnector(connection);
    await connector.connect();
    const connectMs = Date.now() - connectStart;

    try {
      const results: Record<string, { rows?: Record<string, unknown>[]; error?: string }> = {};
      let cacheHits = 0;
      let cacheMisses = 0;
      let slowestWidgetMs = 0;

      await Promise.all(
        widgets.map(async ({ id, sql, filterValues }) => {
          // Security guard: widget SQL is client-supplied here. Validate the
          // TEMPLATE (before filter-value substitution, so legitimate data
          // values that look like URLs don't false-positive) as a safe
          // read-only query with no path/URI table functions. See sqlGuard.
          if (!isSafeReadQuery(sql)) {
            results[id] = { error: 'This chart could not load data. Try regenerating the dashboard.' };
            return;
          }
          // Apply declarative cross-filter (Phase 3) to non-source
          // widgets BEFORE filter-placeholder substitution. Source
          // widget keeps its SQL untouched so the user can keep
          // clicking to refilter.
          let withXf = sql;
          if (crossFilter && crossFilter.dimension && crossFilter.value !== undefined && id !== crossFilter.sourceWidgetId) {
            withXf = injectCrossFilter(sql, crossFilter.dimension, String(crossFilter.value));
          }
          let resolvedSql: string;
          try {
            resolvedSql = resolveWidgetFilters(withXf, filterValues ?? {});
          } catch {
            // resolveWidgetFilters throws if a substituted filter value smuggles
            // external access past the template guard — refuse this widget.
            results[id] = { error: 'This chart could not load data. Try regenerating the dashboard.' };
            return;
          }

          const cached = tenantId ? getWidgetCache(tenantId, resolvedSql) : null;
          if (cached) {
            cacheHits += 1;
            results[id] = { rows: cached };
            return;
          }

          cacheMisses += 1;
          const widgetStart = Date.now();
          try {
            const result = await connector.executeQuery(resolvedSql);
            const rows = result.rows as Record<string, unknown>[];
            if (tenantId) putWidgetCache(tenantId, resolvedSql, rows);
            results[id] = { rows };
          } catch (err: unknown) {
            const raw = err instanceof Error ? err.message : String(err);
            // Log raw error + SQL for diagnosis (truncated to avoid log flood)
            log.error(`[batch-execute] widget ${id} FAILED: ${raw.slice(0, 400)}`);
            log.error(`[batch-execute] widget ${id} SQL: ${resolvedSql.slice(0, 800)}`);
            const friendly = raw.includes('does not exist')
              ? 'This chart references data that is not yet available. Try regenerating the dashboard.'
              : raw.includes('Serialization')
                ? 'This chart encountered a data format issue. Try regenerating the dashboard.'
                : 'This chart could not load data. Try regenerating the dashboard.';
            results[id] = { error: friendly };
          } finally {
            slowestWidgetMs = Math.max(slowestWidgetMs, Date.now() - widgetStart);
          }
        }),
      );

      logger.info(
        {
          evt: 'dashboard.batch_execute',
          tenantId,
          connectionId,
          layer: useSource ? 'source' : 'product',
          widgets: widgets.length,
          cacheHits,
          cacheMisses,
          connectMs,
          slowestWidgetMs,
          totalMs: Date.now() - reqStart,
        },
        'batch-execute timing',
      );

      res.json({ ok: true, data: { results } });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/batch-execute-stream — SSE variant of /batch-execute
//
// Emits one `widget` event per widget as its SQL resolves, so the frontend
// can render each widget independently and a slow widget no longer holds
// back fast ones. End-to-end shape is identical to /batch-execute; just
// streamed instead of batched.
//
// Events:
//   data: {"type":"widget","id":"w1","rows":[…]}       — success
//   data: {"type":"widget","id":"w2","error":"…"}      — per-widget failure
//   data: {"type":"done"}                              — all widgets resolved
//
// Cache behaviour: cache lookup happens BEFORE the connector is opened,
// so a fully-cached dashboard emits every event without touching DuckDB.
// ---------------------------------------------------------------------------

router.post('/batch-execute-stream', requireAuth, validate(batchExecuteSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, widgets, dataLayer, crossFilter } = req.body as {
      connectionId: number;
      widgets: Array<{ id: string; sql: string; filterValues: Record<string, string> }>;
      dataLayer?: 'product' | 'source';
      /** Declarative cross-filter — Phase 3. Server-side AND injection
       *  into every non-source widget's SQL. Replaces the fragile
       *  AI-embedded `{{xf_<key>}}` placeholder pattern. The legacy
       *  placeholder substitution still runs (via resolveWidgetFilters)
       *  so saved dashboards keep working. */
      crossFilter?: { sourceWidgetId: string; dimension: string; value: string };
    };

    const tenantId = req.user!.tenantId;
    const useSource = dataLayer === 'source';

    // Resolve connection + warehouse path under a tenant-scoped trx (same
    // pattern as /batch-execute) BEFORE we start streaming, so a 404 on
    // the connection is still a normal JSON error not a partial SSE.
    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    // Start SSE. From here on every error path emits a `done` event
    // instead of throwing JSON.
    const sse = startSSE(res, { headers: { 'Cache-Control': 'no-cache, no-transform' } });

    const emit = (event: Record<string, unknown>) => sse.emit(event);

    // Resolve each widget's SQL: programmatic cross-filter injection
    // (Phase 3) → filter placeholder substitution (legacy) → cache
    // lookup. The injection is skipped for the SOURCE widget (the one
    // the user clicked) so its chart keeps showing all bars and they
    // can pick another or click again to clear.
    const resolved = widgets.map(({ id, sql, filterValues }) => {
      // Security guard on the client-supplied template (see sqlGuard).
      if (!isSafeReadQuery(sql)) {
        return { id, resolvedSql: null as string | null, unsafe: true };
      }
      let sqlWithCrossFilter = sql;
      if (crossFilter && crossFilter.dimension && crossFilter.value !== undefined && id !== crossFilter.sourceWidgetId) {
        sqlWithCrossFilter = injectCrossFilter(sql, crossFilter.dimension, String(crossFilter.value));
      }
      try {
        return {
          id,
          resolvedSql: resolveWidgetFilters(sqlWithCrossFilter, filterValues ?? {}) as string | null,
          unsafe: false,
        };
      } catch {
        // Substituted filter value smuggled external access past the template
        // guard — mark the widget unsafe so it's skipped with a clean error.
        return { id, resolvedSql: null as string | null, unsafe: true };
      }
    });

    // Emit any cache hits IMMEDIATELY. Drop them from the to-fetch list.
    const remaining: Array<{ id: string; resolvedSql: string }> = [];
    for (const w of resolved) {
      if (w.unsafe || w.resolvedSql === null) {
        emit({ type: 'widget', id: w.id, error: 'This chart could not load data. Try regenerating the dashboard.' });
        continue;
      }
      const cached = tenantId ? getWidgetCache(tenantId, w.resolvedSql) : null;
      if (cached) {
        emit({ type: 'widget', id: w.id, rows: cached, cached: true });
      } else {
        remaining.push({ id: w.id, resolvedSql: w.resolvedSql });
      }
    }

    if (remaining.length === 0) {
      emit({ type: 'done' });
      sse.end();
      return;
    }

    const connector = productPath
      ? await createProductConnector(productPath, connection.id, tenantId)
      : await createConnector(connection);
    await connector.connect();

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      // Fire all queries in parallel; emit each result as it resolves.
      // Promise.all wouldn't give us per-resolution timing — but firing
      // promises and emitting on .then() does.
      await Promise.all(
        remaining.map(async ({ id, resolvedSql }) => {
          try {
            const result = await connector.executeQuery(resolvedSql);
            if (aborted) return;
            const rows = result.rows as Record<string, unknown>[];
            if (tenantId) putWidgetCache(tenantId, resolvedSql, rows);
            emit({ type: 'widget', id, rows });
          } catch (err: unknown) {
            if (aborted) return;
            const raw = err instanceof Error ? err.message : String(err);
            log.error(`[batch-execute-stream] widget ${id} FAILED: ${raw.slice(0, 400)}`);
            log.error(`[batch-execute-stream] widget ${id} SQL: ${resolvedSql.slice(0, 800)}`);
            const friendly = raw.includes('does not exist')
              ? 'This chart references data that is not yet available. Try regenerating the dashboard.'
              : raw.includes('Serialization')
                ? 'This chart encountered a data format issue. Try regenerating the dashboard.'
                : 'This chart could not load data. Try regenerating the dashboard.';
            emit({ type: 'widget', id, error: friendly });
          }
        }),
      );
      if (!aborted) emit({ type: 'done' });
    } finally {
      connector.disconnect();
      sse.end();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/drill-rows  —  "show source rows" right-click action
//
// Given a widget's SQL + the clicked dimension column + clicked value +
// any active dashboard filters, return the underlying raw rows that
// aggregated to the clicked value. The Power-BI-style "see records"
// action.
//
// Approach: take the widget's SQL, keep its FROM/JOIN/WHERE clauses
// intact (preserves any active filter substitutions), strip the
// aggregation (SELECT becomes `*`, GROUP BY/HAVING/ORDER BY/LIMIT are
// removed), then add an extra WHERE clause for the clicked dimension =
// clicked value. Returns up to MAX_DRILL_ROWS rows.
//
// Body: { connectionId, widgetSql, crossFilterKey, value, filterValues,
//         dataLayer? }
//
// Failure cases (returns 400 with `unsupported` flag so the frontend
// can fall back to the explicit drillDownSql if the widget has one):
//   - widget SQL has CTEs / nested subqueries we can't safely strip
//   - we can't isolate a FROM clause
// ---------------------------------------------------------------------------

const MAX_DRILL_ROWS = 1000;

/**
 * Inject an `AND <dimension> = '<value>'` clause into a widget's SQL so
 * that aggregations are filtered by the clicked dimension value WITHOUT
 * relying on AI-prompted placeholders. The widget's SELECT and GROUP BY
 * stay intact — only the WHERE clause is modified.
 *
 * This is the Phase 3 "declarative cross-filter" plumbing. Previously
 * the AI prompt had to remember to embed `{{xf_<key>}}` placeholders in
 * each widget's WHERE — fragile because a forgotten placeholder meant
 * that widget silently ignored cross-filters. Now we inject the clause
 * deterministically server-side.
 *
 * Failure modes — returns the original SQL unchanged when:
 *   - The widget's SQL starts with WITH (CTEs) and we can't safely
 *     locate the top-level FROM.
 *   - We can't find a FROM clause.
 *   - The dimension name fails sanitisation.
 *
 * When the injected column doesn't exist in the widget's FROM chain the
 * SQL itself will fail at execution; the caller's per-widget error
 * handler renders a friendly message instead of crashing the dashboard.
 */
export function injectCrossFilter(
  widgetSql: string,
  dimension: string,
  value: string,
): string {
  if (!widgetSql || !dimension) return widgetSql;
  if (/^\s*WITH\s+/i.test(widgetSql)) return widgetSql;

  const fromMatch = widgetSql.match(/\bFROM\b/i);
  if (!fromMatch || fromMatch.index == null) return widgetSql;

  const safeKey = dimension.replace(/[^a-zA-Z0-9_."`\[\]]/g, '');
  if (!safeKey) return widgetSql;
  const escapedValue = String(value).replace(/'/g, "''");
  const filterClause = `${safeKey} = '${escapedValue}'`;

  // The boundary regex marks where the WHERE clause must end and any
  // post-aggregation clauses begin. Anything before the boundary is in
  // the FROM/WHERE region we want to augment.
  const boundaryRe = /\s+(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT)\b/i;
  const whereRe = /\bWHERE\b/i;

  const tail = widgetSql.slice(fromMatch.index);
  const whereInTail = tail.match(whereRe);

  if (whereInTail && whereInTail.index != null) {
    // WHERE exists. Insert ` AND <clause>` just before the post-aggregation
    // boundary (so the AND doesn't accidentally land inside an ORDER BY).
    const boundaryInTail = tail.match(boundaryRe);
    if (boundaryInTail && boundaryInTail.index != null) {
      const splitPoint = fromMatch.index + boundaryInTail.index;
      return widgetSql.slice(0, splitPoint) + ` AND ${filterClause}` + widgetSql.slice(splitPoint);
    }
    return widgetSql.trimEnd() + ` AND ${filterClause}`;
  }

  // No WHERE clause — add one. Same boundary logic so the WHERE is
  // inserted between FROM-chain and any GROUP BY.
  const boundaryInTail = tail.match(boundaryRe);
  if (boundaryInTail && boundaryInTail.index != null) {
    const splitPoint = fromMatch.index + boundaryInTail.index;
    return widgetSql.slice(0, splitPoint) + ` WHERE ${filterClause}` + widgetSql.slice(splitPoint);
  }
  return widgetSql.trimEnd() + ` WHERE ${filterClause}`;
}

/**
 * Transform a widget's aggregating SQL into a "show all source rows
 * matching the clicked dimension value" SQL. Returns null if we can't
 * confidently rewrite the SQL — caller should fall back to an explicit
 * drillDownSql or surface a friendly error.
 */
export function buildDrillSql(
  widgetSql: string,
  crossFilterKey: string,
  value: string,
): string | null {
  if (!widgetSql || !crossFilterKey) return null;

  // Refuse SQL with leading CTEs (WITH ...) — the regex below would
  // accidentally drill into the CTE's source table, which gives wrong
  // rows. The caller falls back to drillDownSql for these widgets.
  if (/^\s*WITH\s+/i.test(widgetSql)) return null;

  // Find the FIRST `FROM` at top level. We assume top-level — a
  // SELECT-from-subquery widget would also fall into the unsupported
  // path. Common AI-generated widgets are flat.
  const fromMatch = widgetSql.match(/\bFROM\b/i);
  if (!fromMatch || fromMatch.index == null) return null;

  // Tail = everything from FROM onwards. Strip the post-aggregation
  // bits one at a time (case-insensitive, dot-matches-newline).
  let tail = widgetSql.slice(fromMatch.index);

  // Strip ORDER BY clause (must come before GROUP BY removal because
  // ORDER BY can reference aliases like "value DESC" that GROUP BY
  // doesn't).
  tail = tail.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, '');

  // Strip LIMIT / OFFSET (defensive — usually after ORDER BY).
  tail = tail.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '');

  // Strip GROUP BY (and HAVING if present after it).
  tail = tail.replace(/\s+GROUP\s+BY\s+[\s\S]*?(?=\s+(HAVING|ORDER|LIMIT)|$)/i, '');

  // Strip HAVING if it survived (was attached to ORDER BY which we
  // already removed).
  tail = tail.replace(/\s+HAVING\s+[\s\S]*$/i, '');

  // Escape the value — single quotes doubled per SQL convention.
  const escapedValue = String(value).replace(/'/g, "''");

  // The clicked column might be qualified ("p.category") or bare
  // ("category"). We pass it through verbatim — both are valid in SQL.
  // Caller already validated crossFilterKey is a SQL-safe identifier-ish.
  const safeKey = crossFilterKey.replace(/[^a-zA-Z0-9_."`\[\]]/g, '');
  if (!safeKey) return null;

  const extraWhere = `${safeKey} = '${escapedValue}'`;
  if (/\bWHERE\b/i.test(tail)) {
    tail = tail + ` AND ${extraWhere}`;
  } else {
    tail = tail + ` WHERE ${extraWhere}`;
  }

  return `SELECT * ${tail} LIMIT ${MAX_DRILL_ROWS}`;
}

router.post('/drill-rows', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, widgetSql, crossFilterKey, value, filterValues, dataLayer } = req.body as {
      connectionId: number;
      widgetSql: string;
      crossFilterKey: string;
      value: string;
      filterValues?: Record<string, string>;
      dataLayer?: 'product' | 'source';
    };

    if (!connectionId || !widgetSql || !crossFilterKey || value === undefined || value === null) {
      res.status(400).json({ ok: false, error: 'connectionId, widgetSql, crossFilterKey, and value are required' });
      return;
    }

    // Security guard on the client-supplied widget SQL (see sqlGuard).
    if (!isSafeReadQuery(widgetSql)) {
      res.status(400).json({ ok: false, error: 'This query was refused for safety.' });
      return;
    }

    const drillSqlTemplate = buildDrillSql(widgetSql, crossFilterKey, value);
    if (!drillSqlTemplate) {
      res.status(400).json({
        ok: false,
        error: 'This widget\'s SQL is too complex for automatic drill-through. Use the chart\'s built-in drill if available.',
        unsupported: true,
      });
      return;
    }

    // Resolve any active dashboard filter placeholders the same way
    // the widget SQL would have been resolved when the widget ran.
    const resolvedSql = resolveWidgetFilters(drillSqlTemplate, filterValues ?? {});

    const tenantId = req.user!.tenantId;
    const useSource = dataLayer === 'source';
    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = productPath
      ? await createProductConnector(productPath, connection.id, tenantId)
      : await createConnector(connection);
    await connector.connect();

    try {
      const result = await connector.executeQuery(resolvedSql);
      const rows = result.rows as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      res.json({
        ok: true,
        data: {
          rows,
          columns,
          rowCount: rows.length,
          truncated: rows.length >= MAX_DRILL_ROWS,
        },
      });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      log.error(`[drill-rows] FAILED: ${raw.slice(0, 400)}`);
      log.error(`[drill-rows] SQL: ${resolvedSql.slice(0, 800)}`);
      const friendly = raw.includes('does not exist')
        ? 'The underlying table is not available right now.'
        : 'Could not load source rows for this value.';
      res.status(500).json({ ok: false, error: friendly }); // deliberate-500: user-friendly mapped message, not an error leak
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/cube — Phase 5a, DuckDB-WASM proof-of-concept.
//
// Builds a "cube" of the parquet bytes for every table referenced by
// the dashboard's widget SQLs, so the frontend can load them into an
// in-browser DuckDB-WASM instance and run all subsequent queries
// locally without server round-trips.
//
// Body: { connectionId, widgetSqls: string[], dataLayer? }
// Response: { ok, data: { tables: [{ tableName, parquetBase64, rowCount, sizeBytes }], totalBytes } }
//
// Approach: extract all table names referenced by the widget SQLs
// (regex on FROM/JOIN), resolve each via the existing connector by
// COPYing to a temp parquet, and stream the bytes back as base64 in
// JSON. Base64 has 33% overhead vs binary multipart but keeps the
// PoC dead-simple; we'll move to a proper binary format if the
// approach proves out.
//
// Failure modes (all surface as 400/500 with friendly errors so the
// frontend can fall back to the server path):
//   - any one table fails → entire request fails (atomic loading)
//   - missing connector / dataLayer mismatch → 404
//   - parquet file missing / corrupt → 500 with the underlying error
//
// Caching: NONE for now. Each cube request fetches fresh bytes from
// the warehouse. Phase 5b should add an ETag based on each table's
// last_run_at so the browser can cache the cube + revalidate cheaply.
// ---------------------------------------------------------------------------

/**
 * Extract all table names referenced by a widget's SQL. Looks for
 * `FROM <name>` and `JOIN <name>` patterns. Returns a deduplicated set
 * of bare identifiers — qualified names like `schema.table` get
 * normalised to just the table portion (which is what DuckDB-WASM
 * will register under).
 */
function extractTableNames(sql: string): string[] {
  if (!sql) return [];
  const out = new Set<string>();
  const re = /\b(?:FROM|JOIN)\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?(?:\s|,|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    // Skip subquery aliases and obvious non-table keywords. DuckDB
    // reserves a handful of words after FROM (VALUES, UNNEST, etc.);
    // those won't be valid table names in any user's warehouse, so
    // the regex's `[a-zA-Z_]…` filter handles them implicitly.
    if (m[1]) out.add(m[1]);
  }
  return Array.from(out);
}

router.post('/cube', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, widgetSqls, dataLayer } = req.body as {
      connectionId: number;
      widgetSqls: string[];
      dataLayer?: 'product' | 'source';
    };

    if (!connectionId || !Array.isArray(widgetSqls) || widgetSqls.length === 0) {
      res.status(400).json({ ok: false, error: 'connectionId and widgetSqls[] are required' });
      return;
    }

    // Collect unique table names referenced anywhere in the dashboard.
    const tableSet = new Set<string>();
    for (const sql of widgetSqls) for (const t of extractTableNames(sql)) tableSet.add(t);
    const tableNames = Array.from(tableSet);

    if (tableNames.length === 0) {
      res.status(400).json({ ok: false, error: 'No tables found in widget SQLs' });
      return;
    }

    const tenantId = req.user!.tenantId;
    const useSource = dataLayer === 'source';
    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = productPath
      ? await createProductConnector(productPath, connection.id, tenantId)
      : await createConnector(connection);
    await connector.connect();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-cube-'));

    type CubeTable = { tableName: string; parquetBase64: string; rowCount: number; sizeBytes: number };
    const results: CubeTable[] = [];
    let totalBytes = 0;

    try {
      // Sequential COPY → read → encode loop. We don't parallelise
      // because DuckDB instances are single-connection per connector
      // and COPY TO contends with itself. For PoC scale (a handful of
      // tables per dashboard) this is fine; if cube size scales up
      // we'd want a separate connector per table.
      for (const tableName of tableNames) {
        const tmpPath = path.join(tmpDir, `${tableName.replace(/[^a-zA-Z0-9_]/g, '_')}.parquet`).replace(/\\/g, '/');
        // Quote the table identifier to avoid keyword collisions.
        const safeTable = `"${tableName.replace(/"/g, '""')}"`;
        try {
          await connector.executeQuery(`COPY (SELECT * FROM ${safeTable}) TO '${tmpPath.replace(/'/g, "''")}' (FORMAT PARQUET)`);
        } catch (err) {
          // If the table doesn't exist in the warehouse, skip it
          // gracefully — the widget's SQL will fail in WASM and the
          // frontend will fall back to the server for that widget.
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[cube] failed to materialise '${tableName}': ${msg.slice(0, 200)}`);
          continue;
        }

        const bytes = fs.readFileSync(tmpPath);
        // Use row_count from the catalog if we have it; otherwise 0.
        // Frontend uses rowCount + sizeBytes for the memory budget check;
        // sizeBytes (the parquet on disk) is the authoritative figure.
        results.push({
          tableName,
          parquetBase64: bytes.toString('base64'),
          rowCount: 0,
          sizeBytes: bytes.byteLength,
        });
        totalBytes += bytes.byteLength;
      }

      res.json({
        ok: true,
        data: {
          tables: results,
          totalBytes,
        },
      });
    } finally {
      connector.disconnect();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/filter-options
// ---------------------------------------------------------------------------

router.post('/filter-options', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, table, column, dataLayer } = req.body as {
      connectionId: number;
      table: string;
      column: string;
      dataLayer?: 'product' | 'source';
    };

    if (!table || !column) {
      res.status(400).json({ ok: false, error: 'table and column are required' });
      return;
    }

    const filterTenantId = req.user!.tenantId;

    // Cache check — distinct values change only on refresh, so cached
    // dropdowns are correct between refreshes. Invalidated from the
    // transformation runner on success.
    const cached = getFilterOptionsCache(filterTenantId, connectionId, table, column);
    if (cached) {
      res.json({ ok: true, data: { options: cached, cached: true } });
      return;
    }

    // Wrap all RLS-dependent queries in a single transaction
    const useSource = dataLayer === 'source';
    const { connection: filterConn, productPath: filterProductPath } = await semanticDb.transaction(async (trx) => {
      if (filterTenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(filterTenantId)}'`);
      const conn = await trx('connections').where({ id: connectionId }).first();
      const pp = useSource ? null : await getProductWarehousePath(connectionId, trx);
      return { connection: conn, productPath: pp };
    });

    if (!filterConn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = filterProductPath
      ? await createProductConnector(filterProductPath, filterConn.id, filterTenantId)
      : await createConnector(filterConn);
    await connector.connect();

    try {
      const result = await connector.executeQuery(
        `SELECT DISTINCT "${column}" FROM "${table}" WHERE "${column}" IS NOT NULL ORDER BY "${column}" LIMIT 100`,
      );
      const options = result.rows.map((r) => String((r as Record<string, unknown>)[column]));
      putFilterOptionsCache(filterTenantId, connectionId, table, column, options);
      res.json({ ok: true, data: { options } });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards — list own + shared dashboards in the same tenant
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const folder = req.query.folder as string | undefined;
    const { page, limit, offset } = parsePagination(req.query, { limit: 50 });

    log.info(`GET / userId=${userId} tenantId=${tenantId} folder=${folder ?? 'none'} NEW_CODE_V2`);

    // Wrap in a transaction with SET LOCAL tenant so RLS consistently applies
    // (session-level SET from auth middleware can be lost across pool connections).
    const { total, rows } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);

      let baseQuery = trx('dashboards')
        .where(function () {
          this.where({ user_id: userId }).orWhere({ is_shared: true });
        });

      if (folder) {
        baseQuery = baseQuery.where({ folder });
      }

      const [{ count }] = await baseQuery.clone().count('* as count');

      const selected = await baseQuery
        .select(
          'id', 'title', 'description', 'is_favorite', 'is_shared',
          'shared_permission', 'folder', 'auto_refresh_seconds',
          'user_id', 'created_at', 'updated_at',
        )
        .orderBy('is_favorite', 'desc')
        .orderBy('updated_at', 'desc')
        .limit(limit)
        .offset(offset);

      return { total: count, rows: selected };
    });

    log.info(`GET / returned ${rows.length} rows (total=${total}) for userId=${userId} tenantId=${tenantId}`);

    const tagged = rows.map((r: Record<string, unknown>) => {
      const isOwner = Number(r.user_id) === Number(userId);
      return {
        ...r,
        is_owner: isOwner,
        permission: isOwner ? 'owner' : (r.shared_permission ?? 'viewer'),
      };
    });

    res.json(paginatedResponse(tagged, Number(total), page, limit));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/folders — list distinct folders
// ---------------------------------------------------------------------------

router.get('/folders', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const rows = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      return trx('dashboards')
        .whereNotNull('folder')
        .distinct('folder')
        .orderBy('folder');
    });

    res.json({ ok: true, data: rows.map((r: { folder: string }) => r.folder) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards
// ---------------------------------------------------------------------------

router.post('/', requireAuth, validate(createDashboardSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, title, description, spec, folder } = req.body as {
      connectionId: number;
      title: string;
      description: string;
      spec: DashboardSpec;
      folder?: string;
    };

    const [row] = await db('dashboards')
      .insert({
        user_id:       req.user!.sub,
        connection_id: connectionId,
        title,
        description,
        spec:          JSON.stringify(spec),
        folder:        folder || null,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/pin-widget — pin a chat answer as a dashboard widget
//
// Ask AI Release 3: answers are destinations, not dead ends (the ThoughtSpot
// Spotter "Pin" pattern). The widget's SQL is derived client-side from the
// answer's SQL + visualization hint (column aliases wrapped to the widget
// contract); here it is guarded (assertSafeReadQuery) and appended to an
// OWNED dashboard's spec — or a new dashboard is started from it when no
// dashboardId is given. Zero AI calls.
// ---------------------------------------------------------------------------

router.post('/pin-widget', requireAuth, validate(pinWidgetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { dashboardId, connectionId, title, widget } = req.body as {
      dashboardId?: number;
      connectionId: number;
      title?: string;
      widget: { type: WidgetSpec['type']; title: string; sql: string };
    };

    try {
      assertSafeReadQuery(widget.sql);
    } catch {
      res.status(400).json({ ok: false, error: 'Only read-only queries can be pinned.' });
      return;
    }

    const newWidget: WidgetSpec = {
      id: `pin_${Date.now()}`,
      type: widget.type,
      title: widget.title.slice(0, 120),
      sql: widget.sql,
      colSpan: widget.type === 'kpi_card' ? 1 : widget.type === 'data_table' ? 4 : 2,
    };

    if (dashboardId) {
      // Append to an OWNED dashboard (same ownership rule as PATCH /:id).
      const row = await db('dashboards')
        .where({ id: dashboardId, user_id: req.user!.sub })
        .first();
      if (!row) {
        res.status(404).json({ ok: false, error: 'Dashboard not found or not owned by you' });
        return;
      }
      const spec = (typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec) as DashboardSpec;
      spec.widgets = [...(spec.widgets ?? []), newWidget];
      await db('dashboards').where({ id: row.id }).update({
        spec: JSON.stringify(spec),
        updated_at: new Date().toISOString(),
      });
      res.json({ ok: true, data: { id: row.id, widgetId: newWidget.id } });
      return;
    }

    // No target — start a new dashboard from this one answer.
    const spec: DashboardSpec = {
      title: (title ?? widget.title).slice(0, 120),
      description: 'Pinned from Ask AI',
      filters: [],
      widgets: [newWidget],
      dataLayer: 'product',
    };
    const [row] = await db('dashboards')
      .insert({
        user_id: req.user!.sub,
        connection_id: connectionId,
        title: spec.title,
        description: spec.description,
        spec: JSON.stringify(spec),
      })
      .returning('id');
    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id, widgetId: newWidget.id, created: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/templates/list — list available templates
// ---------------------------------------------------------------------------

router.get('/templates/list', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const rows = await db('dashboard_templates')
      .select('id', 'name', 'description', 'category', 'created_at')
      .orderBy('category')
      .orderBy('name');

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/templates/:id — get a template spec
// ---------------------------------------------------------------------------

router.get('/templates/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const row = await db('dashboard_templates')
      .where({ id: req.params.id })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Template not found' });
      return;
    }

    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/templates — create a template (admin only)
// ---------------------------------------------------------------------------

router.post('/templates', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.user!.role !== 'admin') {
      res.status(403).json({ ok: false, error: 'Admin only' });
      return;
    }

    const db = reqDb(req);
    const { name, description, category, spec } = req.body as {
      name: string;
      description?: string;
      category?: string;
      spec: DashboardSpec;
    };

    const [row] = await db('dashboard_templates')
      .insert({
        name,
        description: description || null,
        category: category || 'General',
        spec: JSON.stringify(spec),
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/from-template — create dashboard from a template
// ---------------------------------------------------------------------------

router.post('/from-template', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { templateId, connectionId, folder } = req.body as {
      templateId: number;
      connectionId: number;
      folder?: string;
    };

    const template = await db('dashboard_templates')
      .where({ id: templateId })
      .first();

    if (!template) {
      res.status(404).json({ ok: false, error: 'Template not found' });
      return;
    }

    const spec = typeof template.spec === 'string' ? JSON.parse(template.spec) : template.spec;

    const [row] = await db('dashboards')
      .insert({
        user_id: req.user!.sub,
        connection_id: connectionId,
        title: template.name,
        description: template.description,
        spec: JSON.stringify(spec),
        folder: folder || null,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/:id — accessible if owned or shared within tenant
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = req.user!.sub;
    // RLS ensures tenant isolation; allow access if owned or shared
    const row = await db('dashboards')
      .where({ id: req.params.id })
      .where(function () {
        this.where({ user_id: userId }).orWhere({ is_shared: true });
      })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const isOwner = row.user_id === userId;
    res.json({
      ok: true,
      data: {
        ...row,
        is_owner: isOwner,
        permission: isOwner ? 'owner' : (row.shared_permission ?? 'viewer'),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/dashboards/:id
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const deleted = await db('dashboards')
      .where({ id: req.params.id, user_id: req.user!.sub })
      .delete();

    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/dashboards/:id/favorite
// ---------------------------------------------------------------------------

router.patch('/:id/favorite', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const row = await db('dashboards')
      .where({ id: req.params.id, user_id: req.user!.sub })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const newValue = !row.is_favorite;
    // Defense-in-depth: the SELECT above already filtered by user_id
    // (returns 404 if not the owner), but we keep the user_id filter
    // on the UPDATE too so the intent is explicit and a future code
    // change can't accidentally widen the scope.
    await db('dashboards')
      .where({ id: req.params.id, user_id: req.user!.sub })
      .update({ is_favorite: newValue });

    res.json({ ok: true, data: { is_favorite: newValue } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/dashboards/:id — update dashboard properties (title, folder, sharing, auto-refresh)
// ---------------------------------------------------------------------------

// ─── Per-person saved view ────────────────────────────────────────────────
//
// The filters YOU left this dashboard on. Private by construction: every query
// filters by BOTH the dashboard and the calling user, so one person's lens is
// invisible to everyone else looking at the same dashboard.
//
// Readable by anyone who can open the dashboard — including a viewer on a
// shared one. Saving a private filter selection is not an edit to the
// artefact, so it needs no ownership of it.

/**
 * The dashboards this caller may open at all: their own, plus shared ones.
 *
 * `tenant_id` is filtered EXPLICITLY rather than left to RLS. The house rule
 * (see CLAUDE.md) is that an authorization decision must not depend on the
 * session variable: `reqDb` can fall back to a pooled connection whose
 * `app.current_tenant` is not the caller's, and a superuser connection
 * bypasses row-level security altogether. Written the other way, a request
 * from another tenant reads a SHARED dashboard here — which is exactly what
 * the isolation test caught before this filter existed.
 */
async function findVisibleDashboard(db: Knex, id: number, userId: number, tenantId: number) {
  return db('dashboards')
    .where({ id, tenant_id: tenantId })
    .where(function () {
      this.where({ user_id: userId }).orWhere({ is_shared: true });
    })
    .first();
}

// GET /api/dashboards/:id/my-view — the caller's saved filters, or null.
router.get('/:id/my-view', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = req.user!.sub;
    const dashboardId = Number(req.params.id);
    if (!Number.isFinite(dashboardId)) { res.status(400).json({ ok: false, error: 'Invalid dashboard id' }); return; }

    const dash = await findVisibleDashboard(db, dashboardId, userId, req.user!.tenantId);
    if (!dash) { res.status(404).json({ ok: false, error: 'Dashboard not found' }); return; }

    const row = await db('dashboard_user_views')
      .where({ dashboard_id: dashboardId, user_id: userId, tenant_id: req.user!.tenantId })
      .first() as { filter_values: Record<string, string>; updated_at: string } | undefined;

    res.json({ ok: true, data: row
      ? { filterValues: row.filter_values ?? {}, savedAt: row.updated_at }
      : null });
  } catch (err) { next(err); }
});

// PUT /api/dashboards/:id/my-view — save (or replace) the caller's filters.
router.put('/:id/my-view', requireAuth, validate(saveMyViewSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = req.user!.sub;
    const tenantId = req.user!.tenantId;
    const dashboardId = Number(req.params.id);
    if (!Number.isFinite(dashboardId)) { res.status(400).json({ ok: false, error: 'Invalid dashboard id' }); return; }

    const dash = await findVisibleDashboard(db, dashboardId, userId, tenantId);
    if (!dash) { res.status(404).json({ ok: false, error: 'Dashboard not found' }); return; }

    const { filterValues } = req.body as { filterValues: Record<string, string> };

    // One row per person per dashboard — saving replaces, never accumulates.
    await db('dashboard_user_views')
      .insert({
        tenant_id: tenantId,
        dashboard_id: dashboardId,
        user_id: userId,
        filter_values: JSON.stringify(filterValues),
        updated_at: db.fn.now(),
      })
      .onConflict(['dashboard_id', 'user_id'])
      .merge(['filter_values', 'updated_at']);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/dashboards/:id/my-view — back to the dashboard's own defaults.
router.delete('/:id/my-view', requireAuth, validate(clearMyViewSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = req.user!.sub;
    const dashboardId = Number(req.params.id);
    if (!Number.isFinite(dashboardId)) { res.status(400).json({ ok: false, error: 'Invalid dashboard id' }); return; }

    // No visibility check on the way out: removing your own row can only ever
    // affect you, and refusing it on a dashboard that was un-shared underneath
    // you would strand the row with no way to clear it.
    await db('dashboard_user_views')
      .where({ dashboard_id: dashboardId, user_id: userId, tenant_id: req.user!.tenantId })
      .delete();

    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/:id', requireAuth, validate(updateDashboardSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = req.user!.sub;
    const row = await db('dashboards')
      .where({ id: req.params.id, user_id: userId })
      .first();

    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found or not owned by you' });
      return;
    }

    const { title, description, folder, is_shared, shared_permission, auto_refresh_seconds, spec } = req.body as {
      title?: string;
      description?: string;
      folder?: string | null;
      is_shared?: boolean;
      shared_permission?: string;
      auto_refresh_seconds?: number | null;
      spec?: DashboardSpec;
    };

    const updates: Record<string, unknown> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (folder !== undefined) updates.folder = folder || null;
    if (is_shared !== undefined) updates.is_shared = is_shared;
    if (shared_permission !== undefined) updates.shared_permission = shared_permission;
    if (auto_refresh_seconds !== undefined) updates.auto_refresh_seconds = auto_refresh_seconds;
    if (spec !== undefined) updates.spec = JSON.stringify(spec);

    if (Object.keys(updates).length === 0) {
      res.json({ ok: true, data: row });
      return;
    }

    updates.updated_at = new Date().toISOString();
    await db('dashboards').where({ id: req.params.id }).update(updates);
    const updated = await db('dashboards').where({ id: req.params.id }).first();
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/:id/duplicate — clone a dashboard
// ---------------------------------------------------------------------------

router.post('/:id/duplicate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = req.user!.sub;
    // Allow duplicating owned or shared dashboards
    const source = await db('dashboards')
      .where({ id: req.params.id })
      .where(function () {
        this.where({ user_id: userId }).orWhere({ is_shared: true });
      })
      .first();

    if (!source) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const [row] = await db('dashboards')
      .insert({
        user_id: userId,
        connection_id: source.connection_id,
        title: `${source.title} (copy)`,
        description: source.description,
        spec: typeof source.spec === 'string' ? source.spec : JSON.stringify(source.spec),
        folder: source.folder,
        is_shared: false,
        is_favorite: false,
      })
      .returning('id');

    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.json({ ok: true, data: { id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Helper — resolve filter placeholders in SQL using query params
// ---------------------------------------------------------------------------

function resolveFiltersFromQuery(sql: string, query: Record<string, unknown>): string {
  let resolved = sql;
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('filter_') && typeof value === 'string') {
      const filterId = key.slice(7); // strip 'filter_'
      const safe = value.replace(/'/g, "''");
      resolved = resolved.replace(new RegExp(`\\{\\{${filterId}\\}\\}`, 'g'), safe);
      resolved = resolved.replace(new RegExp(`\\{\\{${filterId}_from\\}\\}`, 'g'), safe);
      resolved = resolved.replace(new RegExp(`\\{\\{${filterId}_to\\}\\}`, 'g'), safe);
    }
  }
  // Apply defaults for any remaining unsubstituted placeholders
  resolved = applyDefaultFilters(resolved);
  // Re-check the fully-substituted SQL for external access (see sqlGuard).
  assertNoExternalAccess(resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Helper — execute a single widget and return rows
// ---------------------------------------------------------------------------

async function executeWidgetSql(
  db: import('knex').Knex | import('knex').Knex.Transaction,
  dashboardId: number,
  widgetIndex: number,
  query: Record<string, unknown>,
  tenantId?: number,
): Promise<{ rows: Record<string, unknown>[]; widget: { title: string; id: string }; connectionId: number }> {
  const row = await db('dashboards').where({ id: dashboardId }).first();
  if (!row) throw Object.assign(new Error('Dashboard not found'), { status: 404 });

  const spec: DashboardSpec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
  if (widgetIndex < 0 || widgetIndex >= spec.widgets.length) {
    throw Object.assign(new Error('Widget index out of range'), { status: 400 });
  }

  const widget = spec.widgets[widgetIndex];
  // Security guard on the stored template SQL (see sqlGuard).
  assertSafeReadQuery(widget.sql);
  const resolvedSql = resolveFiltersFromQuery(widget.sql, query);

  const { connection, productPath } = await semanticDb.transaction(async (trx) => {
    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
    const conn = await trx('connections').where({ id: row.connection_id }).first();
    const pp = await getProductWarehousePath(row.connection_id, trx);
    return { connection: conn, productPath: pp };
  });

  if (!connection) throw Object.assign(new Error('Connection not found'), { status: 404 });

  const connector = productPath
    ? await createProductConnector(productPath, connection.id, tenantId)
    : await createConnector(connection);
  await connector.connect();

  try {
    const result = await connector.executeQuery(resolvedSql);
    return { rows: result.rows as Record<string, unknown>[], widget, connectionId: row.connection_id };
  } finally {
    connector.disconnect();
  }
}

// ---------------------------------------------------------------------------
// GET /api/dashboards/:id/widget/:widgetIndex/export/csv
// ---------------------------------------------------------------------------

router.get('/:id/widget/:widgetIndex/export/csv', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows, widget } = await executeWidgetSql(
      reqDb(req),
      Number(req.params.id),
      Number(req.params.widgetIndex),
      req.query as Record<string, unknown>,
      req.user!.tenantId,
    );

    if (!rows.length) {
      res.status(404).json({ ok: false, error: 'No data to export' });
      return;
    }

    const columns = Object.keys(rows[0]);
    const csv = buildCsvFromRows(columns, rows);
    const filename = `${widget.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compat
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
      res.status((err as { status: number }).status).json({ ok: false, error: (err as { status: number; message: string }).message });
    } else {
      next(err);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/:id/widget/:widgetIndex/export/xlsx
// ---------------------------------------------------------------------------

router.get('/:id/widget/:widgetIndex/export/xlsx', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows, widget } = await executeWidgetSql(
      reqDb(req),
      Number(req.params.id),
      Number(req.params.widgetIndex),
      req.query as Record<string, unknown>,
      req.user!.tenantId,
    );

    if (!rows.length) {
      res.status(404).json({ ok: false, error: 'No data to export' });
      return;
    }

    const columns = Object.keys(rows[0]);
    const xlsx = buildXlsxFromRows(columns, rows);
    const filename = `${widget.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsx);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err) {
      res.status((err as { status: number }).status).json({ ok: false, error: (err as { status: number; message: string }).message });
    } else {
      next(err);
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboards/:id/export/xlsx — all widgets as multi-sheet XLSX
// ---------------------------------------------------------------------------

router.get('/:id/export/xlsx', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const dashboardId = Number(req.params.id);
    const row = await db('dashboards').where({ id: dashboardId }).first();
    if (!row) {
      res.status(404).json({ ok: false, error: 'Dashboard not found' });
      return;
    }

    const spec: DashboardSpec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
    const tenantId = req.user!.tenantId;

    const { connection, productPath } = await semanticDb.transaction(async (trx) => {
      if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const conn = await trx('connections').where({ id: row.connection_id }).first();
      const pp = await getProductWarehousePath(row.connection_id, trx);
      return { connection: conn, productPath: pp };
    });

    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = productPath
      ? await createProductConnector(productPath, connection.id, tenantId)
      : await createConnector(connection);
    await connector.connect();

    const sheets: Array<{ name: string; headers: string[]; rows: unknown[][] }> = [];

    try {
      for (let i = 0; i < spec.widgets.length; i++) {
        const widget = spec.widgets[i];
        const resolvedSql = resolveFiltersFromQuery(widget.sql, req.query as Record<string, unknown>);
        try {
          const result = await connector.executeQuery(resolvedSql);
          const rows = result.rows as Record<string, unknown>[];
          if (rows.length > 0) {
            const columns = Object.keys(rows[0]);
            // Sheet name must be <= 31 chars and unique
            const sheetName = widget.title.replace(/[^\w\s-]/g, '').substring(0, 28) || `Widget ${i + 1}`;
            sheets.push({
              name: sheetName,
              headers: columns,
              rows: rows.map((r) => columns.map((c) => r[c])),
            });
          }
        } catch {
          // Skip widgets that fail to execute
        }
      }
    } finally {
      connector.disconnect();
    }

    if (sheets.length === 0) {
      res.status(404).json({ ok: false, error: 'No widget data to export' });
      return;
    }

    const xlsx = buildXlsx(sheets);
    const filename = `${(spec.title || 'dashboard').replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsx);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /investigate  — SSE: plan + execute + synthesize causal investigation
// ---------------------------------------------------------------------------

router.post('/investigate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, widgetTitle, widgetSql, widgetRows, question, filterValues } = req.body as {
      connectionId: number;
      widgetTitle: string;
      widgetSql: string;
      widgetRows: Record<string, unknown>[];
      question: string;
      filterValues?: Record<string, string>;
    };

    if (!widgetTitle || !widgetSql || !question) {
      res.status(400).json({ ok: false, error: 'widgetTitle, widgetSql, and question are required' });
      return;
    }

    // Set up SSE
    const sse = startSSE(res);

    function emit(obj: Record<string, unknown>) {
      sse.emit(obj);
    }

    try {
      // Step 1 — Plan
      emit({ type: 'status', text: 'Planning investigation…' });
      const plan = await planInvestigation(widgetTitle, widgetSql, widgetRows ?? [], question);
      emit({ type: 'hypothesis', text: plan.hypothesis });

      if (!plan.queries.length) {
        emit({ type: 'conclusion', text: 'Not enough context to run diagnostic queries.' });
        emit({ type: 'done' });
        sse.end();
        return;
      }

      // Step 2 — Connect to data source
      const tenantId = req.user!.tenantId;
      const { connection, productPath } = await semanticDb.transaction(async (trx) => {
        if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
        const conn = await trx('connections').where({ id: connectionId }).first();
        const pp = await getProductWarehousePath(connectionId, trx);
        return { connection: conn, productPath: pp };
      });

      if (!connection) {
        emit({ type: 'error', text: 'Connection not found.' });
        emit({ type: 'done' });
        sse.end();
        return;
      }

      const connector = productPath
        ? await createProductConnector(productPath, connection.id, tenantId)
        : await createConnector(connection);
      await connector.connect();

      // Step 3 — Execute diagnostic queries
      const diagnosticResults: { label: string; rows: Record<string, unknown>[]; error?: string }[] = [];

      try {
        await Promise.all(
          plan.queries.map(async ({ label, sql }) => {
            emit({ type: 'querying', label });
            try {
              // Security guard on the AI-planned diagnostic SQL (see sqlGuard).
              assertSafeReadQuery(sql);
              const resolved = resolveWidgetFilters(sql, filterValues ?? {});
              const result = await connector.executeQuery(resolved);
              const rows = (result.rows as Record<string, unknown>[]).slice(0, 20);
              diagnosticResults.push({ label, rows });
              emit({ type: 'result', label, rows });
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              diagnosticResults.push({ label, rows: [], error: msg });
              emit({ type: 'result', label, rows: [], error: msg });
            }
          }),
        );
      } finally {
        connector.disconnect();
      }

      // Step 4 — Synthesize
      emit({ type: 'status', text: 'Synthesizing findings…' });
      const conclusion = await synthesizeInvestigation(question, plan.hypothesis, diagnosticResults);
      emit({ type: 'conclusion', text: conclusion });
      emit({ type: 'done' });
      sse.end();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Investigation failed.';
      emit({ type: 'error', text: msg });
      emit({ type: 'done' });
      sse.end();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /narrate  — AI-written executive narrative for the full dashboard
// ---------------------------------------------------------------------------

router.post('/narrate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dashboardTitle, widgets } = req.body as {
      dashboardTitle: string;
      widgets: { title: string; type: string; rows: Record<string, unknown>[] }[];
    };
    if (!dashboardTitle || !Array.isArray(widgets) || widgets.length === 0) {
      res.status(400).json({ ok: false, error: 'dashboardTitle and widgets are required' });
      return;
    }
    const narrative = await narrateDashboard(dashboardTitle, widgets);
    res.json({ ok: true, data: { narrative } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /widget-context — provenance for a single widget. Answers
// "where does this number come from?" so users can audit before trusting.
//
// Returns:
//   • plainEnglish — AI-rendered description of the SQL in business terms
//   • tablesUsed   — every source / product table the SQL touches, with
//                    last_refreshed_at + description so users can see
//                    whether the underlying data is fresh
//   • columnsUsed  — first ~20 source columns referenced, with
//                    descriptions if available (drives "I don't recognise
//                    this column" → click to read the definition)
//   • sql          — echoed back so the modal can show it (admins / analysts)
//
// No caching server-side — Haiku call is ~$0.0001, frontend opens this
// only on user click.
// ---------------------------------------------------------------------------
router.post('/widget-context', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { title, sql, dataLayer } = req.body as {
      title: string;
      sql: string;
      dataLayer?: 'product' | 'source';
    };
    if (!title || !sql) {
      res.status(400).json({ ok: false, error: 'title and sql required' });
      return;
    }

    // Crude SQL parser — pulls every identifier following FROM / JOIN.
    // Good enough: our generated SQL is single-line CTE-free joins; we'll
    // upgrade to a real parser if anyone writes hand-crafted SQL on top.
    const tableNamesRaw = new Set<string>();
    const tablePattern = /\b(?:FROM|JOIN)\s+["`]?([a-zA-Z_][a-zA-Z0-9_.]*)["`]?/gi;
    let m: RegExpExecArray | null;
    while ((m = tablePattern.exec(sql)) !== null) {
      // Trim "schema.table" → "table"
      const last = m[1].split('.').pop();
      if (last) tableNamesRaw.add(last);
    }
    // Drop obvious DuckDB / SQL builtins
    const SKIP = new Set(['unnest', 'generate_series', 'range', 'values']);
    const tableNames = Array.from(tableNamesRaw).filter((n) => !SKIP.has(n.toLowerCase()));

    type TableMeta = {
      name: string;
      kind: 'product' | 'source' | 'unknown';
      description: string | null;
      lastRefreshedAt: string | null;
      productName?: string | null;
      sourceName?: string | null;
    };
    const tablesUsed: TableMeta[] = [];

    if (tableNames.length > 0) {
      // Look up product tables (transformation_status='success' implies parquet exists)
      const ptRows = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .join('data_products as dp', 'ss.data_product_id', 'dp.id')
        .whereIn('pt.table_name', tableNames)
        .select(
          'pt.table_name', 'pt.description', 'pt.last_run_at',
          'dp.name as product_name',
        );
      const ptByName = new Map<string, { description: string | null; last_run_at: Date | string | null; product_name: string | null }>();
      for (const r of ptRows as Array<{ table_name: string; description: string | null; last_run_at: Date | string | null; product_name: string | null }>) {
        ptByName.set(r.table_name, r);
      }

      // Source tables — last_synced_at lives on the connection, not the table.
      const stRows = await db('source_tables as st')
        .join('connections as c', 'st.connection_id', 'c.id')
        .whereIn('st.table_name', tableNames)
        .where({ 'st.is_active': true })
        .select(
          'st.table_name', 'st.description',
          'c.last_synced_at', 'c.name as connection_name',
        );
      const stByName = new Map<string, { description: string | null; last_synced_at: Date | string | null; connection_name: string }>();
      for (const r of stRows as Array<{ table_name: string; description: string | null; last_synced_at: Date | string | null; connection_name: string }>) {
        stByName.set(r.table_name, r);
      }

      for (const name of tableNames) {
        const pt = ptByName.get(name);
        if (pt) {
          tablesUsed.push({
            name, kind: 'product',
            description: pt.description,
            lastRefreshedAt: pt.last_run_at ? String(pt.last_run_at) : null,
            productName: pt.product_name,
          });
          continue;
        }
        const st = stByName.get(name);
        if (st) {
          tablesUsed.push({
            name, kind: 'source',
            description: st.description,
            lastRefreshedAt: st.last_synced_at ? String(st.last_synced_at) : null,
            sourceName: st.connection_name,
          });
          continue;
        }
        // Could be a CTE / temp / transformation rollup — surface as unknown.
        tablesUsed.push({ name, kind: 'unknown', description: null, lastRefreshedAt: null });
      }
    }

    // Build a small context string for the AI so it doesn't hallucinate
    // column meanings — pass the table descriptions we just looked up.
    const tableContext = tablesUsed
      .filter((t) => t.description)
      .map((t) => `${t.name}: ${t.description}`)
      .join('\n');

    let plainEnglish: string | null = null;
    try {
      const { explainSqlInPlainEnglish } = await import('../ai/AIService');
      plainEnglish = await explainSqlInPlainEnglish(title, sql, tableContext || undefined);
    } catch (err) {
      log.warn({ err }, '[widget-context] explainSqlInPlainEnglish failed');
    }

    res.json({
      ok: true,
      data: {
        plainEnglish,
        tablesUsed,
        sql,
        dataLayer: dataLayer ?? 'product',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /explain-widget  — 2-sentence plain-language explanation for a widget
// ---------------------------------------------------------------------------

router.post('/explain-widget', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, type, rows } = req.body as {
      title: string;
      type: string;
      rows: Record<string, unknown>[];
    };
    if (!title || !type || !Array.isArray(rows)) {
      res.status(400).json({ ok: false, error: 'title, type, and rows are required' });
      return;
    }
    const explanation = await explainWidget(title, type, rows);
    res.json({ ok: true, data: { explanation } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /insights  — 3 automated observations across all widgets in a dashboard
// ---------------------------------------------------------------------------

router.post('/insights', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dashboardTitle, widgets } = req.body as {
      dashboardTitle: string;
      widgets: { title: string; type: string; rows: Record<string, unknown>[] }[];
    };
    if (!dashboardTitle || !Array.isArray(widgets) || widgets.length === 0) {
      res.status(400).json({ ok: false, error: 'dashboardTitle and widgets are required' });
      return;
    }
    const insights = await generateDashboardInsights(dashboardTitle, widgets);
    res.json({ ok: true, data: { insights } });
  } catch (err) {
    next(err);
  }
});

export default router;
