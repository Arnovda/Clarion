/**
 * Owner resolution for product_tables.
 *
 * When the same logical dim (e.g. `dim_article`) is referenced by multiple
 * data products, only one product owns the materialised parquet — the others
 * have a metadata row with `transformation_sql=null` and
 * `source_product_table_id` pointing at the owner.
 *
 * Read paths (status, last_run_at, profile, parquet location) must follow
 * the pointer so consumers see fresh data, not their own stale stub.
 */
import { tenantQuery } from './tenantQuery';

export interface ResolvedOwner {
  productTable: Record<string, unknown>;
  product: Record<string, unknown>;
  starSchema: Record<string, unknown>;
  connection: Record<string, unknown>;
  /** True if we followed at least one source_product_table_id link. */
  redirected: boolean;
}

/**
 * Follow `source_product_table_id` until we land on a row that owns its data
 * (or we hit a cycle / dangling pointer). Cycle guard caps depth at 8.
 */
export async function resolveOwnerProductTable(
  productTableId: number,
  tenantId?: number,
): Promise<ResolvedOwner | null> {
  return tenantQuery(tenantId, async (trx) => {
    let currentId = productTableId;
    let redirected = false;
    const seen = new Set<number>();

    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(currentId)) break;
      seen.add(currentId);

      const pt = await trx('product_tables').where({ id: currentId }).first();
      if (!pt) return null;

      const ownsData = !!pt.transformation_sql || !pt.source_product_table_id;
      if (ownsData || !pt.source_product_table_id) {
        const ss = await trx('star_schemas').where({ id: pt.star_schema_id }).first();
        if (!ss) return null;
        const dp = await trx('data_products').where({ id: ss.data_product_id }).first();
        if (!dp) return null;
        const conn = await trx('connections').where({ id: dp.connection_id }).first();
        if (!conn) return null;
        return { productTable: pt, product: dp, starSchema: ss, connection: conn, redirected };
      }

      currentId = Number(pt.source_product_table_id);
      redirected = true;
    }

    return null;
  });
}

/**
 * Topologically sort upstream product ids that the given product depends on,
 * transitively. Returns an array starting with the deepest upstream and
 * ending with direct dependencies — i.e. safe execution order before the
 * given product itself runs.
 */
export async function resolveUpstreamProductsTopo(
  productId: number,
  tenantId?: number,
): Promise<number[]> {
  return tenantQuery(tenantId, async (trx) => {
    // Collect every reachable upstream id via BFS
    const reachable = new Set<number>();
    const queue: number[] = [productId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const deps = await trx('data_product_dependencies')
        .where({ dependent_product_id: current })
        .select<{ source_product_id: number }[]>('source_product_id');
      for (const { source_product_id } of deps) {
        if (!reachable.has(source_product_id) && source_product_id !== productId) {
          reachable.add(source_product_id);
          queue.push(source_product_id);
        }
      }
    }

    if (reachable.size === 0) return [];

    // Build adjacency among reachable nodes only (edge: dependent -> source means
    // source must run before dependent). Kahn's algorithm with in-degree on
    // dependents.
    const ids = Array.from(reachable);
    const edges = await trx('data_product_dependencies')
      .whereIn('dependent_product_id', ids)
      .whereIn('source_product_id', ids)
      .select<{ dependent_product_id: number; source_product_id: number }[]>(
        'dependent_product_id', 'source_product_id',
      );

    const inDegree = new Map<number, number>(ids.map((id) => [id, 0]));
    const adj = new Map<number, number[]>(ids.map((id) => [id, []]));
    for (const e of edges) {
      // source must come before dependent
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

    // If a cycle prevented full ordering, append remaining ids in arbitrary
    // order — caller can still attempt to run them; cycles among data products
    // are a configuration bug we shouldn't silently swallow.
    for (const id of ids) {
      if (!order.includes(id)) order.push(id);
    }

    return order;
  });
}
