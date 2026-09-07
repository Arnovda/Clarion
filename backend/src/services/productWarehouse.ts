/**
 * THE warehouse session builder for a connection.
 *
 * Until 2026-09-07 there were three near-identical copies of this — here, in
 * `routes/notebooks.ts` (`buildNamespacedDuckDB`) and, in a different shape,
 * in `ConnectorFactory.createProductConnector`. They drifted, and the drift
 * ran one way: the Ask AI / dashboards session registered managed grids and
 * monthly rollups, and the notebook and preview sessions did not.
 *
 * That made the ESCAPE HATCH LESS CAPABLE THAN THE FRONT DOOR. `grid_budget_2026`
 * is a table Ask AI will happily join, so an analyst who opened a notebook to
 * check an answer got "table does not exist" — precisely when they were trying
 * to verify the product's own output. For a platform whose pitch is trust in
 * the number, "I can't reproduce it" is the worst available failure.
 *
 * So this file is now the one builder, and the notebook is a caller.
 * `createProductConnector` stays separate on purpose: it returns a pooled
 * `DuckDBConnector` (semaphores, the child-process runner, invalidation) built
 * from a table→path map, not a raw `Database` with schema-qualified views.
 * Same tables, different machinery; unifying THAT is a bigger change than this.
 *
 * What gets registered:
 *   • source tables       → schema = connection name
 *   • product tables      → schema = product name
 *   • monthly rollups     → schema = product name, as `rollup_monthly_<fact>`
 *   • managed grids       → DEFAULT schema, unqualified, tenant-wide
 *   • `search_path`       → every schema that actually registered
 *
 * Grids are deliberately unqualified: they are tenant-level, they are what
 * makes budget-vs-actual an ordinary JOIN, and Ask AI resolves them that way,
 * so SQL stays paste-able between the two surfaces. A grid never shadows a
 * product table — the guard below skips a collision rather than overwriting,
 * because a user's existing `FROM budget` must not silently change meaning.
 */
import { Knex } from 'knex';
import { Database } from 'duckdb-async';
import { isAzurePath, setupDuckDBForWarehouse, createScanView, rollupViewName } from './warehouse';
import { listSourceTables, listProductTablesForScope, listManagedGridTables } from './tableCatalog';
import type { QueryScope } from './queryScope';
import { planRegistration } from './warehouseRegistration';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'productWarehouse' });

/**
 * Build an in-memory DuckDB session with everything reachable from a
 * connection registered as a view. Caller owns the returned Database and
 * MUST close it.
 *
 * `tenantId` is REQUIRED, and passing it is not a formality: the catalog
 * reads below open their OWN transaction on the root pool, so they do not
 * inherit the caller's request-scoped tenant context. Called with
 * `undefined` — as this did until 2026-09-07 — `tenantQuery` sets no context
 * at all, the RLS predicate becomes `tenant_id = NULL`, and the very first
 * read (`connections WHERE id = …`) returns nothing, so the session registers
 * ZERO views and every query against it fails "table does not exist". It was
 * racy rather than dead only because `middleware/auth.ts` still does a
 * session-level SET on the pool that a reused connection may happen to carry.
 * Required, not optional-with-a-default, so the compiler names every caller.
 */
