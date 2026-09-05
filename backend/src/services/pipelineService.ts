/**
 * Pipeline scope resolver + DAG builder.
 *
 * One concept threaded through everything that follows:
 *   A pipeline names a SCOPE on the (sources → products → products)
 *   dependency graph plus a list of TRIGGERS. The runner executes the
 *   slice in topological order — sources first (sync), then products
 *   (transform), respecting product↔product dependencies.
 *
 * This module exposes:
 *   • getDag(tenantId)                — full graph for the canvas
 *   • resolveScope(scope, tenantId)   — turn a scope JSON into concrete
 *                                       { sourceIds[], productIds[] }
 *   • listBuiltinPipelines(tenantId)  — auto-derived from the graph
 *   • topoSortProducts(productIds, tenantId) — Kahn's, used by the runner
 */

import { tenantQuery } from './tenantQuery';
import { resolveUpstreamProductsTopo } from './productOwnership';

// ── Scope shapes (mirror the migration's JSON discriminator) ───────────

export type PipelineScope =
  | { type: 'all' }
  | { type: 'sync-all' }
  | { type: 'transform-all' }
  | { type: 'from-source'; sourceId: number }
  | { type: 'sync-source'; sourceId: number }
  | { type: 'product'; productId: number; includeUpstreamSync?: boolean; includeDownstream?: boolean }
  | { type: 'rebuild-product'; productId: number }
  | {
      type: 'custom';
      sourceIds: number[];
      productIds: number[];
      includeUpstream?: boolean;
      includeDownstream?: boolean;
      skipSourceSync?: boolean;
    };

export interface ResolvedScope {
  sourceIds: number[];
  productIds: number[];
  /**
   * Whether the runner should sync sources before transforming products.
   * For 'transform-all' / 'rebuild-product' / custom-with-skipSourceSync
   * this is false. Otherwise true (when sourceIds is non-empty).
   */
  shouldSyncSources: boolean;
}

// ── Trigger shapes ─────────────────────────────────────────────────────

export type PipelineTrigger =
  | { kind: 'cron'; cron: string; tz?: string }
  | { kind: 'on_pipeline_complete'; pipelineId: number }
  | { kind: 'on_source_sync_succeeded'; sourceId: number };

// ── DAG ────────────────────────────────────────────────────────────────

export interface DagSource {
  id: number;
  name: string;
  type: string;             // 'sqlite' | 'postgres' | 'duckdb' | …
  connectorType: string | null; // 'exactonline' | …
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
}

export interface DagProduct {
  id: number;
  name: string;
  status: string;
  lastRunAt: string | null;
  connectionId: number | null;
}

export interface DagEdge {
  source: { kind: 'connection' | 'product'; id: number };
  target: { kind: 'product'; id: number };
}

export interface PipelineDag {
  sources: DagSource[];
  products: DagProduct[];
  edges: DagEdge[];
}

/**
 * Build the full tenant DAG: sources + products + edges.
 *   • source → product edges come from `data_product_sources` (join via
 *     source_tables.connection_id), so a product appears downstream of
 *     EVERY connection it consumes from. Cross-source products get
 *     multiple incoming edges automatically.
 *   • product → product edges come from `data_product_dependencies`.
 */
