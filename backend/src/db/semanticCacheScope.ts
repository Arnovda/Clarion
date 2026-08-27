/**
 * Resolve the connection a semantic entity belongs to, so cache invalidation can
 * be scoped to that connection instead of wiping the whole keyspace.
 *
 * WHY
 * ---
 * `invalidateSemanticCache()` with no argument runs `cacheInvalidate('semantic:*')`,
 * which is a Redis `SCAN` over every key plus a `DEL` of everything it finds. Each
 * of the semantic write routes called it that way, so ANY tenant editing ANY
 * definition dropped the cached AI context of EVERY tenant. At a handful of
 * tenants that is invisible; at hundreds it means the context cache is
 * permanently cold and every edit costs an O(keyspace) scan.
 *
 * Scoping needs a connection id, and only two of the six entity types have one on
 * the row — hence this module. `table_relationships` has no `connection_id`
 * column at all, and the product side is three joins away.
 *
 * FAIL-SAFE
 * ---------
 * Returning null means "I could not determine the scope", and callers must then
 * fall back to the global invalidation. Under-invalidating would serve stale
 * semantic context for up to the cache TTL, which is a correctness bug; a
 * needless global wipe is merely slow. When in doubt, be slow.
 */

import type { Knex } from 'knex';

export type ScopedEntity =
  | 'connections'
  | 'source_tables'
  | 'source_columns'
  | 'table_relationships'
  | 'kpi_definitions'
  | 'data_products'
  | 'product_tables'
  | 'product_columns';

type Db = Knex | Knex.Transaction;

/**
 * The connection owning `id`, or null when it cannot be resolved (row already
 * deleted, an entity that exists only in Neo4j, or a null FK).
 *
 * Resolve BEFORE deleting the entity — afterwards the row is gone and this
 * returns null, silently degrading to a global wipe.
 */
export async function connectionIdForEntity(
  db: Db,
  table: ScopedEntity,
  id: unknown,
): Promise<number | null> {
  const entityId = Number(id);
  if (!Number.isInteger(entityId) || entityId <= 0) return null;

  const row = await selectConnectionId(db, table, entityId);
  const cid = Number(row?.connection_id);
  return Number.isInteger(cid) && cid > 0 ? cid : null;
}

function selectConnectionId(
  db: Db,
  table: ScopedEntity,
  id: number,
): Promise<{ connection_id?: unknown } | undefined> {
  switch (table) {
    case 'connections':
      // Already a connection — echo it back if the row exists, so callers can
      // treat every entity type uniformly.
      return db('connections').where({ id }).first('id as connection_id');

    case 'source_tables':
    case 'kpi_definitions':
    case 'data_products':
      return db(table).where({ id }).first('connection_id');

    case 'source_columns':
      return db('source_columns')
        .join('source_tables', 'source_tables.id', 'source_columns.table_id')
        .where('source_columns.id', id)
        .first('source_tables.connection_id as connection_id');

    case 'table_relationships':
      // No connection_id column; the relationship belongs to whichever
      // connection owns its FROM table.
      return db('table_relationships')
        .join('source_tables', 'source_tables.id', 'table_relationships.from_table_id')
        .where('table_relationships.id', id)
        .first('source_tables.connection_id as connection_id');

    // Product entities: the id may be the Postgres id OR the minted graph id
    // (`neo4j_pg_id`) — catalog/product-tree surfaces hand out the latter (see
    // GRAPH_ID_ALIAS in db/tenantOwnership.ts). Matching both keeps the
    // invalidation scoped instead of degrading to the global-wipe fallback.
    case 'product_tables':
      return db('product_tables')
        .join('star_schemas', 'star_schemas.id', 'product_tables.star_schema_id')
        .join('data_products', 'data_products.id', 'star_schemas.data_product_id')
        .where((qb) => { qb.where('product_tables.id', id).orWhere('product_tables.neo4j_pg_id', id); })
        .first('data_products.connection_id as connection_id');

    case 'product_columns':
      return db('product_columns')
        .join('product_tables', 'product_tables.id', 'product_columns.product_table_id')
        .join('star_schemas', 'star_schemas.id', 'product_tables.star_schema_id')
        .join('data_products', 'data_products.id', 'star_schemas.data_product_id')
        .where((qb) => { qb.where('product_columns.id', id).orWhere('product_columns.neo4j_pg_id', id); })
        .first('data_products.connection_id as connection_id');
  }
}
