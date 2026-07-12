/**
 * Products router (7/9): the AI build/propose flows — bus-matrix job flow
 * (refresh-start, start/active/cancel/stream), bus-matrix-stream,
 * build-bus-matrix, propose-single, propose-stream, propose, build-proposed.
 * Also holds PATCH /tables/:tableId/load-mode and POST /:id/run-full, which
 * thematically belong to tables.ts / design.ts but are kept here to preserve
 * the original registration order exactly.
 * Split verbatim from routes/products.ts — see ./index.ts for the
 * order-is-load-bearing mounting contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { productRefreshStartSchema } from '../../middleware/schemas';
import { reqDb } from '../../db/reqDb';
import { startSSE } from '../../services/sse';
import { log } from './shared';

const router = Router();

// ---------------------------------------------------------------------------
// PATCH /api/products/tables/:tableId/load-mode — Toggle incremental vs full
// Body: { load_mode: 'full' | 'incremental' }
// ---------------------------------------------------------------------------
router.patch('/tables/:tableId/load-mode', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { load_mode } = req.body as { load_mode: 'full' | 'incremental' };
    if (!['full', 'incremental'].includes(load_mode)) {
      res.status(400).json({ ok: false, error: 'load_mode must be "full" or "incremental"' });
      return;
    }
    await db('product_tables')
      .where({ id: req.params.tableId })
      .update({ load_mode });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/:id/run-full — Force a full refresh (ignores load_mode)
// Query: ?include=upstream  also rebuilds upstream dependency products in
// topological order, so shared dims are fresh before consumer facts run.
// ---------------------------------------------------------------------------
router.post('/:id/run-full', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const includeUpstream = String(req.query.include ?? '').toLowerCase() === 'upstream';

    const product = await db('data_products').where({ id: req.params.id }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const { runProductTransformation } = await import('../../services/transformationRunner');
    const { resolveUpstreamProductsTopo } = await import('../../services/productOwnership');

    // Build the run order: upstream-first if requested, then current product.
    const upstreamIds = includeUpstream
      ? await resolveUpstreamProductsTopo(Number(product.id), tenantId)
      : [];
    const runOrder = [...upstreamIds, Number(product.id)];

    const allResults: Array<{
      product_id: number;
      product_name: string;
      table_name: string;
      status: 'success' | 'error';
      row_count?: number;
      error?: string;
    }> = [];

    for (const pid of runOrder) {
      const p = await db('data_products').where({ id: pid }).first();
      if (!p) continue;

      const schemas = await db('star_schemas').where({ data_product_id: pid });
      const schemaIds = schemas.map((s: { id: number }) => s.id);
      const tables = schemaIds.length
        ? await db('product_tables')
            .whereIn('star_schema_id', schemaIds)
            .whereNotNull('transformation_sql')
            .orderBy('dag_order', 'asc')
        : [];

      // Override load_mode to 'full' for this run only
      const fullTables = tables.map((t: Record<string, unknown>) => ({ ...t, load_mode: 'full' }));

      const results = await runProductTransformation(p, fullTables as any, tenantId);
      for (const r of results) {
        allResults.push({
          product_id: pid,
          product_name: p.name as string,
          ...r,
        });
      }
    }

    res.json({
      ok: true,
      data: allResults,
      meta: {
        run_order: runOrder,
        included_upstream: includeUpstream && upstreamIds.length > 0,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-single — propose exactly one data product
// from a free-text user description. No streaming — returns JSON directly.
// ---------------------------------------------------------------------------

router.post('/propose-single', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const { connectionId, description } = req.body as { connectionId: number; description: string };
    if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await db('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure');
      const fkRels = await db('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');
      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));
      const bkCol = t.business_key_column as string | null;
      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: c.column_name === 'id' || c.column_name === bkCol,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    const existingProducts = await db('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateStarSchemaDesign } = await import('../../ai/AIService');

    const sourceTablesContext = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const desc = description.trim().slice(0, 500);
    const proposal = await generateStarSchemaDesign(
      desc || connection.name as string,
      desc,
      sourceTablesContext,
    );

    return res.json({ ok: true, data: proposal });
  } catch (err: unknown) {
    // Route to the central errorHandler (admins see the real message,
    // others get a generic one) instead of echoing raw errors inline.
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Bus Matrix — job-based flow (survives browser close, supports cancel)
//
// Endpoints:
//   POST /api/products/bus-matrix/start       → enqueue job, return { jobId }
//   GET  /api/products/bus-matrix/active      → currently running/queued job for tenant
//   GET  /api/products/bus-matrix/:jobId/stream → SSE: tail job logs + progress
//   POST /api/products/bus-matrix/:jobId/cancel → cancel a running job
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/products/:id/refresh-start — enqueue a refresh job for one product
//
// Body: { syncSource?: boolean }
//   - false (default) → just re-runs this product's transformations
//   - true            → triggers source connection sync first, waits for it
//                       to complete, THEN runs transformations. Single click
//                       for the upstream → downstream pipeline.
//
// Returns { jobId } — frontend then attaches via /bus-matrix/:jobId/stream
// (the SSE / cancel / active-job endpoints are mode-agnostic).
// ---------------------------------------------------------------------------
router.post('/:id/refresh-start', requireAuth, requireRole('admin'), validate(productRefreshStartSchema), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) {
      res.status(400).json({ ok: false, error: 'Invalid product id' });
      return;
    }
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Data product not found' });
      return;
    }

    const syncSource = !!(req.body as { syncSource?: boolean })?.syncSource;

    const { getBusMatrixQueue } = await import('../../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({
        ok: false,
        error: 'Job queue not available — Redis is not configured. Refresh requires Redis to survive browser close.',
      });
      return;
    }

    // Refuse to enqueue a second active refresh for the same product.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find(
      (j) => j.data.tenantId === tenantId && j.data.mode === 'refresh' && j.data.productId === productId,
    );
    if (existing) {
      res.status(409).json({
        ok: false,
        error: 'A refresh is already running for this product.',
        jobId: existing.id,
      });
      return;
    }

    const job = await queue.add('product-refresh', {
      // connectionId is also required by the JobData type; carry it for tenant
      // filtering on the active-jobs endpoint.
      connectionId: Number(product.connection_id ?? 0),
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
      mode: 'refresh' as const,
      productId,
      syncSource,
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix', mode: 'refresh', syncSource } });
  } catch (err) {
    throw err; // central errorHandler — no inline raw-error echo
  }
});

router.post('/bus-matrix/start', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      res.status(403).json({ ok: false, error: 'Tenant context required' });
      return;
    }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const { getBusMatrixQueue } = await import('../../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({
        ok: false,
        error: 'Job queue not available — Redis is not configured. Bus matrix builds require Redis to survive browser close.',
      });
      return;
    }

    // Refuse to enqueue a second active job for the same connection.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find((j) => j.data.connectionId === connectionId && j.data.tenantId === tenantId);
    if (existing) {
      res.status(409).json({
        ok: false,
        error: 'A bus matrix build is already running for this connection.',
        jobId: existing.id,
      });
      return;
    }

    const job = await queue.add('bus-matrix', {
      connectionId,
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix' } });
  } catch (err) {
    throw err; // central errorHandler — no inline raw-error echo
  }
});

router.get('/bus-matrix/active', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;

    const { getBusMatrixQueue } = await import('../../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.json({ ok: true, data: null });
      return;
    }

    const jobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const match = jobs.find((j) =>
      j.data.tenantId === tenantId &&
      (connectionId === undefined || j.data.connectionId === connectionId),
    );

    if (!match) { res.json({ ok: true, data: null }); return; }

    const state = await match.getState();
    res.json({
      ok: true,
      data: {
        jobId: match.id,
        state,
        connectionId: match.data.connectionId,
        progress: match.progress,
        createdAt: match.timestamp,
      },
    });
  } catch (err) {
    throw err; // central errorHandler — no inline raw-error echo
  }
});

router.post('/bus-matrix/:jobId/cancel', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    const { jobId } = req.params;

    const { getBusMatrixQueue } = await import('../../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({ ok: false, error: 'Job queue not available' });
      return;
    }

    const job = await queue.getJob(jobId);
    if (!job) { res.status(404).json({ ok: false, error: 'Job not found' }); return; }
    if (job.data.tenantId !== tenantId) { res.status(403).json({ ok: false, error: 'Forbidden' }); return; }

    const state = await job.getState();
    const { cancelJob } = await import('../../jobs/cancellation');
    const aborted = cancelJob(jobId);

    // If still waiting in the queue, remove it directly.
    if (state === 'waiting' || state === 'delayed') {
      try { await job.remove(); } catch { /* ignore */ }
    }

    res.json({
      ok: true,
      data: {
        jobId,
        priorState: state,
        aborted,
        message: aborted
          ? 'Cancellation signal sent — the worker will stop at the next safe checkpoint.'
          : (state === 'waiting' || state === 'delayed')
            ? 'Job removed from the queue before it started.'
            : 'Cancellation flag set; worker is not currently active in this process.',
      },
    });
  } catch (err) {
    throw err; // central errorHandler — no inline raw-error echo
  }
});

