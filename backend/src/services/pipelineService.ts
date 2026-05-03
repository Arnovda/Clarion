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
 *   • topoSortProducts(productIds)    — Kahn's, used by the runner
 */

import { semanticDb } from '../db/knex';
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
  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  const conns = await semanticDb('connections')
    .where('tenant_id', tenantId)
    .select('id', 'name', 'type', 'connector_type', 'last_synced_at', 'last_sync_status')
    .orderBy('name');

  const products = await semanticDb('data_products')
    .select('id', 'name', 'status', 'connection_id', 'updated_at')
    .orderBy('name');

  // Source→product edges: each product points at every distinct
  // connection it consumes source tables from.
  const dpsRows = products.length
    ? await semanticDb('data_product_sources as dps')
        .join('source_tables as st', 'st.id', 'dps.source_table_id')
        .whereIn('dps.data_product_id', products.map((p: { id: number }) => p.id))
        .select<{ data_product_id: number; connection_id: number }[]>(
          'dps.data_product_id', 'st.connection_id',
        )
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
    ? await semanticDb('data_product_dependencies')
        .whereIn('dependent_product_id', products.map((p: { id: number }) => p.id))
        .select<{ dependent_product_id: number; source_product_id: number }[]>(
          'dependent_product_id', 'source_product_id',
        )
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
  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  const allSources = (await semanticDb('connections')
    .where('tenant_id', tenantId)
    .select<{ id: number }[]>('id')).map((r) => r.id);
  const allProducts = (await semanticDb('data_products')
    .select<{ id: number }[]>('id')).map((r) => r.id);

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
      const directIds = await productsConsumingSource(scope.sourceId);
      const allDownstream = await expandDownstreamProducts(directIds);
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
        ? await expandDownstreamProducts([scope.productId])
        : [];
      const finalProducts = [...new Set([...productIds, ...downstream])];
      // Source ids = the connections feeding any product in scope
      const sourceIds = scope.includeUpstreamSync !== false
        ? await sourcesForProducts(finalProducts)
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
      const productIds = new Set<number>(scope.productIds);
      if (scope.includeUpstream) {
        for (const pid of scope.productIds) {
          const ups = await resolveUpstreamProductsTopo(pid, tenantId);
          for (const u of ups) productIds.add(u);
        }
      }
      if (scope.includeDownstream) {
        const downs = await expandDownstreamProducts(scope.productIds);
        for (const d of downs) productIds.add(d);
      }
      return {
        sourceIds: scope.sourceIds.filter((id) => allSources.includes(id)),
        productIds: Array.from(productIds).filter((id) => allProducts.includes(id)),
        shouldSyncSources: !scope.skipSourceSync && scope.sourceIds.length > 0,
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

async function productsConsumingSource(sourceId: number): Promise<number[]> {
  // Direct: any product whose data_product_sources reference a source_table
  // belonging to this connection.
  const direct = await semanticDb('data_product_sources as dps')
    .join('source_tables as st', 'st.id', 'dps.source_table_id')
    .where('st.connection_id', sourceId)
    .distinct('dps.data_product_id')
    .select<{ data_product_id: number }[]>('dps.data_product_id');
  // Plus legacy products pinned by `data_products.connection_id` even if
  // they have no data_product_sources rows yet.
  const pinned = await semanticDb('data_products')
    .where({ connection_id: sourceId })
    .select<{ id: number }[]>('id');
  const set = new Set<number>([
    ...direct.map((r) => r.data_product_id),
    ...pinned.map((r) => r.id),
  ]);
  return Array.from(set);
}

async function expandDownstreamProducts(seeds: number[]): Promise<number[]> {
  if (seeds.length === 0) return [];
  const all = new Set<number>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const next = queue.shift()!;
    const children = await semanticDb('data_product_dependencies')
      .where('source_product_id', next)
      .select<{ dependent_product_id: number }[]>('dependent_product_id');
    for (const c of children) {
      if (!all.has(c.dependent_product_id)) {
        all.add(c.dependent_product_id);
        queue.push(c.dependent_product_id);
      }
    }
  }
  return Array.from(all);
}

