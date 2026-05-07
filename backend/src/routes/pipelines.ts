/**
 * Pipelines API — DAG view of every data product, dependencies, and orchestrated runs.
 *
 * Routes:
 *   GET  /api/pipelines           — overview: products, edges, table status rollup
 *   GET  /api/pipelines/:id       — single-product detail (tables, deps, schedule)
 *   POST /api/pipelines/run       — trigger orchestrated run across products
 *
 * Run ordering: cross-product topo via resolveUpstreamProductsTopo, then within
 * each product the existing transformationRunner respects dag_order (dims first).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { resolveUpstreamProductsTopo } from '../services/productOwnership';
import { getTransformationQueue, TransformationJobData } from '../jobs/queues';

const router = Router();

interface ProductRow {
  id: number; name: string; status: string; connection_id: number | null;
}
interface TableRow {
  id: number; star_schema_id: number; table_name: string; display_name: string | null;
  table_role: string | null; dag_order: number | null;
  transformation_status: string | null; last_run_at: Date | string | null;
  last_run_error: string | null; row_count: number | null;
}
interface ScheduleRow {
  product_id: number; cron_expression: string; timezone: string | null; enabled: boolean;
}

// ---------------------------------------------------------------------------
// GET /api/pipelines — overview for the DAG canvas
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const products = await semanticDb('data_products')
      .select<ProductRow[]>('id', 'name', 'status', 'connection_id')
      .orderBy('id');
    const productIds = products.map((p) => p.id);

    if (productIds.length === 0) {
      res.json({ ok: true, data: { products: [], productEdges: [], tables: [], tableEdges: [] } });
      return;
    }

    // Schemas for these products
    const schemas = await semanticDb('star_schemas')
      .whereIn('data_product_id', productIds)
      .select<{ id: number; data_product_id: number }[]>('id', 'data_product_id');
    const schemaToProduct = new Map(schemas.map((s) => [s.id, s.data_product_id]));
    const schemaIds = schemas.map((s) => s.id);

    const tables = schemaIds.length
      ? await semanticDb('product_tables')
          .whereIn('star_schema_id', schemaIds)
          .select<TableRow[]>(
            'id', 'star_schema_id', 'table_name', 'display_name', 'table_role',
            'dag_order', 'transformation_status', 'last_run_at', 'last_run_error', 'row_count',
          )
      : [];

    // Cross-product dependencies (edges between products)
    const productEdges = await semanticDb('data_product_dependencies')
      .whereIn('dependent_product_id', productIds)
      .select<{ dependent_product_id: number; source_product_id: number }[]>(
        'dependent_product_id', 'source_product_id',
      );

    // Per-table relationships (edges between tables, within and across schemas)
    const tableEdges = schemaIds.length
      ? await semanticDb('product_relationships')
          .whereIn('star_schema_id', schemaIds)
          .select<{ from_table_id: number; to_table_id: number; relationship_type: string }[]>(
            'from_table_id', 'to_table_id', 'relationship_type',
          )
      : [];

    // Schedules
    const schedules = await semanticDb('transformation_schedules')
      .whereIn('product_id', productIds)
      .select<ScheduleRow[]>('product_id', 'cron_expression', 'timezone', 'enabled');
    const scheduleByProduct = new Map(schedules.map((s) => [s.product_id, s]));

    // Roll up table statuses per product + compute aggregate
    const tablesByProduct = new Map<number, TableRow[]>();
    for (const t of tables) {
      const pid = schemaToProduct.get(t.star_schema_id);
      if (pid == null) continue;
      const arr = tablesByProduct.get(pid) ?? [];
      arr.push(t);
      tablesByProduct.set(pid, arr);
    }

    const productSummaries = products.map((p) => {
      const pTables = tablesByProduct.get(p.id) ?? [];
      const counts = { total: pTables.length, success: 0, running: 0, error: 0, draft: 0 };
      let lastRunAt: string | null = null;
      for (const t of pTables) {
        const s = (t.transformation_status ?? 'draft').toLowerCase();
        if (s === 'success')      counts.success++;
        else if (s === 'running') counts.running++;
        else if (s === 'error')   counts.error++;
        else                      counts.draft++;
        if (t.last_run_at) {
          const iso = typeof t.last_run_at === 'string' ? t.last_run_at : t.last_run_at.toISOString();
          if (!lastRunAt || iso > lastRunAt) lastRunAt = iso;
        }
      }
      // Aggregate status: error > running > stale > success > never_run
      let status: 'error' | 'running' | 'success' | 'never_run' = 'never_run';
      if (counts.error > 0)              status = 'error';
      else if (counts.running > 0)       status = 'running';
      else if (counts.success > 0)       status = 'success';

      const sched = scheduleByProduct.get(p.id) ?? null;
      return {
        id: p.id,
        name: p.name,
        status,
        last_run_at: lastRunAt,
        connection_id: p.connection_id,
        table_counts: counts,
        schedule: sched ? {
          cron_expression: sched.cron_expression,
          timezone: sched.timezone,
          enabled: sched.enabled,
        } : null,
      };
    });

    // Mark products as `stale` if any upstream's last_run_at is newer than theirs
    const productLastRun = new Map(productSummaries.map((p) => [p.id, p.last_run_at]));
    for (const p of productSummaries) {
      if (p.status !== 'success') continue;
      const upstreamIds = productEdges
        .filter((e) => e.dependent_product_id === p.id)
        .map((e) => e.source_product_id);
      for (const upId of upstreamIds) {
        const upRun = productLastRun.get(upId);
        if (upRun && p.last_run_at && upRun > p.last_run_at) {
          (p as { status: string }).status = 'stale';
          break;
        }
      }
    }

    res.json({
      ok: true,
      data: {
        products: productSummaries,
        productEdges: productEdges.map((e) => ({
          source: e.source_product_id,
          target: e.dependent_product_id,
        })),
        tables: tables.map((t) => ({
          id: t.id,
          product_id: schemaToProduct.get(t.star_schema_id) ?? null,
          star_schema_id: t.star_schema_id,
          table_name: t.table_name,
          display_name: t.display_name,
          table_role: t.table_role,
          dag_order: t.dag_order,
          transformation_status: t.transformation_status,
          last_run_at: t.last_run_at,
          last_run_error: t.last_run_error,
          row_count: t.row_count,
        })),
        tableEdges: tableEdges.map((e) => ({
          source: e.from_table_id,
          target: e.to_table_id,
          relationship_type: e.relationship_type,
        })),
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/pipelines/run — orchestrated multi-product refresh
// Body: { scope: 'all' | 'stale' | { productIds: number[] } }
// ---------------------------------------------------------------------------
router.post('/run', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const scope = req.body?.scope as
      | 'all'
      | 'stale'
      | { productIds: number[] }
      | undefined;

    if (!scope) {
      res.status(400).json({ ok: false, error: 'scope is required' });
      return;
    }

    // 1. Resolve the explicit product set the caller wants run.
    const allProducts = await semanticDb('data_products').select<ProductRow[]>('id', 'name', 'status', 'connection_id');
    let requestedIds: number[] = [];
    if (scope === 'all') {
      requestedIds = allProducts.map((p) => p.id);
    } else if (scope === 'stale') {
      // Re-use the GET endpoint logic: a product is stale if any upstream is newer.
      // For simplicity, just include products whose latest table run is older than any upstream's.
      const schemas = await semanticDb('star_schemas')
        .whereIn('data_product_id', allProducts.map((p) => p.id))
        .select<{ id: number; data_product_id: number }[]>('id', 'data_product_id');
      const schemaToProduct = new Map(schemas.map((s) => [s.id, s.data_product_id]));
      const tableRuns = await semanticDb('product_tables')
        .whereIn('star_schema_id', schemas.map((s) => s.id))
        .select<{ star_schema_id: number; last_run_at: string | Date | null; transformation_status: string | null }[]>(
          'star_schema_id', 'last_run_at', 'transformation_status',
        );
      const productLastRun = new Map<number, string | null>();
      const productHasError = new Set<number>();
      for (const t of tableRuns) {
        const pid = schemaToProduct.get(t.star_schema_id);
        if (pid == null) continue;
        if ((t.transformation_status ?? '').toLowerCase() !== 'success') productHasError.add(pid);
        if (t.last_run_at) {
          const iso = typeof t.last_run_at === 'string' ? t.last_run_at : t.last_run_at.toISOString();
          const cur = productLastRun.get(pid);
          if (!cur || iso > cur) productLastRun.set(pid, iso);
        }
      }
      const edges = await semanticDb('data_product_dependencies')
        .select<{ dependent_product_id: number; source_product_id: number }[]>('dependent_product_id', 'source_product_id');
      for (const p of allProducts) {
        if (productHasError.has(p.id) || !productLastRun.has(p.id)) {
          requestedIds.push(p.id);
          continue;
        }
        const myRun = productLastRun.get(p.id) ?? null;
        const upstream = edges.filter((e) => e.dependent_product_id === p.id).map((e) => e.source_product_id);
        for (const upId of upstream) {
          const upRun = productLastRun.get(upId);
          if (upRun && myRun && upRun > myRun) { requestedIds.push(p.id); break; }
        }
      }
    } else if (Array.isArray(scope.productIds)) {
      requestedIds = scope.productIds.map(Number).filter(Number.isFinite);
    } else {
      res.status(400).json({ ok: false, error: 'invalid scope' });
      return;
    }

    if (requestedIds.length === 0) {
      res.json({ ok: true, data: { order: [], enqueued: [], note: 'Nothing to run' } });
      return;
    }

    // 2. Expand each requested id with its full upstream chain (tenant-scoped).
    const expanded = new Set<number>();
    for (const pid of requestedIds) {
      expanded.add(pid);
      try {
        const upstreams = await resolveUpstreamProductsTopo(pid, tenantId);
        for (const u of upstreams) expanded.add(u);
      } catch { /* ignore — bad pid will surface when we try to enqueue */ }
    }

    // 3. Topo-sort the union. Reuse Kahn's on the same edge set.
    const ids = Array.from(expanded);
    const allEdges = await semanticDb('data_product_dependencies')
      .whereIn('dependent_product_id', ids)
      .whereIn('source_product_id', ids)
      .select<{ dependent_product_id: number; source_product_id: number }[]>('dependent_product_id', 'source_product_id');
    const inDegree = new Map<number, number>(ids.map((id) => [id, 0]));
    const adj = new Map<number, number[]>(ids.map((id) => [id, []]));
    for (const e of allEdges) {
      adj.get(e.source_product_id)!.push(e.dependent_product_id);
      inDegree.set(e.dependent_product_id, (inDegree.get(e.dependent_product_id) ?? 0) + 1);
    }
    const ready = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
    const order: number[] = [];
    while (ready.length > 0) {
      const next = ready.shift()!;
      order.push(next);
      for (const child of adj.get(next) ?? []) {
        const d = (inDegree.get(child) ?? 0) - 1;
        inDegree.set(child, d);
        if (d === 0) ready.push(child);
      }
    }
    for (const id of ids) if (!order.includes(id)) order.push(id);

    // 4. Enqueue in order. Each downstream BullMQ job runs after Redis picks it up;
    //    we don't wait between enqueues — the runner reads upstream parquet from
    //    the warehouse, so as long as upstream completes first the dep is satisfied.
    const queue = getTransformationQueue();
    const enqueued: { productId: number; runId: number; jobId?: string; inline?: boolean }[] = [];
    for (const productId of order) {
      const product = allProducts.find((p) => p.id === productId);
      if (!product) continue;
      const [runRow] = await semanticDb('transformation_runs').insert({
        tenant_id: tenantId,
        product_id: productId,
        triggered_by: req.user!.email,
        status: 'running',
      }).returning('id');
      const runId = typeof runRow === 'object' ? (runRow as { id: number }).id : (runRow as number);

      if (queue) {
        const job = await queue.add('pipeline-run', {
          productId,
          tenantId,
          triggeredBy: req.user!.email,
        } as TransformationJobData);
        enqueued.push({ productId, runId, jobId: job.id });
      } else {
        enqueued.push({ productId, runId, inline: true });
        // Fire-and-forget inline run; sequential because we await each before moving on
        // would block the response — orchestrator background task instead.
        (async () => {
          try {
            const { runProductTransformation } = await import('../services/transformationRunner');
            const schemas = await semanticDb('star_schemas').where({ data_product_id: productId });
            const tables = schemas.length
              ? await semanticDb('product_tables').whereIn('star_schema_id', schemas.map((s) => s.id))
              : [];
            const results = await runProductTransformation(product, tables, tenantId);
            await semanticDb('transformation_runs').where({ id: runId }).update({
              status: 'completed',
              tables_transformed: results.length,
              finished_at: new Date(),
            });
          } catch (err) {
            await semanticDb('transformation_runs').where({ id: runId }).update({
              status: 'failed',
              error_message: err instanceof Error ? err.message : 'Unknown error',
              finished_at: new Date(),
            });
          }
        })();
      }
    }

    res.json({ ok: true, data: { order, enqueued } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/pipelines/clear-stuck — mark any product_tables / transformation_runs
// stuck in 'running' with last_run_at older than 5 minutes as failed/error.
// Lets the user reset orphaned-worker rows on demand without waiting for a
// container restart's startup cleanup.
// ---------------------------------------------------------------------------
router.post('/clear-stuck', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const STUCK_THRESHOLD_MIN = 5;
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MIN * 60 * 1000).toISOString();
    const tables = await semanticDb('product_tables')
      .where('transformation_status', 'running')
      .where((qb) => qb.whereNull('last_run_at').orWhere('last_run_at', '<', cutoff))
      .update({
        transformation_status: 'error',
        last_run_at: new Date().toISOString(),
        last_run_error: 'Run interrupted — cleared by user',
      });
    const runs = await semanticDb('transformation_runs')
      .where('status', 'running')
      .where((qb) => qb.whereNull('started_at').orWhere('started_at', '<', cutoff))
      .update({
        status: 'failed',
        error_message: 'Run interrupted — cleared by user',
        finished_at: new Date(),
      });
    res.json({ ok: true, data: { tablesCleared: tables, runsClosed: runs } });
  } catch (err) { next(err); }
});