router.get('/bus-matrix/:jobId/stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const sse = startSSE(res);

  const tenantId = req.user?.tenantId;
  const { jobId } = req.params;

  const emit = (data: Record<string, unknown>) => sse.emit(data);

  const { getBusMatrixQueue } = await import('../../jobs/queues');
  const queue = getBusMatrixQueue();
  if (!queue) {
    emit({ type: 'error', message: 'Job queue not available' });
    sse.end();
    return;
  }

  const job = await queue.getJob(jobId);
  if (!job) { emit({ type: 'error', message: 'Job not found' }); sse.end(); return; }
  if (job.data.tenantId !== tenantId) { emit({ type: 'error', message: 'Forbidden' }); sse.end(); return; }

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  // Track which logs we've already sent so polling can resume on reconnect.
  let logCursor = 0;

  const pollLogs = async () => {
    try {
      const { logs } = await queue.getJobLogs(jobId, logCursor, logCursor + 500);
      if (logs.length > 0) {
        for (const line of logs) {
          let parsed: Record<string, unknown> | null = null;
          try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { /* ignore */ }
          if (parsed) emit(parsed);
          else emit({ type: 'log', text: line });
        }
        logCursor += logs.length;
      }
    } catch { /* job may have been removed */ }
  };

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
  }, 20_000);

  // Poll loop — every 500ms, drain new logs + check state.
  const POLL_MS = 500;
  while (!clientClosed) {
    await pollLogs();

    let state: string;
    try { state = await job.getState(); } catch { state = 'unknown'; }

    if (state === 'completed') {
      await pollLogs();
      const updated = await queue.getJob(jobId);
      emit({ type: 'completed', result: updated?.returnvalue ?? null });
      break;
    }
    if (state === 'failed') {
      await pollLogs();
      const updated = await queue.getJob(jobId);
      emit({ type: 'failed', error: updated?.failedReason ?? 'Job failed' });
      break;
    }
    if (state === 'unknown') {
      emit({ type: 'failed', error: 'Job vanished from queue' });
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  clearInterval(keepalive);
  sse.end();
});

