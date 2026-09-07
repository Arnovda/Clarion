/**
 * Query scope — WHICH data a question may reach.
 *
 * Until this file existed the answer was always "one connection". Every
 * warehouse surface took a bare `connectionId` and every catalog read
 * filtered on it (`tableCatalog.ts`'s `.where('dp.connection_id', …)`), so
 * a question that spanned two source systems was not merely unsupported —
 * it was INEXPRESSIBLE. That is the single line the coherence review named,
 * and it sat under the platform's headline promise: an SMB's business never
 * lives in one system, so "ask anything about your business" was true only
 * for customers with exactly one source.
 *
 * A scope is the unit of work now, and it is a VALUE, resolved once at the
 * request boundary and passed down. Three reasons it is a type rather than
 * an extra optional argument:
 *
 *   1. `tenantId` rides inside it. Every catalog read opens its own
 *      transaction on the root pool, so it does not inherit the caller's
 *      request-scoped tenant context; a forgotten tenant makes the RLS
 *      predicate `tenant_id = NULL` and the session registers ZERO views.
 *      That has already happened twice in this codebase (D2 of the
 *      coherence review). Inside the scope it cannot be forgotten.
 *   2. Cross-source is a property of the SCOPE, not of a call site, so
 *      every surface reasons about it the same way.
 *   3. It gives the collision rule somewhere to live — see
 *      `tableCatalog.registerableTables`, which is what stops two sources'
 *      `dim_customer` from silently resolving to whichever came first.
 *
 * DEFAULT BEHAVIOUR IS DELIBERATELY UNCHANGED. A scope over one connection
 * produces exactly the session and context it did before: same schema names,
 * same bare table names, same DuckDB pool key. Cross-source widens the scope
 * only when a caller asks for it. That matters because the failure mode of
 * getting this wrong is not an error — it is a plausible number computed
 * from the wrong source, which nobody catches by eye.
 */

import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';

export interface QueryScope {
  /**
   * REQUIRED in practice — typed optional only because a handful of legacy
   * internal callers (schedulers, the morning brief) run without a request.
   * Passing `undefined` means "no tenant context", which under the production
   * RLS role reads nothing at all. Prefer a real id everywhere.
   */
  tenantId: number | undefined;
  /** One or more connections whose product layer is in scope. Never empty. */
  connectionIds: number[];
  /** Optional narrowing to specific data products WITHIN those connections. */
  productIds?: number[];
}

/** The ordinary single-source scope. Behaviour-identical to the old API. */
export function scopeOf(tenantId: number | undefined, connectionId: number, productIds?: number[]): QueryScope {
  return { tenantId, connectionIds: [connectionId], productIds };
}

/** True when a scope reaches more than one source system. */
export function isCrossSource(scope: QueryScope): boolean {
  return scope.connectionIds.length > 1;
}

/**
 * The connection a single-source scope is about.
 *
 * Exists because several surfaces still legitimately need "the" connection —
 * a warehouse root path, a cache key, a saved dashboard's home. Returns null
 * for a cross-source scope rather than silently picking the first, because
 * picking one is how a cross-source dashboard would quietly become a
 * single-source one.
 */
export function soleConnectionId(scope: QueryScope): number | null {
  return scope.connectionIds.length === 1 ? scope.connectionIds[0] : null;
}

/**
 * Every connection in the tenant that could contribute to an answer.
 *
 * "Could contribute" is deliberately narrow: a connection with no
 * successfully materialised product table adds nothing to a product-layer
 * question but would add its name to the prompt and its id to the pool key,
 * making every session key unique per half-configured source. So the filter
 * is on real output, not on the connection row existing.
 */
export async function listAnswerableConnectionIds(
  tenantId: number | undefined,
  trx?: Knex | Knex.Transaction,
): Promise<number[]> {
  const run = async (db: Knex | Knex.Transaction) => {
    const rows = await db('data_products as dp')
      .join('star_schemas as ss', 'ss.data_product_id', 'dp.id')
      .join('product_tables as pt', 'pt.star_schema_id', 'ss.id')
      .where('pt.transformation_status', 'success')
      .whereNotNull('pt.delta_path')
      .whereIn('dp.status', ['approved', 'success'])
      .modify((q) => {
        // Explicit tenant filter beside RLS: `reqDb` can fall back to a pool
        // whose session-level tenant var races. House rule — an authorisation
        // decision never rides the session variable alone.
        if (tenantId != null) q.where('dp.tenant_id', tenantId);
      })
      .distinct('dp.connection_id as connection_id');
    return rows
      .map((r: { connection_id: number | null }) => r.connection_id)
      .filter((id: number | null): id is number => id != null);
  };

  if (trx) return run(trx);
  return tenantQuery(tenantId, run);
}

/**
 * Resolve what a request asked for into a concrete scope.
 *
 * The rules, in order:
 *   • an explicit `connectionIds` list wins (a saved dashboard replaying its
 *     own stored scope, or a caller that already knows);
 *   • `crossSource: true` widens to every answerable connection in the
 *     tenant, with the requested connection guaranteed to be in it — a
 *     tenant with one source therefore behaves exactly as before, which is
 *     what makes turning this on safe for existing customers;
 *   • otherwise it is the single requested connection.
 *
 * A widened scope that resolves to nothing falls back to the requested
 * connection rather than returning empty: an empty scope registers no views,
 * and "your question reached no data" is a worse answer than the
 * single-source one the user used to get.
 */
export async function resolveScope(
  input: {
    tenantId: number | undefined;
    connectionId: number;
    connectionIds?: number[];
    productIds?: number[];
    crossSource?: boolean;
  },
  trx?: Knex | Knex.Transaction,
): Promise<QueryScope> {
  const { tenantId, connectionId, connectionIds, productIds, crossSource } = input;

  if (connectionIds && connectionIds.length > 0) {
    const unique = [...new Set(connectionIds)];
    return { tenantId, connectionIds: unique, productIds };
  }

  if (!crossSource) return scopeOf(tenantId, connectionId, productIds);

  const answerable = await listAnswerableConnectionIds(tenantId, trx ?? semanticDb);
  const widened = [...new Set([connectionId, ...answerable])];
  return { tenantId, connectionIds: widened, productIds };
}