export async function getDag(tenantId: number): Promise<PipelineDag> {

  const conns = await tenantQuery(tenantId, (db) => db('connections')
    .where('tenant_id', tenantId)
    .select('id', 'name', 'type', 'connector_type', 'last_synced_at', 'last_sync_status')
    .orderBy('name'));

  const products = await tenantQuery(tenantId, (db) => db('data_products')
    .select('id', 'name', 'status', 'connection_id', 'updated_at')
    .orderBy('name'));

  // Source→product edges: each product points at every distinct
  // connection it consumes source tables from.
  const dpsRows = products.length
    ? await tenantQuery(tenantId, (db) => db('data_product_sources as dps')
        .join('source_tables as st', 'st.id', 'dps.source_table_id')
        .whereIn('dps.data_product_id', products.map((p: { id: number }) => p.id))
        .select<{ data_product_id: number; connection_id: number }[]>(
          'dps.data_product_id', 'st.connection_id',
        ))
    : [];

  const seenSrcEdge = new Set<string>();
  const sourceProductEdges: DagEdge[] = [];
  for (const r of dpsRows) {
    if (!r.connection_id) continue;
    const k = `c:${r.connection_id}->p:${r.data_product_id}`;
    if (seenSrcEdge.has(k)) continue;
    seenSrcEdge.add(k);
    sourceProductEdges.push({
      source: { kind: 'connection', id: r.connection_id },
      target: { kind: 'product', id: r.data_product_id },
    });
  }
  // Fallback: products with no data_product_sources rows but with
  // connection_id set (legacy / new products) — surface that edge anyway.
  for (const p of products as Array<{ id: number; connection_id: number | null }>) {
    if (!p.connection_id) continue;
    const k = `c:${p.connection_id}->p:${p.id}`;
    if (!seenSrcEdge.has(k)) {
      seenSrcEdge.add(k);
      sourceProductEdges.push({
        source: { kind: 'connection', id: p.connection_id },
        target: { kind: 'product', id: p.id },
      });
    }
  }

  // Product↔product edges (shared dim consumption).
  const depRows = products.length
    ? await tenantQuery(tenantId, (db) => db('data_product_dependencies')
        .whereIn('dependent_product_id', products.map((p: { id: number }) => p.id))
        .select<{ dependent_product_id: number; source_product_id: number }[]>(
          'dependent_product_id', 'source_product_id',
        ))
    : [];
  const productEdges: DagEdge[] = depRows.map((r) => ({
    source: { kind: 'product', id: r.source_product_id },
    target: { kind: 'product', id: r.dependent_product_id },
  }));

  return {
    sources: (conns as Array<{
      id: number; name: string; type: string;
      connector_type: string | null;
      last_synced_at: Date | string | null; last_sync_status: string | null;
    }>).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      connectorType: c.connector_type,
      lastSyncedAt: c.last_synced_at ? String(c.last_synced_at) : null,
      lastSyncStatus: c.last_sync_status,
    })),
    products: (products as Array<{
      id: number; name: string; status: string;
      connection_id: number | null; updated_at: Date | string | null;
    }>).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      lastRunAt: p.updated_at ? String(p.updated_at) : null,
      connectionId: p.connection_id,
    })),
    edges: [...sourceProductEdges, ...productEdges],
  };
}

// ── Scope resolution ───────────────────────────────────────────────────

/**
 * Turn a pipeline's scope JSON into the concrete set of source + product
 * ids the runner needs to execute. Always honours dependencies: a custom
 * scope including a fact product but not its dimension product gets the
 * dimension added automatically (unless includeUpstream is explicitly false
 * AND skipSourceSync is true — at which point you've told us you know
 * what you're doing).
 */