export async function buildConnectionWarehouseSession(
  pgDb: Knex | Knex.Transaction,
  scope: QueryScope,
): Promise<Database> {
  const tenantId = scope.tenantId;
  const crossSource = scope.connectionIds.length > 1;

  const connections = await pgDb('connections').whereIn('id', scope.connectionIds).select('id', 'name', 'warehouse_path');
  if (connections.length === 0) throw new Error('Connection not found');

  // Azure mode is needed if any connection warehouse OR any product delta_path
  // is an azure URI — product tables can live on Azure Blob even when the
  // source connection is local.
  const productDeltaPaths = await pgDb('product_tables')
    .join('star_schemas', 'product_tables.star_schema_id', 'star_schemas.id')
    .join('data_products', 'star_schemas.data_product_id', 'data_products.id')
    .whereIn('data_products.connection_id', scope.connectionIds)
    .whereNotNull('product_tables.delta_path')
    .pluck<string[]>('product_tables.delta_path');
  const needAzure = connections.some((c: { warehouse_path: string | null }) => isAzurePath(c.warehouse_path ?? ''))
    || productDeltaPaths.some(isAzurePath);

  const db = await Database.create(':memory:');
  await setupDuckDBForWarehouse(db, needAzure);

  // Only schemas that actually registered a view join the search_path — a name
  // in there that resolves to nothing turns every unqualified lookup into a
  // confusing error instead of a clean one.
  const registeredSchemas = new Set<string>();
  const registeredNames = new Set<string>();
  const createView = async (schema: string, viewName: string, uri: string) => {
    await createScanView(db, viewName, uri, { schema });
    registeredSchemas.add(schema);
    registeredNames.add(viewName);
  };

  // ── Source tables — schema = connection name ─────────────────────────────
  // Connection names are already distinct per source, so the source layer
  // needs no extra disambiguation: two systems' `Accounts` live in different
  // schemas and both stay reachable.
  for (const conn of connections) {
    const sources = await listSourceTables(tenantId, conn.id);
    for (const t of sources) {
      try {
        await createView(conn.name, t.tableName, t.uri);
      } catch (err) {
        log.warn({ err, table: t.tableName }, `failed to register source view ${conn.name}.${t.tableName}`);
      }
    }
  }

  // ── Product tables + their monthly rollups ──────────────────────────────
  //
  // Named by the SAME rule Ask AI uses (`warehouseRegistration`), and that is
  // the point rather than tidiness: a notebook exists to verify an answer, so
  // if the two surfaces disagreed about what a table is called, the check
  // would fail on the one query the analyst most needs to run. It also brings
  // the collision rule with it — a bare name two systems disagree about is
  // withheld here too, so an unqualified reference cannot resolve to the
  // wrong source's data.
  const productTables = await listProductTablesForScope(scope);
  const plan = planRegistration(
    productTables.map((t) => ({
      tableName: t.tableName,
      uri: t.uri,
      productName: t.productName,
      connectionId: t.connectionId ?? 0,
      connectionName: t.connectionName,
      rollupUri: t.rollupUri,
    })),
    { crossSource, rollupName: rollupViewName },
  );

  for (const name of plan.tableNames) {
    const uri = plan.tablePaths.get(name);
    if (!uri) continue;
    const schema = plan.tableSchemas.get(name);
    try {
      if (schema) await createView(schema, name, uri);
      else {
        // Ambiguous names carry their source in the name itself and live in
        // the default schema — the prefix already disambiguates.
        await createScanView(db, name, uri);
        registeredNames.add(name);
      }
    } catch (err) {
      log.warn({ err, table: name }, `failed to register product view ${schema ? `${schema}.` : ''}${name}`);
    }
  }

  // ── Managed grids — tenant-wide, DEFAULT schema, unqualified ─────────────
  const grids = await listManagedGridTables(tenantId);
  for (const g of grids) {
    // Never shadow a table that already registered: a grid appearing on top of
    // a product table would silently change what existing SQL means.
    if (registeredNames.has(g.viewName)) {
      log.warn({ view: g.viewName }, 'grid view name collides with a registered table — grid skipped');
      continue;
    }
    try {
      await createScanView(db, g.viewName, g.uri);
      registeredNames.add(g.viewName);
    } catch (err) {
      log.warn({ err, view: g.viewName }, `failed to register grid view ${g.viewName}`);
    }
  }

  // A session with nothing in it is the D2 signature, and it used to be
  // silent: the catches above skip per-view failures, so "registered nothing"
  // looked exactly like "registered everything". Say it once.
  if (registeredNames.size === 0) {
    log.warn(
      { connectionIds: scope.connectionIds, tenantId },
      'warehouse session registered no views — every query against it will fail',
    );
  }

  // Unqualified refs (`FROM fact_sales_order_lines`) resolve against any
  // registered schema, so AI-generated SQL from Ask AI is paste-and-run here.
  if (registeredSchemas.size > 0) {
    // DuckDB SET takes ONE scalar string: comma-separated names inside a
    // single quoted value.
    const schemaList = [...registeredSchemas].map((s) => s.replace(/'/g, "''")).join(',');
    try {
      await db.exec(`SET search_path = '${schemaList}';`);
    } catch (err) {
      log.warn({ err }, 'failed to set search_path');
    }
  }

  return db;
}
