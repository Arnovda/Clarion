/**
 * Ownership gate for the Neo4j-backed semantic layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Neo4j has no tenant scoping. Every node and edge in `db/semanticGraph.ts` is
 * matched by its globally-unique `pgId` (or by `connectionId`) with no tenant
 * predicate anywhere — e.g. `MATCH (t:SourceTable {pgId: $pgId})`. Postgres RLS
 * therefore protects the mirror rows but NOT the graph, so any route that takes
 * an id from the request and hands it to a `graph.*` call reaches whichever
 * tenant owns that id. Ids come from a shared sequence, so they are trivially
 * enumerable.
 *
 * Postgres is the ownership oracle: every semantic entity has a mirror row
 * carrying `tenant_id` (migration 20260403000020). These helpers check that row
 * BEFORE the graph is touched.
 *
 * WHY tenant_id IS MATCHED EXPLICITLY, not left to RLS
 * ---------------------------------------------------
 * `reqDb(req)` returns the request-scoped transaction when one exists, and falls
 * back to the global pool — where `SET app.current_tenant` is session-level and
 * has a documented connection-pool race. An authorisation check must not depend
 * on which side of that race it lands, so the tenant is part of the WHERE clause.
 * RLS then acts as a second, independent layer rather than the only one.
 *
 * CALLERS MUST TREAT `false` AS 404, NEVER 403
 * -------------------------------------------
 * A 403 would confirm that the id exists and belongs to someone else, which is
 * itself a cross-tenant disclosure. "Not found" is the honest answer: within the
 * caller's tenant, it does not exist.
 */

import type { Knex } from 'knex';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'tenant-ownership' });

/**
 * Tables that mirror a semantic graph entity and carry `tenant_id`.
 * A union rather than `string` so a typo can't silently produce a query that
 * matches nothing (which would fail closed, but as a mystery 404).
 */
export type OwnedTable =
  | 'connections'
  | 'source_tables'
  | 'source_columns'
  | 'table_relationships'
  | 'kpi_definitions'
  | 'data_products'
  | 'star_schemas'
  | 'product_tables'
  | 'product_columns'
  | 'cross_source_views';

type Db = Knex | Knex.Transaction;

/**
 * Does `id` in `table` belong to `tenantId`?
 *
 * Returns false for a missing tenant, a non-numeric id, or a row owned by
 * someone else — the caller cannot tell those apart, which is the point.
 */
export async function owns(
  db: Db,
  table: OwnedTable,
  id: unknown,
  tenantId: number | undefined,
): Promise<boolean> {
  const numericId = Number(id);
  if (!tenantId || !Number.isInteger(numericId) || numericId <= 0) {
    log.warn({ table, id, tenantId }, 'ownership check refused: missing tenant or malformed id');
    return false;
  }
  const row = await db(table).where({ id: numericId, tenant_id: tenantId }).first('id');
  if (!row) {
    // Every refusal is logged, because this gate sits in front of ~30 endpoints
    // and a false refusal is indistinguishable from "not found" to the user. A
    // burst of these after a deploy means the gate is rejecting legitimate
    // traffic (e.g. a graph entity whose Postgres mirror row is missing), not
    // that someone is probing another tenant.
    log.warn({ table, id: numericId, tenantId }, 'ownership check refused: no such row for this tenant');
  }
  return !!row;
}

/**
 * Narrow a list of ids to the ones `tenantId` owns.
 *
 * For endpoints that fan out over graph data which is not scoped at all (the
 * product tree returns every tenant's products): fetch, then keep only what the
 * caller owns. Returns an empty set for an empty input without querying.
 */
export async function ownedIds(
  db: Db,
  table: OwnedTable,
  ids: readonly unknown[],
  tenantId: number | undefined,
): Promise<Set<number>> {
  if (!tenantId) return new Set();
  const numeric = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!numeric.length) return new Set();
  const rows = await db(table)
    .whereIn('id', numeric)
    .andWhere({ tenant_id: tenantId })
    .select('id');
  return new Set(rows.map((r: { id: number }) => Number(r.id)));
}