export async function resolveScope(scope: PipelineScope, tenantId: number): Promise<ResolvedScope> {

  const allSources = (await tenantQuery(tenantId, (db) => db('connections')
    .where('tenant_id', tenantId)
    .select<{ id: number }[]>('id'))).map((r) => r.id);
  const allProducts = (await tenantQuery(tenantId, (db) => db('data_products')
    .select<{ id: number }[]>('id'))).map((r) => r.id);

  switch (scope.type) {
    case 'all':
      return { sourceIds: allSources, productIds: allProducts, shouldSyncSources: true };

    case 'sync-all':
      return { sourceIds: allSources, productIds: [], shouldSyncSources: true };

    case 'transform-all':
      return { sourceIds: [], productIds: allProducts, shouldSyncSources: false };

    case 'sync-source':
      return { sourceIds: [scope.sourceId], productIds: [], shouldSyncSources: true };

    case 'from-source': {
      // Sync this source + transform every product that consumes from it
      // (directly via data_product_sources OR indirectly via product
      // dependency chain).
      const directIds = await productsConsumingSource(scope.sourceId, tenantId);
      const allDownstream = await expandDownstreamProducts(directIds, tenantId);
      return {
        sourceIds: [scope.sourceId],
        productIds: allDownstream,
        shouldSyncSources: true,
      };
    }

    case 'product': {
      const upstream = scope.includeUpstreamSync !== false
        ? await resolveUpstreamProductsTopo(scope.productId, tenantId)
        : [];
      const productIds = [...new Set([...upstream, scope.productId])];
      const downstream = scope.includeDownstream
        ? await expandDownstreamProducts([scope.productId], tenantId)
        : [];
      const finalProducts = [...new Set([...productIds, ...downstream])];
      // Source ids = the connections feeding any product in scope
      const sourceIds = scope.includeUpstreamSync !== false
        ? await sourcesForProducts(finalProducts, tenantId)
        : [];
      return { sourceIds, productIds: finalProducts, shouldSyncSources: sourceIds.length > 0 };
    }

    case 'rebuild-product':
      return {
        sourceIds: [],
        productIds: [scope.productId],
        shouldSyncSources: false,
      };

    case 'custom': {
      // Implicit policy for custom scopes:
      //   • Upstream is ALWAYS pulled in. Refreshing a fact without its
      //     dim or its source is meaningless — we'd ship stale data.
      //   • Source sync ALWAYS runs for any source touched by an
      //     in-scope product. Optional flags from the stored scope are
      //     ignored at resolve time.
      //   • Downstream is opt-in (skipDownstream not implemented yet —
      //     kept as future hook).
      const productIds = new Set<number>(scope.productIds);
      // Always pull upstream products
      for (const pid of scope.productIds) {
        const ups = await resolveUpstreamProductsTopo(pid, tenantId);
        for (const u of ups) productIds.add(u);
      }
      if (scope.includeDownstream) {
        const downs = await expandDownstreamProducts(scope.productIds, tenantId);
        for (const d of downs) productIds.add(d);
      }
      // Always include sources that feed any product in scope, in addition
      // to whatever the user explicitly picked.
      const expandedProducts = Array.from(productIds);
      const autoSources = await sourcesForProducts(expandedProducts, tenantId);
      const sourceSet = new Set<number>([...scope.sourceIds, ...autoSources]);
      return {
        sourceIds: Array.from(sourceSet).filter((id) => allSources.includes(id)),
        productIds: expandedProducts.filter((id) => allProducts.includes(id)),
        shouldSyncSources: true, // implicit — always sync upstream
      };
    }

    default: {
      // exhaustiveness check
      const _x: never = scope;
      void _x;
      throw new Error('Unknown pipeline scope type');
    }
  }
}

async function productsConsumingSource(sourceId: number, tenantId: number): Promise<number[]> {
  // Direct: any product whose data_product_sources reference a source_table
  // belonging to this connection.
  const direct = await tenantQuery(tenantId, (db) => db('data_product_sources as dps')
    .join('source_tables as st', 'st.id', 'dps.source_table_id')
    .where('st.connection_id', sourceId)
    .distinct('dps.data_product_id')
    .select<{ data_product_id: number }[]>('dps.data_product_id'));
  // Plus legacy products pinned by `data_products.connection_id` even if
  // they have no data_product_sources rows yet.
  const pinned = await tenantQuery(tenantId, (db) => db('data_products')
    .where({ connection_id: sourceId })
    .select<{ id: number }[]>('id'));
  const set = new Set<number>([
    ...direct.map((r) => r.data_product_id),
    ...pinned.map((r) => r.id),
  ]);
  return Array.from(set);
}

