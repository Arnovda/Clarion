import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { createConnector, createProductConnector } from '../connectors/ConnectorFactory';
import { generateDashboardSpec, generateDashboardRefinement, refineDashboardSpec, validateAndFixDashboardSpec, checkWidgetSemantics, SqlDialect, explainWidget, generateDashboardInsights, planInvestigation, synthesizeInvestigation, narrateDashboard } from '../ai/AIService';
import { DashboardSpec, RefinementOutput, WidgetExecutionResult } from '../ai/prompts/dashboardPrompt';
import { buildSemanticContextForQuery } from '../db/semanticGraph';
import { buildProductSemanticContext, getProductWarehousePath } from '../services/productContext';
import { parsePagination, paginatedResponse } from '../utils/paginate';
import { buildXlsxFromRows, buildCsvFromRows, buildXlsx } from '../utils/xlsxBuilder';
import { getWidgetCache, putWidgetCache } from '../services/widgetCache';
import { getFilterOptionsCache, putFilterOptionsCache } from '../services/filterOptionsCache';
import { reqDb } from '../db/reqDb';

const router = Router();

// ---------------------------------------------------------------------------
// Helper — build semantic + relationship context strings for a connection
// ---------------------------------------------------------------------------

async function buildSemanticContext(
  connectionId: number,
): Promise<{ semanticContext: string; relationshipContext: string }> {
  const { tables, columns, relationships } = await buildSemanticContextForQuery(connectionId);

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
    const replacement = value || (key.endsWith('_from') ? '1900-01-01' : key.endsWith('_to') ? '2099-12-31' : 'all');
    resolved = resolved.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), replacement);
  }
  return fixDuckDbDialect(
    resolved
      .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
      .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
      .replace(/\{\{[^}]+\}\}/g, 'all'),
  );
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
// POST /api/dashboards/generate
// ---------------------------------------------------------------------------

router.post('/generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, request, answers, productIds, dataLayer } = req.body as {
      connectionId: number;
      request: string;
      answers?: string[];
      productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    if (!request?.trim()) {
      res.status(400).json({ ok: false, error: 'request is required' });
      return;
    }

    // Append any refinement answers to the request so the AI uses them
    const nonEmptyAnswers = (answers ?? []).filter((a) => a?.trim());
    const fullRequest = nonEmptyAnswers.length
      ? `${request}\n\nAdditional requirements from the user:\n${nonEmptyAnswers.map((a) => `- ${a}`).join('\n')}`
      : request;

    // Default = product layer (cleaner Kimball star schema). Honour explicit
    // 'source' opt-in for users who want raw source-layer dashboards.
    const productCtx = dataLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId);

    // Determine SQL dialect from the connection's query engine
    const connection = await db('connections').where({ id: connectionId }).first();
    const dialect: SqlDialect = productCtx ? 'duckdb' : (connection?.query_engine === 'duckdb' ? 'duckdb' : 'sqlite');

    let spec = await generateDashboardSpec(fullRequest, semanticCtx.semanticContext, semanticCtx.relationshipContext, dialect);

    // Validation pass — execute all widget SQLs with default filters and fix any broken/empty widgets.
    // Also runs a cheap Haiku-based semantic check: does each widget's data match its title?
    try {
      const executionResults = await executeSpecForValidation(spec, connectionId, req.user!.tenantId, dataLayer);

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
        (r) => r.error || r.rowCount === 0 || r.semanticIssue || (r.type === 'pie_chart' && r.rowCount > 3),
      );
      if (hasIssues) {
        spec = await validateAndFixDashboardSpec(spec, executionResults, semanticCtx.semanticContext, semanticCtx.relationshipContext);
      }
    } catch {
      // Validation is best-effort — never block the response if it fails
    }

    res.json({ ok: true, data: { spec } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine — get clarifying questions before generation
// ---------------------------------------------------------------------------

router.post('/refine', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, request, productIds, dataLayer } = req.body as {
      connectionId: number; request: string; productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    if (!request?.trim()) {
      res.status(400).json({ ok: false, error: 'request is required' });
      return;
    }

    const productCtx = dataLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId);
    const result: RefinementOutput = await generateDashboardRefinement(request, semanticCtx.semanticContext, semanticCtx.relationshipContext);

    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboards/refine-spec — update an existing spec based on user feedback
// ---------------------------------------------------------------------------

router.post('/refine-spec', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, refinement, currentSpec, productIds, dataLayer } = req.body as {
      connectionId: number;
      refinement: string;
      currentSpec: DashboardSpec;
      productIds?: number[];
      dataLayer?: 'product' | 'source';
    };

    if (!refinement?.trim()) {
      res.status(400).json({ ok: false, error: 'refinement is required' });
      return;
    }
    if (!currentSpec) {
      res.status(400).json({ ok: false, error: 'currentSpec is required' });
      return;
    }

    const productCtx = dataLayer === 'source'
      ? null
      : await buildProductSemanticContext(connectionId, productIds, db);
    const semanticCtx = productCtx
      ? { semanticContext: productCtx.semanticContext, relationshipContext: productCtx.relationshipContext }
      : await buildSemanticContext(connectionId);
    const spec = await refineDashboardSpec(refinement, currentSpec, semanticCtx.semanticContext, semanticCtx.relationshipContext);

    res.json({ ok: true, data: { spec } });
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
      resolvedSql = resolvedSql.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), resolved);
    }

    // Also apply defaults for any remaining unsubstituted placeholders
    resolvedSql = resolvedSql
      .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
      .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
      .replace(/\{\{[^}]+\}\}/g, 'all');

    // Fix any PostgreSQL-only functions that slipped through AI generation
    resolvedSql = fixDuckDbDialect(resolvedSql);

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
      console.warn('[dashboards/execute] Widget SQL error:', raw);
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