// ===========================================================================
// V2 routes — pipelines as first-class entities (sources + products in scope,
// triggers, run history). Sit alongside the legacy product-DAG endpoints.
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/pipelines/dag — full tenant graph (sources + products + edges)
// ---------------------------------------------------------------------------
router.get('/dag', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getDag } = await import('../services/pipelineService');
    const dag = await getDag(req.user!.tenantId);
    res.json({ ok: true, data: dag });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/pipelines/list — built-in (computed) + saved (custom) pipelines
// ---------------------------------------------------------------------------
router.get('/list', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

    const { listBuiltinPipelines } = await import('../services/pipelineService');
    const builtin = await listBuiltinPipelines(tenantId);

    const customRows = await semanticDb('pipelines')
      .where('tenant_id', tenantId)
      .orderBy('updated_at', 'desc')
      .select('id', 'name', 'description', 'kind', 'scope', 'triggers', 'enabled',
              'last_run_at', 'last_status', 'created_by', 'created_at', 'updated_at');

    res.json({
      ok: true,
      data: {
        builtin,
        custom: customRows.map((r: Record<string, unknown>) => ({
          id: r.id,
          stableId: `custom:${r.id}`,
          name: r.name,
          description: r.description,
          kind: r.kind,
          scope: typeof r.scope === 'string' ? JSON.parse(r.scope as string) : r.scope,
          triggers: typeof r.triggers === 'string' ? JSON.parse(r.triggers as string) : (r.triggers ?? []),
          enabled: r.enabled,
          lastRunAt: r.last_run_at,
          lastStatus: r.last_status,
          createdBy: r.created_by,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/pipelines/saved — create a custom pipeline
// Body: { name, description?, scope, triggers?: [], enabled? }
// ---------------------------------------------------------------------------
router.post('/saved', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

    const { name, description, scope, triggers, enabled } = req.body as {
      name: string; description?: string;
      scope: unknown; triggers?: unknown[]; enabled?: boolean;
    };
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
    if (!scope) return res.status(400).json({ ok: false, error: 'scope is required' });

    const [row] = await semanticDb('pipelines').insert({
      tenant_id: tenantId,
      name: name.trim(),
      description: description ?? null,
      kind: 'custom',
      scope: JSON.stringify(scope),
      triggers: JSON.stringify(triggers ?? []),
      enabled: enabled ?? true,
      created_by: req.user?.email ?? null,
    }).returning('id');
    const id = typeof row === 'object' ? (row as { id: number }).id : (row as number);

    // Register cron triggers in BullMQ so they actually fire. Loaded
    // inline so the route doesn't pay the import cost when triggers are
    // empty (vast majority of pipelines today). Errors in the scheduler
    // shouldn't fail the create — log and continue.
    try {
      const { registerPipelineTriggers } = await import('../jobs/pipelineScheduler');
      await registerPipelineTriggers({
        id,
        tenant_id: tenantId,
        enabled: enabled ?? true,
        triggers: triggers ?? [],
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[pipelines POST /saved] registerPipelineTriggers failed', e);
    }

    res.json({ ok: true, data: { id, stableId: `custom:${id}` } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/pipelines/saved/:id — update name / description / scope / triggers
// ---------------------------------------------------------------------------
router.put('/saved/:id', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const body = req.body as {
      name?: string; description?: string | null;
      scope?: unknown; triggers?: unknown[]; enabled?: boolean;
    };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.description !== undefined) patch.description = body.description;
    if (body.scope !== undefined) patch.scope = JSON.stringify(body.scope);
    if (body.triggers !== undefined) patch.triggers = JSON.stringify(body.triggers);
    if (body.enabled !== undefined) patch.enabled = body.enabled;

    const updated = await semanticDb('pipelines')
      .where({ id, tenant_id: tenantId })
      .update(patch);
    if (!updated) return res.status(404).json({ ok: false, error: 'Pipeline not found' });

    // Re-register triggers whenever triggers OR enabled change. Reading
    // the row back ensures we use the merged state (enabled may have
    // come from this PATCH, triggers from a previous one).
    if (body.triggers !== undefined || body.enabled !== undefined) {
      try {
        const fresh = await semanticDb('pipelines')
          .where({ id, tenant_id: tenantId })
          .select('id', 'tenant_id', 'enabled', 'triggers')
          .first();
        if (fresh) {
          const { registerPipelineTriggers } = await import('../jobs/pipelineScheduler');
          await registerPipelineTriggers(fresh);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[pipelines PUT /saved] registerPipelineTriggers failed', e);
      }
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/pipelines/saved/:id
// ---------------------------------------------------------------------------
router.delete('/saved/:id', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
    const id = Number(req.params.id);
    const deleted = await semanticDb('pipelines').where({ id, tenant_id: tenantId }).delete();
    if (!deleted) return res.status(404).json({ ok: false, error: 'Pipeline not found' });

    // Drop any registered cron triggers so they don't keep firing for
    // a pipeline that no longer exists. Failure here is non-fatal —
    // the orphan triggers will eventually be removed by the next
    // boot's loadPipelineSchedules() (it wipes-and-replaces by id).
    try {
      const { unregisterPipelineTriggers } = await import('../jobs/pipelineScheduler');
      await unregisterPipelineTriggers(id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[pipelines DELETE /saved] unregisterPipelineTriggers failed', e);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/pipelines/run-pipeline — run a built-in or saved pipeline.
// Body: { pipelineId: 'builtin:all' | 'builtin:from-source:5' | 'custom:17'
//                  | { scope: PipelineScope } }
// Returns { jobId, pipelineRunId } so the frontend can attach via the
// existing /bus-matrix/:jobId/stream SSE.
// ---------------------------------------------------------------------------
router.post('/run-pipeline', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

    const { pipelineId, adhocScope } = req.body as {
      pipelineId?: string;
      adhocScope?: unknown; // for "Run with this scope, don't save"
    };

    let scope: unknown;
    let pipelineName: string | undefined;
    let savedPipelineId: number | null = null;

    const { listBuiltinPipelines, resolveScope } = await import('../services/pipelineService');

    if (typeof pipelineId === 'string' && pipelineId.startsWith('builtin:')) {
      const builtins = await listBuiltinPipelines(tenantId);
      const found = builtins.find((b) => b.id === pipelineId);
      if (!found) return res.status(404).json({ ok: false, error: 'Built-in pipeline not found' });
      scope = found.scope;
      pipelineName = found.name;
    } else if (typeof pipelineId === 'string' && pipelineId.startsWith('custom:')) {
      const id = Number(pipelineId.slice(7));
      const row = await semanticDb('pipelines')
        .where({ id, tenant_id: tenantId })
        .first();
      if (!row) return res.status(404).json({ ok: false, error: 'Custom pipeline not found' });
      scope = typeof row.scope === 'string' ? JSON.parse(row.scope) : row.scope;
      pipelineName = row.name;
      savedPipelineId = id;
    } else if (adhocScope) {
      scope = adhocScope;
      pipelineName = 'Ad-hoc run';
    } else {
      return res.status(400).json({ ok: false, error: 'pipelineId or adhocScope required' });
    }

    // Resolve scope into concrete sourceIds + productIds
    type PipelineScope = Parameters<typeof resolveScope>[0];
    const resolved = await resolveScope(scope as PipelineScope, tenantId);
    if (resolved.sourceIds.length === 0 && resolved.productIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'Pipeline scope is empty — nothing to run' });
    }

    // Create pipeline_runs row first so we have an id to thread through.
    const [runRow] = await semanticDb('pipeline_runs').insert({
      tenant_id: tenantId,
      pipeline_id: savedPipelineId,
      status: 'queued',
      triggered_by: req.user?.email ? `user:${req.user.email}` : 'manual',
    }).returning('id');
    const pipelineRunId = typeof runRow === 'object' ? (runRow as { id: number }).id : (runRow as number);

    const { getBusMatrixQueue } = await import('../jobs/queues');
    const queue = getBusMatrixQueue();
    if (!queue) {
      await semanticDb('pipeline_runs').where({ id: pipelineRunId }).update({
        status: 'failed', error_message: 'Job queue not available — Redis is not configured.',
      });
      return res.status(503).json({ ok: false, error: 'Job queue not available — Redis is not configured.' });
    }

    const job = await queue.add('pipeline-run', {
      // connectionId not used in pipeline mode but the JobData type requires it.
      connectionId: 0,
      tenantId,
      triggeredBy: req.user?.email ?? 'unknown',
      mode: 'pipeline' as const,
      pipelineScope: resolved,
      pipelineRunId,
      pipelineName,
    });

    await semanticDb('pipeline_runs').where({ id: pipelineRunId }).update({ job_id: String(job.id) });
    if (savedPipelineId) {
      await semanticDb('pipelines').where({ id: savedPipelineId }).update({
        last_run_at: new Date().toISOString(),
        last_status: 'queued',
      });
    }

    res.json({ ok: true, data: {
      jobId: job.id,
      pipelineRunId,
      resolved,
      pipelineName,
    } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/pipelines/runs?pipelineId=&limit= — recent runs (for history)
// ---------------------------------------------------------------------------
router.get('/runs', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const pipelineId = req.query.pipelineId;
    const q = semanticDb('pipeline_runs').where('tenant_id', tenantId);
    if (pipelineId !== undefined) {
      const id = Number(pipelineId);
      if (Number.isFinite(id)) q.andWhere('pipeline_id', id);
      else if (pipelineId === 'null') q.whereNull('pipeline_id');
    }
    const rows = await q.orderBy('id', 'desc').limit(limit);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

export default router;