async function expandDownstreamProducts(seeds: number[], tenantId: number): Promise<number[]> {
  if (seeds.length === 0) return [];
  const all = new Set<number>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const next = queue.shift()!;
    const children = await tenantQuery(tenantId, (db) => db('data_product_dependencies')
      .where('source_product_id', next)
      .select<{ dependent_product_id: number }[]>('dependent_product_id'));
    for (const c of children) {
      if (!all.has(c.dependent_product_id)) {
        all.add(c.dependent_product_id);
        queue.push(c.dependent_product_id);
      }
    }
  }
  return Array.from(all);
}

async function sourcesForProducts(productIds: number[], tenantId: number): Promise<number[]> {
  if (productIds.length === 0) return [];
  const rows = await tenantQuery(tenantId, (db) => db('data_product_sources as dps')
    .join('source_tables as st', 'st.id', 'dps.source_table_id')
    .whereIn('dps.data_product_id', productIds)
    .distinct('st.connection_id')
    .select<{ connection_id: number }[]>('st.connection_id'));
  const fromSources = rows.map((r) => r.connection_id).filter((id): id is number => !!id);
  // Fallback to data_products.connection_id for products with no rows.
  const pinned = await tenantQuery(tenantId, (db) => db('data_products')
    .whereIn('id', productIds)
    .whereNotNull('connection_id')
    .distinct('connection_id')
    .select<{ connection_id: number }[]>('connection_id'));
  return Array.from(new Set([...fromSources, ...pinned.map((r) => r.connection_id)]));
}

// ── Topo sort (used by the runner) ─────────────────────────────────────

/**
 * Topo-sort a set of product ids using `data_product_dependencies` edges.
 * Products with no upstream in the set come first; descendants follow.
 * Cycle-safe — products in a cycle still get returned (deterministic order).
 */
export async function topoSortProducts(productIds: number[], tenantId: number): Promise<number[]> {
  if (productIds.length === 0) return [];
  const idSet = new Set(productIds);
  const edges = await tenantQuery(tenantId, (db) => db('data_product_dependencies')
    .whereIn('dependent_product_id', productIds)
    .whereIn('source_product_id', productIds)
    .select<{ dependent_product_id: number; source_product_id: number }[]>(
      'dependent_product_id', 'source_product_id',
    ));

  const inDeg = new Map<number, number>(productIds.map((id) => [id, 0]));
  const adj = new Map<number, number[]>(productIds.map((id) => [id, []]));
  for (const e of edges) {
    adj.get(e.source_product_id)!.push(e.dependent_product_id);
    inDeg.set(e.dependent_product_id, (inDeg.get(e.dependent_product_id) ?? 0) + 1);
  }

  const ready = productIds.filter((id) => (inDeg.get(id) ?? 0) === 0).sort((a, b) => a - b);
  const out: number[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    out.push(next);
    for (const child of adj.get(next) ?? []) {
      const d = (inDeg.get(child) ?? 0) - 1;
      inDeg.set(child, d);
      if (d === 0 && idSet.has(child)) ready.push(child);
    }
    ready.sort((a, b) => a - b);
  }
  // Append any leftover (cycle) deterministically.
  for (const id of productIds) if (!out.includes(id)) out.push(id);
  return out;
}

// ── Built-in pipelines (computed, not stored) ──────────────────────────

export interface BuiltinPipeline {
  /** Synthetic id like 'builtin:all' / 'builtin:from-source:5'. */
  id: string;
  name: string;
  description: string;
  group: 'global' | 'source' | 'product';
  scope: PipelineScope;
  /** Concrete counts for the list UI. */
  sourceCount: number;
  productCount: number;
}