// ---------------------------------------------------------------------------
// POST /api/products/bus-matrix-stream — SSE streaming enterprise bus matrix
// One AI call designs ALL dims + ALL facts + groupings. Replaces propose + design.
// (LEGACY — kept for backward compat. New flow uses /bus-matrix/start.)
// ---------------------------------------------------------------------------

router.post('/bus-matrix-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const reqId = `bms-${Date.now().toString(36)}`;
  const startTs = Date.now();
  const sse = startSSE(res);

  log.info(`[${reqId}] bus-matrix-stream START (connectionId=${(req.body as { connectionId?: number })?.connectionId})`);

  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    log.warn(`[${reqId}] CLIENT DISCONNECTED after ${Date.now() - startTs}ms`);
  });

  const emit = (data: Record<string, unknown>) => sse.emit(data);

  let keepaliveInterval: NodeJS.Timeout | null = null;

  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { emit({ type: 'error', message: 'connectionId required' }); sse.end(); return; }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) { emit({ type: 'error', message: 'Connection not found' }); sse.end(); return; }

    emit({ type: 'phase', text: `Reading schema for ${connection.name}…` });

    // Build source context WITHOUT example values to keep the prompt compact
    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const sourceTableIds = sourceTables.map((t: { id: number }) => t.id);
    const sourceColumns = sourceTableIds.length
      ? await db('source_columns').whereIn('table_id', sourceTableIds).orderBy('id')
      : [];

    const tablesText = sourceTables.map((t: { id: number; table_name: string; description: string }) => {
      const cols = sourceColumns
        .filter((c: { table_id: number }) => c.table_id === t.id)
        .map((c: { column_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean }) => {
          return `    ${c.column_name} (${c.data_type})${c.is_dimension ? ' [dimension]' : ''}${c.is_measure ? ' [measure]' : ''}: ${c.description ?? ''}`;
        }).join('\n');
      return `Table: ${t.table_name} — ${t.description ?? 'No description'}\n  Columns:\n${cols}`;
    }).join('\n\n');

    // Pull confirmed FK relationships from Neo4j so the AI knows the actual joins
    // instead of inferring them from column names (root cause of phantom join cols
    // like dc.source_system that crash the build).
    let relationshipsText = '';
    try {
      const { getRelationshipsForContext } = await import('../../db/semanticGraph');
      const rels = await getRelationshipsForContext(connectionId);
      if (rels.length > 0) {
        const lines = rels.map((r) => {
          const from = `${r.from_table as string}.${r.from_column as string}`;
          const to = `${r.to_table as string}.${r.to_column as string}`;
          const type = (r.relationship_type as string) || 'RELATES_TO';
          const desc = (r.description as string) ? ` — ${r.description as string}` : '';
          return `  ${from} → ${to} (${type})${desc}`;
        }).join('\n');
        relationshipsText = `\n\nCONFIRMED FOREIGN KEY RELATIONSHIPS (use these for fact↔dim joins — do NOT invent join columns):\n${lines}`;
      }
    } catch (err) {
      log.warn({ err }, `[${reqId}] Failed to load Neo4j relationships`);
    }

    const sourceContext = tablesText + relationshipsText;

    emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables, ${relationshipsText ? relationshipsText.split('\n').length - 2 : 0} relationships — designing bus matrix…` });

    // Send SSE keepalive comments every 20 seconds to prevent Azure / proxy timeout
    // during the (potentially long) AI generation phase.
    keepaliveInterval = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* connection already closed */ }
    }, 20_000);

    const { generateBusMatrixStreaming } = await import('../../ai/AIService');

    let busMatrix: Awaited<ReturnType<typeof generateBusMatrixStreaming>>;
    const aiStart = Date.now();
    try {
      busMatrix = await generateBusMatrixStreaming(
        connection.name as string,
        sourceContext,
        (type, delta) => {
          if (clientDisconnected) return; // don't fight with a dead socket
          if (type === 'thinking') emit({ type: 'thinking', text: delta });
          else if (type === 'diag') emit({ type: 'diag', text: delta });
        },
      );
      log.info(`[${reqId}] AI call completed in ${Date.now() - aiStart}ms`);
    } catch (aiErr) {
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      const msg = aiErr instanceof Error ? aiErr.message : 'AI call failed';
      log.error({ err: aiErr }, `[${reqId}] AI call FAILED after ${Date.now() - aiStart}ms: ${msg}`);
      emit({ type: 'error', message: `AI design failed: ${msg}` });
      sse.end();
      return;
    }

    if (keepaliveInterval) clearInterval(keepaliveInterval);
    log.info(`[${reqId}] Emitting 'done' (total ${Date.now() - startTs}ms, dims=${busMatrix.conformed_dimensions?.length ?? 0}, facts=${busMatrix.fact_tables?.length ?? 0})`);
    emit({ type: 'done', busMatrix });
  } catch (err) {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    log.error({ err }, `[${reqId}] Outer error after ${Date.now() - startTs}ms`);
    try {
      emit({ type: 'error', message: err instanceof Error ? err.message : 'Bus matrix design failed' });
    } catch { /* response already closed */ }
  }
  log.info(`[${reqId}] res.end() (total ${Date.now() - startTs}ms, clientDisconnected=${clientDisconnected})`);
  sse.end();
});

// ---------------------------------------------------------------------------
// POST /api/products/build-bus-matrix — Persist a bus matrix design to DB
// Creates data products, star schemas, tables (with SQL), columns, relationships.
// ---------------------------------------------------------------------------

router.post('/build-bus-matrix', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const reqId = `bm-save-${Date.now().toString(36)}`;
  try {
    const db = reqDb(req);
    const { connectionId, busMatrix } = req.body as {
      connectionId: number;
      busMatrix: import('../../ai/prompts/busMatrixPrompt').BusMatrixOutput;
    };
    if (!connectionId || !busMatrix) {
      res.status(400).json({ ok: false, error: 'connectionId and busMatrix required' });
      return;
    }

    // Pre-flight: recover from AI truncation (synthesize missing data_products
    // / relationships when the JSON-repair pass landed valid JSON but stripped
    // the trailing fields), THEN validate shape. Without recovery the user
    // loses 5-10 min of dim/fact design work on a truncation.
    const { recoverIncompleteBusMatrix } = await import('../../services/busMatrixBuilder');
    const recovery = recoverIncompleteBusMatrix(busMatrix);
    if (recovery.recovered) {
      log.info(`[${reqId}] bus matrix truncation recovered: ${recovery.notes.join('; ')}`);
    }
    const validationErrors: string[] = [];
    if (!Array.isArray(busMatrix.conformed_dimensions)) validationErrors.push('conformed_dimensions missing or not an array');
    if (!Array.isArray(busMatrix.fact_tables)) validationErrors.push('fact_tables missing or not an array');
    if (!Array.isArray(busMatrix.data_products)) validationErrors.push('data_products missing or not an array');
    (busMatrix.data_products ?? []).forEach((dp, i) => {
      if (!dp.name) validationErrors.push(`data_products[${i}].name missing`);
      if (!Array.isArray(dp.owned_dimensions)) validationErrors.push(`data_products[${i}] "${dp.name}": owned_dimensions missing`);
      if (!Array.isArray(dp.fact_tables)) validationErrors.push(`data_products[${i}] "${dp.name}": fact_tables missing`);
      if (typeof dp.build_order !== 'number') validationErrors.push(`data_products[${i}] "${dp.name}": build_order missing`);
    });
    (busMatrix.conformed_dimensions ?? []).forEach((d, i) => {
      if (!d.table_name) validationErrors.push(`conformed_dimensions[${i}].table_name missing`);
      if (!Array.isArray(d.columns)) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": columns missing`);
      if (!Array.isArray(d.source_tables)) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": source_tables missing`);
      if (!d.transformation_sql) validationErrors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql missing`);
    });
    (busMatrix.fact_tables ?? []).forEach((f, i) => {
      if (!f.table_name) validationErrors.push(`fact_tables[${i}].table_name missing`);
      if (!Array.isArray(f.columns)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": columns missing`);
      if (!Array.isArray(f.source_tables)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": source_tables missing`);
      if (!Array.isArray(f.dimensions_used)) validationErrors.push(`fact_tables[${i}] "${f.table_name}": dimensions_used missing`);
      if (!f.transformation_sql) validationErrors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql missing`);
    });

    log.info(`[${reqId}] build-bus-matrix START: ${busMatrix.conformed_dimensions?.length ?? 0} dims, ${busMatrix.fact_tables?.length ?? 0} facts, ${busMatrix.data_products?.length ?? 0} products, ${validationErrors.length} validation errors`);

    if (validationErrors.length > 0) {
      log.error({ validationErrors: validationErrors.slice(0, 20) }, `[${reqId}] bus matrix failed validation`);
      res.status(400).json({
        ok: false,
        error: 'Bus matrix is incomplete — the AI output was likely truncated. Retry the design.',
        details: validationErrors.slice(0, 10),
      });
      return;
    }

    const tenantId = req.user?.tenantId;
    const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../../ai/prompts/starSchemaPrompt');

    // Wrap in a transaction — all-or-nothing to avoid partial state on failure
    const results = await db.transaction(async (trx) => {

    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);

    // Build lookup maps for dims and facts
    const dimByName = new Map(busMatrix.conformed_dimensions.map((d) => [d.table_name, d]));
    const factByName = new Map(busMatrix.fact_tables.map((f) => [f.table_name, f]));

    // Sort products by build_order
    const sortedProducts = [...busMatrix.data_products].sort((a, b) => a.build_order - b.build_order);

    const productIdByName = new Map<string, number>();
    const _results: Array<{ name: string; id: number; status: string }> = [];

    // Collect all source table names used across dims + facts for data_product_sources
    const allSourceTablesByProduct = new Map<string, Set<string>>();
    for (const dp of sortedProducts) {
      const srcSet = new Set<string>();
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (dim) dim.source_tables.forEach((s) => srcSet.add(s));
      }
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (fact) fact.source_tables.forEach((s) => srcSet.add(s));
      }
      allSourceTablesByProduct.set(dp.name, srcSet);
    }

    // Track which product owns which dim (for dependency resolution)
    const dimOwnerProduct = new Map<string, string>();
    for (const dp of sortedProducts) {
      for (const dimName of dp.owned_dimensions) {
        dimOwnerProduct.set(dimName, dp.name);
      }
    }

    for (const dp of sortedProducts) {
      // Create data_product row
      const [productRow] = await trx('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        created_by: req.user?.email || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productRow === 'object' ? (productRow as { id: number }).id : (productRow as number);
      productIdByName.set(dp.name, pid);

      // Record dependencies: for each fact's dimensions_used, if the dim is owned by another product, add dependency
      const depProductNames = new Set<string>();
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue; // dim_date is auto-injected, no dependency needed
          const owner = dimOwnerProduct.get(dimName);
          if (owner && owner !== dp.name) depProductNames.add(owner);
        }
      }
      for (const depName of depProductNames) {
        const sourceId = productIdByName.get(depName);
        if (sourceId) {
          await trx('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      // Create star schema for this product
      const allTablesInProduct = [...dp.owned_dimensions, ...dp.fact_tables];
      const primaryFact = dp.fact_tables[0] ? factByName.get(dp.fact_tables[0]) : null;

      const [schemaRow] = await trx('star_schemas').insert({
        data_product_id: pid,
        name: dp.name,
        description: dp.description,
        grain: primaryFact?.grain ?? 'Conformed dimensions',
        fact_table_type: primaryFact?.fact_table_type ?? 'transaction',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const schemaId = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      // Insert owned dimensions
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (!dim) {
          log.warn(`[build-bus-matrix] Product "${dp.name}": owned dimension "${dimName}" not found in conformed_dimensions — skipping`);
          continue;
        }

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: dim.table_name,
          display_name: dim.display_name,
          description: dim.description,
          table_role: 'dimension',
          // OWNER row — this product materialises the dim. Stubs in
          // downstream products are inserted with is_shared_dimension=true
          // in the fact-tables loop below.
          is_shared_dimension: false,
          dag_order: 0,
          transformation_sql: dim.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(dim.table_name, tableId);

        // Insert columns
        for (const col of dim.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }
      }

      // Insert fact tables
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) {
          log.warn(`[build-bus-matrix] Product "${dp.name}": fact table "${factName}" not found in fact_tables — skipping`);
          continue;
        }

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: fact.table_name,
          display_name: fact.display_name,
          description: fact.description,
          table_role: 'fact',
          is_shared_dimension: false,
          dag_order: 1,
          transformation_sql: fact.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(fact.table_name, tableId);

        for (const col of fact.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }

        // Also add referenced shared dims (from other products) as stub entries
        // so the star schema has complete info for querying
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          if (dp.owned_dimensions.includes(dimName)) continue; // Already added above
          const dim = dimByName.get(dimName);
          if (!dim || tableNameToId.has(dimName)) continue;

          const [stubRow] = await trx('product_tables').insert({
            star_schema_id: schemaId,
            table_name: dim.table_name,
            display_name: dim.display_name,
            description: dim.description,
            table_role: 'dimension',
            is_shared_dimension: true,
            dag_order: 0,
            transformation_sql: null, // Not built here — owned by another product
            transformation_status: 'draft',
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).returning('id');
          const stubId = typeof stubRow === 'object' ? (stubRow as { id: number }).id : (stubRow as number);
          tableNameToId.set(dim.table_name, stubId);

          // Insert dim columns as metadata (for query context)
          for (const col of dim.columns) {
            await trx('product_columns').insert({
              product_table_id: stubId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              ai_draft: true,
            });
          }
        }
      }

      // Auto-inject dim_date
      const dateRange = busMatrix.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };
      const isFirstBuilder = dp.build_order === 1;
      const [dimDateRow] = await trx('product_tables').insert({
        star_schema_id: schemaId,
        table_name: 'dim_date',
        display_name: 'Date',
        description: 'Auto-generated calendar dimension',
        table_role: 'dimension',
        // Only the first product in build order materializes dim_date.
        // All later products treat it as a conformed (shared) dimension and
        // load it from the owning product's parquet at run time.
        is_shared_dimension: !isFirstBuilder,
        dag_order: 0,
        transformation_sql: isFirstBuilder ? DIM_DATE_SQL(dateRange.start, dateRange.end) : null,
        transformation_status: 'draft',
        ai_draft: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const dimDateId = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await trx('product_columns').insert({
          product_table_id: dimDateId,
          column_name: col.column_name,
          data_type: col.data_type,
          display_name: col.display_name,
          description: col.description,
          column_role: col.column_role,
          transformation_expression: col.transformation_expression,
          scd_type: col.scd_type,
          sort_order: col.sort_order,
          ai_draft: false,
        });
      }

      // Save relationships for tables in this product
      for (const rel of busMatrix.relationships) {
        const fromId = tableNameToId.get(rel.from_table_name);
        const toId = tableNameToId.get(rel.to_table_name);
        if (fromId && toId) {
          await trx('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromId,
            from_column_name: rel.from_column_name,
            to_table_id: toId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      // Populate data_product_sources
      const srcSet = allSourceTablesByProduct.get(dp.name);
      if (srcSet && srcSet.size > 0) {
        const sourceTblRows = await trx('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...srcSet])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await trx('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            })),
          );
        }
      }

      // Save KPIs for this product
      const productKpis = (busMatrix.proposed_kpis ?? []).filter((k) => k.product_name === dp.name);
      if (productKpis.length > 0) {
        await trx('product_kpis').insert(
          productKpis.map((k) => ({
            data_product_id: pid,
            name: k.name,
            description: k.description,
            formula_plain_text: k.formula_plain_text,
            formula_sql: k.formula_sql,
            ai_draft: true,
          })),
        );
      }

      // Mark as approved (ready to run)
      await trx('data_products').where({ id: pid }).update({
        status: 'approved',
        updated_at: new Date().toISOString(),
      });

      // Count tables actually inserted for this product
      const tableCount = await trx('product_tables').where({ star_schema_id: schemaId }).count('id as count').first();
      const count = Number(tableCount?.count ?? 0);
      log.info(`[build-bus-matrix] Product "${dp.name}" (id=${pid}): ${count} tables created (owned_dims: ${dp.owned_dimensions.length}, facts: ${dp.fact_tables.length})`);

      _results.push({ name: dp.name, id: pid, status: 'created' });
    }

    // Summary
    log.info(`[build-bus-matrix] Summary: AI designed ${busMatrix.conformed_dimensions?.length ?? 0} dims + ${busMatrix.fact_tables?.length ?? 0} facts → ${_results.length} products`);

    return _results;

    }); // end transaction

    log.info(`[${reqId}] build-bus-matrix SUCCESS: ${results.length} products created`);
    res.json({ ok: true, data: { products: results } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any)?.code ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (err as any)?.detail ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const constraint = (err as any)?.constraint ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = (err as any)?.table ?? null;
    log.error({ code, detail, constraint, table, stack }, `[${reqId}] build-bus-matrix FAILED: ${msg}`);
    if (res.headersSent) return;
    // Rethrow to the central errorHandler (admins get the real message,
    // non-admins a generic one) instead of echoing code/constraint/detail.
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/propose-stream — SSE streaming version of /propose
// Streams Claude's thinking tokens live so the browser shows progress immediately.
// (LEGACY — kept for backward compat; new flow uses bus-matrix-stream)
// ---------------------------------------------------------------------------

router.post('/propose-stream', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const sse = startSSE(res);

  const emit = (data: Record<string, unknown>) => sse.emit(data);

  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { emit({ type: 'error', message: 'connectionId required' }); sse.end(); return; }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) { emit({ type: 'error', message: 'Connection not found' }); sse.end(); return; }

    emit({ type: 'phase', text: `Reading schema for ${connection.name}…` });

    // Same data-gathering as /propose
    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    emit({ type: 'phase', text: `Loaded ${sourceTables.length} tables — asking Claude to plan the warehouse…` });

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await db('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure', 'example_values');
      const fkRels = await db('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');
      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));
      const bkCol = t.business_key_column as string | null;
      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: c.column_name === 'id' || c.column_name === bkCol,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    const existingProducts = await db('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateBusMatrixStreaming } = await import('../../ai/AIService');

    const sourceTablesContextStream = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const proposal = await generateBusMatrixStreaming(
      connection.name as string,
      sourceTablesContextStream,
      (type, delta) => {
        if (type === 'thinking') emit({ type: 'thinking', text: delta });
      },
    );

    emit({ type: 'done', proposal });
  } catch (err) {
    log.error({ err }, '[products/propose-stream] Error');
    emit({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
  }
  sse.end();
});

// POST /api/products/propose — AI auto-proposes all data products for a connection
// ---------------------------------------------------------------------------

router.post('/propose', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId } = req.body as { connectionId: number };
    if (!connectionId) { res.status(400).json({ ok: false, error: 'connectionId required' }); return; }

    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }

    // Gather semantic context from Postgres + Neo4j
    const sourceTables = await db('source_tables as st')
      .where({ 'st.connection_id': connectionId, 'st.is_active': true })
      .select('st.*');

    const tableContexts = await Promise.all(sourceTables.map(async (t: Record<string, unknown>) => {
      const columns = await db('source_columns')
        .where({ table_id: t.id })
        .select('id', 'column_name', 'data_type', 'description', 'is_dimension', 'is_measure', 'example_values');

      // Derive FK info from table_relationships (from_column_id → to source_tables)
      const fkRels = await db('table_relationships as tr')
        .join('source_tables as st2', 'tr.to_table_id', 'st2.id')
        .where({ 'tr.from_table_id': t.id })
        .select('tr.from_column_id', 'st2.table_name as to_table_name', 'tr.relationship_type');

      const fkByColId = new Map(fkRels.map((r: Record<string, unknown>) => [r.from_column_id, r]));

      // Heuristic: column named 'id' or matching business_key_column is PK
      const bkCol = t.business_key_column as string | null;

      return {
        table_name: t.table_name as string,
        display_name: (t.display_name as string) || (t.table_name as string),
        description: (t.description as string) || '',
        domain: Array.isArray(t.domains) ? (t.domains as string[]).join(', ') : '',
        columns: columns.map((c: Record<string, unknown>) => {
          const fk = fkByColId.get(c.id);
          const isPk = c.column_name === 'id' || c.column_name === bkCol;
          return {
            column_name: c.column_name as string,
            data_type: (c.data_type as string) || 'TEXT',
            description: (c.description as string) || '',
            is_primary_key: isPk,
            is_foreign_key: !!fk,
            fk_references: fk ? (fk as Record<string, unknown>).to_table_name as string : undefined,
          };
        }),
        relationships: fkRels.map((r: Record<string, unknown>) => ({
          to_table: r.to_table_name as string,
          via_column: String(r.from_column_id),
          type: (r.relationship_type as string) || 'many_to_one',
        })),
      };
    }));

    // Existing products (so Claude doesn't recreate them)
    const existingProducts = await db('data_products').where({ connection_id: connectionId });
    const existingWithDims = await Promise.all(existingProducts.map(async (p: Record<string, unknown>) => {
      const sharedTables = await db('product_tables as pt')
        .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
        .where({ 'ss.data_product_id': p.id, 'pt.is_shared_dimension': false }).where('pt.table_role', 'dimension')
        .pluck('pt.table_name');
      return { name: p.name as string, shared_dimension_tables: sharedTables };
    }));

    const { generateBusMatrixStreaming: generateBusMatrix } = await import('../../ai/AIService');
    const sourceTablesContextProp = (tableContexts as Array<{ table_name: string; description: string; columns: Array<{ column_name: string; data_type: string; description: string; is_primary_key: boolean; is_foreign_key: boolean; fk_references?: string }> }>).map((t) =>
      `Table: ${t.table_name} — ${t.description || 'No description'}\n  Columns:\n${t.columns.map((c) =>
        `    ${c.column_name} (${c.data_type})${c.is_primary_key ? ' [PK]' : ''}${c.is_foreign_key ? ` [FK→${c.fk_references}]` : ''}: ${c.description || ''}`
      ).join('\n')}`
    ).join('\n\n');
    const proposal = await generateBusMatrix(connection.name as string, sourceTablesContextProp, () => {});

    res.json({ ok: true, data: proposal });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/build-proposed — persist + queue a full proposal
// ---------------------------------------------------------------------------

router.post('/build-proposed', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connectionId, proposal } = req.body as {
      connectionId: number;
      proposal: import('../../ai/prompts/dataProductProposalPrompt').DataProductProposal;
    };
    if (!connectionId || !proposal) { res.status(400).json({ ok: false, error: 'connectionId and proposal required' }); return; }

    const tenantId = req.user?.tenantId;

    // Sort products by build_order so owners are created before dependents
    const sorted = [...proposal.data_products].sort((a, b) => a.build_order - b.build_order);

    // Map product name → DB id (populated as we insert)
    const productIdByName = new Map<string, number>();

    const results: Array<{ name: string; id: number; status: string }> = [];

    for (const dp of sorted) {
      // Create data_product row
      const [productId] = await db('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        created_by: req.user?.email || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productId === 'object' ? (productId as { id: number }).id : productId;
      productIdByName.set(dp.name, pid);

      // Record dependencies
      for (const dep of dp.depends_on) {
        const sourceId = productIdByName.get(dep.source_product_name);
        if (sourceId) {
          await db('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      // Create star schemas + tables
      for (const ss of dp.star_schemas) {
        const [schemaId] = await db('star_schemas').insert({
          data_product_id: pid,
          name: ss.name,
          description: ss.description,
          grain: ss.grain,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const ssid = typeof schemaId === 'object' ? (schemaId as { id: number }).id : schemaId;

        for (const tbl of ss.tables) {
          await db('product_tables').insert({
            star_schema_id: ssid,
            table_name: tbl.table_name,
            display_name: tbl.display_name,
            description: tbl.description,
            table_role: tbl.table_role,
            is_shared_dimension: tbl.is_shared_dimension,
            transformation_sql: null,          // generated later via AI Design
            transformation_status: 'draft',
            dag_order: tbl.dag_order,
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Populate data_product_sources so AI Design Star Schema can find source table context
      const allSourceTableNames = new Set<string>();
      for (const ss of dp.star_schemas) {
        for (const tbl of ss.tables) {
          for (const src of tbl.source_tables) {
            allSourceTableNames.add(src);
          }
        }
      }
      if (allSourceTableNames.size > 0) {
        const sourceTblRows = await db('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...allSourceTableNames])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await db('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            }))
          );
        }
      }

      results.push({ name: dp.name, id: pid, status: 'created' });
    }

    // Queue transformations in build_order (one job per product)
    try {
      const { getTransformationQueue } = await import('../../jobs/queues');
      const tQueue = getTransformationQueue();
      if (tQueue) {
        for (const r of results) {
          await tQueue.add('transform', { productId: r.id, tenantId, triggeredBy: 'system' });
        }
      }
    } catch {
      // Redis not available — caller can trigger manually
    }

    res.json({ ok: true, data: { products: results } });
  } catch (err) { next(err); }
});


export default router;