router.post('/batch-execute', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, widgets, dataLayer, crossFilter } = req.body as {
      connectionId: number;
      widgets: Array<{ id: string; sql: string; filterValues: Record<string, string> }>;
      dataLayer?: 'product' | 'source';
      crossFilter?: { sourceWidgetId: string; dimension: string; value: string };
    };

    if (!Array.isArray(widgets) || widgets.length === 0) {
      res.status(400).json({ ok: false, error: 'widgets array required' });
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

    try {
      const results: Record<string, { rows?: Record<string, unknown>[]; error?: string }> = {};

      await Promise.all(
        widgets.map(async ({ id, sql, filterValues }) => {
          // Apply declarative cross-filter (Phase 3) to non-source
          // widgets BEFORE filter-placeholder substitution. Source
          // widget keeps its SQL untouched so the user can keep
          // clicking to refilter.
          let withXf = sql;
          if (crossFilter && crossFilter.dimension && crossFilter.value !== undefined && id !== crossFilter.sourceWidgetId) {
            withXf = injectCrossFilter(sql, crossFilter.dimension, String(crossFilter.value));
          }
          const resolvedSql = resolveWidgetFilters(withXf, filterValues ?? {});

          const cached = tenantId ? getWidgetCache(tenantId, resolvedSql) : null;
          if (cached) {
            results[id] = { rows: cached };
            return;
          }

          try {
            const result = await connector.executeQuery(resolvedSql);
            const rows = result.rows as Record<string, unknown>[];
            if (tenantId) putWidgetCache(tenantId, resolvedSql, rows);
            results[id] = { rows };
          } catch (err: unknown) {
            const raw = err instanceof Error ? err.message : String(err);
            // Log raw error + SQL for diagnosis (truncated to avoid log flood)
            console.error(`[batch-execute] widget ${id} FAILED: ${raw.slice(0, 400)}`);
            console.error(`[batch-execute] widget ${id} SQL: ${resolvedSql.slice(0, 800)}`);
            const friendly = raw.includes('does not exist')
              ? 'This chart references data that is not yet available. Try regenerating the dashboard.'
              : raw.includes('Serialization')
                ? 'This chart encountered a data format issue. Try regenerating the dashboard.'
                : 'This chart could not load data. Try regenerating the dashboard.';
            results[id] = { error: friendly };
          }
        }),
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

router.post('/batch-execute-stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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

    if (!Array.isArray(widgets) || widgets.length === 0) {
      res.status(400).json({ ok: false, error: 'widgets array required' });
      return;
    }

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
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const emit = (event: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client disconnected */ }
    };

    // Resolve each widget's SQL: programmatic cross-filter injection
    // (Phase 3) → filter placeholder substitution (legacy) → cache
    // lookup. The injection is skipped for the SOURCE widget (the one
    // the user clicked) so its chart keeps showing all bars and they
    // can pick another or click again to clear.
    const resolved = widgets.map(({ id, sql, filterValues }) => {
      let sqlWithCrossFilter = sql;
      if (crossFilter && crossFilter.dimension && crossFilter.value !== undefined && id !== crossFilter.sourceWidgetId) {
        sqlWithCrossFilter = injectCrossFilter(sql, crossFilter.dimension, String(crossFilter.value));
      }
      return {
        id,
        resolvedSql: resolveWidgetFilters(sqlWithCrossFilter, filterValues ?? {}),
      };
    });

    // Emit any cache hits IMMEDIATELY. Drop them from the to-fetch list.
    const remaining: Array<{ id: string; resolvedSql: string }> = [];
    for (const w of resolved) {
      const cached = tenantId ? getWidgetCache(tenantId, w.resolvedSql) : null;
      if (cached) {
        emit({ type: 'widget', id: w.id, rows: cached, cached: true });
      } else {
        remaining.push(w);
      }
    }

    if (remaining.length === 0) {
      emit({ type: 'done' });
      res.end();
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
            console.error(`[batch-execute-stream] widget ${id} FAILED: ${raw.slice(0, 400)}`);
            console.error(`[batch-execute-stream] widget ${id} SQL: ${resolvedSql.slice(0, 800)}`);
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
      try { res.end(); } catch { /* ignore */ }
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
      console.error(`[drill-rows] FAILED: ${raw.slice(0, 400)}`);
      console.error(`[drill-rows] SQL: ${resolvedSql.slice(0, 800)}`);
      const friendly = raw.includes('does not exist')
        ? 'The underlying table is not available right now.'
        : 'Could not load source rows for this value.';
      res.status(500).json({ ok: false, error: friendly });
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
          console.warn(`[cube] failed to materialise '${tableName}': ${msg.slice(0, 200)}`);
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

    console.log(`[dashboards GET /] userId=${userId} tenantId=${tenantId} folder=${folder ?? 'none'} NEW_CODE_V2`);

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

    console.log(`[dashboards GET /] returned ${rows.length} rows (total=${total}) for userId=${userId} tenantId=${tenantId}`);

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

router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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

router.patch('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
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
      resolved = resolved.replace(new RegExp(`\\{\\{${filterId}\\}\\}`, 'g'), value);
      resolved = resolved.replace(new RegExp(`\\{\\{${filterId}_from\\}\\}`, 'g'), value);
      resolved = resolved.replace(new RegExp(`\\{\\{${filterId}_to\\}\\}`, 'g'), value);
    }
  }
  // Apply defaults for any remaining unsubstituted placeholders
  resolved = applyDefaultFilters(resolved);
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
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    function emit(obj: Record<string, unknown>) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }

    try {
      // Step 1 — Plan
      emit({ type: 'status', text: 'Planning investigation…' });
      const plan = await planInvestigation(widgetTitle, widgetSql, widgetRows ?? [], question);
      emit({ type: 'hypothesis', text: plan.hypothesis });

      if (!plan.queries.length) {
        emit({ type: 'conclusion', text: 'Not enough context to run diagnostic queries.' });
        emit({ type: 'done' });
        res.end();
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
        res.end();
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
      res.end();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Investigation failed.';
      emit({ type: 'error', text: msg });
      emit({ type: 'done' });
      res.end();
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
      // eslint-disable-next-line no-console
      console.warn('[widget-context] explainSqlInPlainEnglish failed:', err);
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