export async function listBuiltinPipelines(tenantId: number): Promise<BuiltinPipeline[]> {
  const dag = await getDag(tenantId);
  // Single built-in: "Refresh everything". Everything else is a custom
  // pipeline — users carve out their own scopes by clicking nodes on the
  // canvas. The earlier per-source / per-product / sync-only / transform-only
  // built-ins added decision fatigue without much value: when 90 % of the
  // time the choice is "refresh this and everything that needs to be fresh
  // for it", a single built-in plus a quick custom-pipeline flow covers it.
  return [{
    id: 'builtin:all',
    name: 'Refresh everything',
    description: 'Sync every source, then transform every product in dependency order.',
    group: 'global',
    scope: { type: 'all' },
    sourceCount: dag.sources.length,
    productCount: dag.products.length,
  }];
}

// ── Shared "enqueue a pipeline run" helper ─────────────────────────────
//
// Three call sites need to enqueue a pipeline run with identical
// semantics: the manual /run-pipeline endpoint, the cron-fired worker
// (pipeline-schedule queue), and the on-source-sync hook in
// SyncOrchestrator. Without this helper each path was at risk of drifting
// — e.g. one creates pipeline_runs but another forgets, one resolves
// scope but another doesn't. Single function, called everywhere.
//
// Returns null when the pipeline can't be enqueued (Redis missing,
// pipeline disabled, scope empty). Caller decides whether to treat as
// error or silent skip — manual run = error, automated trigger = skip.

export interface EnqueuePipelineResult {
  jobId: string | number | null;
  pipelineRunId: number;
  resolved: ResolvedScope;
  pipelineName: string;
}

export async function enqueueSavedPipelineRun(opts: {
  pipelineId: number;
  tenantId: number;
  /** Free-form attribution string for pipeline_runs.triggered_by, e.g.
   *  'user:alice@x.com' / 'cron' / 'on-source-sync:42' */
  triggeredBy: string;
}): Promise<EnqueuePipelineResult | null> {

  const row = await tenantQuery(opts.tenantId, (db) => db('pipelines')
    .where({ id: opts.pipelineId, tenant_id: opts.tenantId })
    .first());
  if (!row) return null;
  if (!row.enabled) return null; // disabled pipelines never auto-fire

  const scope = (typeof row.scope === 'string' ? JSON.parse(row.scope) : row.scope) as PipelineScope;
  const resolved = await resolveScope(scope, opts.tenantId);
  if (resolved.sourceIds.length === 0 && resolved.productIds.length === 0) return null;

  // Persist the run row first so the bus-matrix worker can update its
  // status as it progresses.
  const [runRow] = await tenantQuery(opts.tenantId, (db) => db('pipeline_runs').insert({
    tenant_id: opts.tenantId,
    pipeline_id: opts.pipelineId,
    status: 'queued',
    triggered_by: opts.triggeredBy,
  }).returning('id'));
  const pipelineRunId = typeof runRow === 'object' ? (runRow as { id: number }).id : (runRow as number);

  // Lazy-import to avoid a cycle between services and jobs.
  const { getBusMatrixQueue } = await import('../jobs/queues');
  const queue = getBusMatrixQueue();
  if (!queue) {
    await tenantQuery(opts.tenantId, (db) => db('pipeline_runs').where({ id: pipelineRunId }).update({
      status: 'failed',
      error_message: 'Job queue not available — Redis is not configured.',
    }));
    return null;
  }

  const job = await queue.add('pipeline-run', {
    connectionId: 0, // unused in pipeline mode but JobData requires it
    tenantId: opts.tenantId,
    triggeredBy: opts.triggeredBy,
    mode: 'pipeline' as const,
    pipelineScope: resolved,
    pipelineRunId,
    pipelineName: row.name,
  });

  await tenantQuery(opts.tenantId, (db) => db('pipeline_runs').where({ id: pipelineRunId }).update({ job_id: String(job.id) }));
  await tenantQuery(opts.tenantId, (db) => db('pipelines').where({ id: opts.pipelineId }).update({
    last_run_at: new Date().toISOString(),
    last_status: 'queued',
  }));

  return {
    jobId: job.id ?? null,
    pipelineRunId,
    resolved,
    pipelineName: row.name,
  };
}