async function sourcesForProducts(productIds: number[]): Promise<number[]> {
  if (productIds.length === 0) return [];
  const rows = await semanticDb('data_product_sources as dps')
    .join('source_tables as st', 'st.id', 'dps.source_table_id')
    .whereIn('dps.data_product_id', productIds)
    .distinct('st.connection_id')
    .select<{ connection_id: number }[]>('st.connection_id');
  const fromSources = rows.map((r) => r.connection_id).filter((id): id is number => !!id);
  // Fallback to data_products.connection_id for products with no rows.
  const pinned = await semanticDb('data_products')
    .whereIn('id', productIds)
    .whereNotNull('connection_id')
    .distinct('connection_id')
    .select<{ connection_id: number }[]>('connection_id');
  return Array.from(new Set([...fromSources, ...pinned.map((r) => r.connection_id)]));
}

// ── Topo sort (used by the runner) ─────────────────────────────────────

/**
 * Topo-sort a set of product ids using `data_product_dependencies` edges.
 * Products with no upstream in the set come first; descendants follow.
 * Cycle-safe — products in a cycle still get returned (deterministic order).
 */
export async function topoSortProducts(productIds: number[]): Promise<number[]> {
  if (productIds.length === 0) return [];
  const idSet = new Set(productIds);
  const edges = await semanticDb('data_product_dependencies')
    .whereIn('dependent_product_id', productIds)
    .whereIn('source_product_id', productIds)
    .select<{ dependent_product_id: number; source_product_id: number }[]>(
      'dependent_product_id', 'source_product_id',
    );

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
  const out: BuiltinPipeline[] = [];

  // Global
  out.push({
    id: 'builtin:all',
    name: 'Refresh everything',
    description: 'Sync every source, then transform every product in dependency order.',
    group: 'global',
    scope: { type: 'all' },
    sourceCount: dag.sources.length,
    productCount: dag.products.length,
  });
  out.push({
    id: 'builtin:sync-all',
    name: 'Sync sources only',
    description: 'Pull the latest data from every source. No transformations.',
    group: 'global',
    scope: { type: 'sync-all' },
    sourceCount: dag.sources.length,
    productCount: 0,
  });
  out.push({
    id: 'builtin:transform-all',
    name: 'Transform products only',
    description: 'Re-run every product on whatever source data is already in the warehouse.',
    group: 'global',
    scope: { type: 'transform-all' },
    sourceCount: 0,
    productCount: dag.products.length,
  });

  // Per-source
  for (const s of dag.sources) {
    const downstreamCount = dag.edges.filter(
      (e) => e.source.kind === 'connection' && e.source.id === s.id,
    ).length;
    out.push({
      id: `builtin:from-source:${s.id}`,
      name: `Refresh from ${s.name}`,
      description: `Sync ${s.name} and re-run every product that depends on it.`,
      group: 'source',
      scope: { type: 'from-source', sourceId: s.id },
      sourceCount: 1,
      productCount: downstreamCount,
    });
    out.push({
      id: `builtin:sync-source:${s.id}`,
      name: `Sync ${s.name} only`,
      description: `Just pull the latest from ${s.name}. No products transformed.`,
      group: 'source',
      scope: { type: 'sync-source', sourceId: s.id },
      sourceCount: 1,
      productCount: 0,
    });
  }

  // Per-product
  for (const p of dag.products) {
    out.push({
      id: `builtin:product:${p.id}`,
      name: `Refresh ${p.name}`,
      description: `Sync upstream sources and re-run ${p.name}'s transformations.`,
      group: 'product',
      scope: { type: 'product', productId: p.id, includeUpstreamSync: true, includeDownstream: false },
      sourceCount: 0, // computed at run-time
      productCount: 1,
    });
    out.push({
      id: `builtin:rebuild-product:${p.id}`,
      name: `Rebuild ${p.name} (transformations only)`,
      description: `Re-run ${p.name} on existing source data. No sync.`,
      group: 'product',
      scope: { type: 'rebuild-product', productId: p.id },
      sourceCount: 0,
      productCount: 1,
    });
  }

  return out;
}
