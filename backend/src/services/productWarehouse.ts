/**
 * Product warehouse session builder — extracted verbatim from
 * routes/products.ts (Phase 6 split) so the routes/products sub-modules
 * (refineChat preview + cells execute) can share it without duplication.
 */
import { Database } from 'duckdb-async';
import { isAzurePath, setupDuckDBForWarehouse, createScanView } from './warehouse';
import { listSourceTables, listProductTablesByConnection } from './tableCatalog';
import { reqDb } from '../db/reqDb';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'productWarehouse' });

/**
 * Build an in-memory DuckDB session with every table reachable from a
 * connection registered as a view: the connection's own source tables
 * (under `<connection.name>` schema) and every product table built from
 * that connection (under `<productName>` schema), with the search_path
 * set so unqualified refs resolve. Shared by the notebook cell-execute
 * endpoint and the refinement preview endpoint so the two stay in lockstep.
 *
 * Caller owns the returned Database and MUST close it.
 *
 * `tenantId` is REQUIRED, and passing it is not a formality: the catalog
 * reads below open their OWN transaction on the root pool, so they do not
 * inherit the caller's request-scoped tenant context. Called with
 * `undefined` — as this did until 2026-09-07 — `tenantQuery` sets no
 * context at all, the RLS predicate becomes `tenant_id = NULL`, and the
 * very first read (`connections WHERE id = …`) returns nothing, so the
 * session registers ZERO views and every query against it fails with
 * "table does not exist". It was racy rather than dead only because
 * `middleware/auth.ts` still does a session-level SET on the pool that a
 * reused connection may happen to carry. Required, not optional-with-a-
 * default, so the compiler names every call site.
 */
export async function buildConnectionWarehouseSession(
  pgDb: ReturnType<typeof reqDb>,
  connectionId: number,
  tenantId: number | undefined,
): Promise<Database> {
  const connection = await pgDb('connections').where({ id: connectionId }).first();
  if (!connection) throw new Error('Connection not found');

  const productDeltaPaths = await pgDb('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .join('data_products', 'star_schemas.data_product_id', 'data_products.id')
    .where('data_products.connection_id', connectionId)
    .whereNotNull('product_tables.delta_path')
    .pluck<string[]>('product_tables.delta_path');
  const needAzure = isAzurePath(connection.warehouse_path ?? '') || productDeltaPaths.some(isAzurePath);

  const db = await Database.create(':memory:');
  await setupDuckDBForWarehouse(db, needAzure);

  const sources = await listSourceTables(tenantId, connectionId);
  for (const t of sources) {
    try { await createScanView(db, t.tableName, t.uri, { schema: connection.name }); } catch { /* skip */ }
  }
  const productTables = await listProductTablesByConnection(tenantId, connectionId);
  for (const t of productTables) {
    try { await createScanView(db, t.tableName, t.uri, { schema: t.productName }); } catch { /* skip */ }
  }

  // A session with nothing in it is the D2 signature, and it used to be
  // silent: the two loops above swallow per-view failures, so "registered
  // nothing" looked exactly like "registered everything". Say it once.
  if (sources.length === 0 && productTables.length === 0) {
    log.warn(
      { connectionId, tenantId },
      'warehouse session registered no views — every query against it will fail',
    );
  }

  const schemas = new Set<string>([connection.name]);
  for (const t of productTables) schemas.add(t.productName);
  const schemaList = [...schemas].map((s) => s.replace(/'/g, "''")).join(',');
  if (schemaList) {
    try { await db.exec(`SET search_path = '${schemaList}';`); } catch { /* ignore */ }
  }
  return db;
}
