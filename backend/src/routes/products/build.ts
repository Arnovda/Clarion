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
import { productRefreshStartSchema, buildChatSchema, busMatrixExtendStartSchema } from '../../middleware/schemas';
import { reqDb } from '../../db/reqDb';
import { startSSE } from '../../services/sse';
import { log } from './shared';

const router = Router();


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
            .where((qb) => {
                // Stubs (shared dims from another product) carry no SQL — the
                // runner's skip-path publishes them from the upstream owner, which
                // is also what flips their status to 'success'. Excluding them
                // left every stub at 'draft' forever (found 2026-08-24 via the
                // topics canvas drawing zero relations).
                qb.whereNotNull('transformation_sql').orWhere('is_shared_dimension', true);
              })
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

// ---------------------------------------------------------------------------
// POST /api/products/build-chat — the Build page's "Ask about your subjects"
// chat. READ-ONLY BY CONSTRUCTION: this endpoint answers coverage questions
// and may return a `proposal` object, but it mutates nothing — the only way
// a proposal becomes a subject is the user clicking Add, which calls the
// guarded /bus-matrix/extend-start below. Facts come from the server-built
// coverage context (real catalog rows), the model only phrases them.
// ---------------------------------------------------------------------------
router.post('/build-chat', requireAuth, requireRole('admin', 'analyst'), validate(buildChatSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(401).json({ ok: false, error: 'Tenant context required' }); return; }

    const { messages } = req.body as { messages: Array<{ role: 'user' | 'assistant'; content: string }> };

    const { buildCoverageContext } = await import('../../services/buildChatContext');
    const coverage = await buildCoverageContext(db, tenantId);

    const { respondBuildChat } = await import('../../ai/AIService');
    const response = await respondBuildChat(coverage.text, messages);

    // Server-side proposal validation — the model's suggestion only survives
    // when every part of it checks out against the real catalog. A proposal
    // that names an unknown connection, an existing subject, or entities
    // that never synced is dropped (the reply still stands on its own).
    let proposal = response.proposal ?? null;
    if (proposal) {
      const synced = coverage.syncedTablesByConnection.get(proposal.connection_id);
      const entities = synced ? proposal.entities.filter((e) => synced.has(e)) : [];
      const nameOk = !coverage.productNamesLower.has(proposal.name.trim().toLowerCase());
      proposal = synced && entities.length > 0 && nameOk
        ? { ...proposal, entities }
        : null;
    }

    res.json({ ok: true, data: { reply: response.reply, proposal } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/products/bus-matrix/extend-start — enqueue an ADDITIVE build: one
// new subject designed next to the existing ones. Guards run BEFORE the
// queue check so they hold in every environment:
//   404 unknown connection · 400 entities not synced · 409 name collision ·
//   503 no Redis · 409 another build already running.
// The workflow re-checks collisions in code after the AI designs (see
// prepareExtensionMatrix) — this route's checks just fail fast and friendly.
// ---------------------------------------------------------------------------
router.post('/bus-matrix/extend-start', requireAuth, requireRole('admin', 'analyst'), validate(busMatrixExtendStartSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user?.tenantId;
    if (!tenantId) { res.status(403).json({ ok: false, error: 'Tenant context required' }); return; }

    const { connectionId, name, description, focus, entities } = req.body as {
      connectionId: number; name: string; description?: string; focus?: string; entities: string[];
    };

    const connection = await db('connections').where({ id: connectionId, tenant_id: tenantId }).first();
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }

    const syncedRows = await db('source_tables')
      .where({ connection_id: connectionId, tenant_id: tenantId, is_active: true })
      .whereIn('table_name', entities)
      .select('table_name');
    const syncedSet = new Set(syncedRows.map((r: { table_name: string }) => r.table_name));
    const missing = entities.filter((e) => !syncedSet.has(e));
    if (missing.length > 0) {
      res.status(400).json({ ok: false, error: `These tables are not synced from this source: ${missing.join(', ')}` });
      return;
    }

    const clash = await db('data_products')
      .where({ tenant_id: tenantId })
      .whereRaw('LOWER(TRIM(name)) = ?', [name.trim().toLowerCase()])
      .first();
    if (clash) {
      res.status(409).json({ ok: false, error: `A subject named "${name}" already exists.` });
      return;
    }

    // An addition builds NEXT TO an existing build — it reuses its shared
    // lookups and its Date calendar (build_order is forced past 1, so the
    // extension never materialises dim_date itself). With no build yet
    // there is nothing to extend: the full "Create my topics" flow is the
    // right door, and it will usually cover this subject anyway.
    const anyProduct = await db('data_products')
      .where({ tenant_id: tenantId, connection_id: connectionId })
      .first();
    if (!anyProduct) {
      res.status(409).json({
        ok: false,
        error: 'No subjects exist for this source yet — use "Create my topics" first; additions build on top of that.',
      });
      return;
    }

    const { getBusMatrixQueue } = await import('../../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      res.status(503).json({ ok: false, error: 'Job queue not available — Redis is not configured.' });
      return;
    }

    // One build at a time per tenant — same rule as the full build; an
    // extension racing a rebuild would design against a schema that is
    // being replaced under it.
    const activeJobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 50);
    const existing = activeJobs.find((j) => j.data.tenantId === tenantId);
    if (existing) {
      res.status(409).json({ ok: false, error: 'A build is already running — wait for it to finish.', jobId: existing.id });
      return;
    }

    const job = await queue.add('topic-extend', {
      connectionId,
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
      mode: 'extend' as const,
      extendRequest: { name: name.trim(), description: description ?? '', focus, entities },
    });

    res.json({ ok: true, data: { jobId: job.id, queue: 'bus-matrix', mode: 'extend' } });
  } catch (err) { next(err); }
});

// The four bus-matrix job routes below (start / active / cancel / stream) are
// admin+analyst: the role table grants "Design star schema products" to both,
// and the Build page — the flow's front door — is an analyst+ surface. The
// other build routes in this file stay admin-only until a surface needs them.
router.post('/bus-matrix/start', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response) => {
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

router.get('/bus-matrix/active', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response) => {
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

    // P1-1 "show queue position meanwhile": with concurrency 2 and
    // per-tenant fairness a build can genuinely wait behind other
    // tenants' work now, and a spinner that cannot say why reads as
    // broken. buildsAhead = jobs that will get a slot before this one
    // (approximate — active ones finish in unknown order; a delayed job
    // sits behind the whole waiting list by construction).
    let buildsAhead: number | null = null;
    if (state === 'waiting' || state === 'delayed') {
      try {
        const [active, waiting] = await Promise.all([
          queue.getActive(0, 25),
          queue.getWaiting(0, 100),
        ]);
        const idx = waiting.findIndex((j) => j.id === match.id);
        buildsAhead = active.length + (idx >= 0 ? idx : waiting.length);
      } catch { /* position is a nicety — never fail the endpoint for it */ }
    }

    res.json({
      ok: true,
      data: {
        jobId: match.id,
        state,
        connectionId: match.data.connectionId,
        progress: match.progress,
        createdAt: match.timestamp,
        buildsAhead,
      },
    });
  } catch (err) {
    throw err; // central errorHandler — no inline raw-error echo
  }
});

router.post('/bus-matrix/:jobId/cancel', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response) => {
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
        // `aborted` is true only when the running job happens to live in THIS
        // process. With Redis configured the request is also recorded there, so
        // a worker in another container picks it up at its next checkpoint or
        // cancellation poll — the message must not imply nothing happened.
        message: aborted
          ? 'Cancellation signal sent — the worker will stop at the next safe checkpoint.'
          : (state === 'waiting' || state === 'delayed')
            ? 'Job removed from the queue before it started.'
            : 'Cancellation requested — the worker will stop at its next checkpoint.',
      },
    });
  } catch (err) {
    throw err; // central errorHandler — no inline raw-error echo
  }
});

router.get('/bus-matrix/:jobId/stream', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response) => {
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


export default router;
