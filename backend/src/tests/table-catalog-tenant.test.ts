/**
 * D2 of the 2026-09-07 platform coherence review: three surfaces read the
 * warehouse catalog with `tenantId: undefined` —
 *
 *   • routes/notebooks.ts        `buildNamespacedDuckDB`      (the notebook)
 *   • services/productWarehouse  `buildConnectionWarehouseSession`
 *                                (refinement preview + per-table SQL cells)
 *   • routes/products/cells.ts   the AI schema context for `generate`
 *
 * `listSourceTables` / `listProductTablesByConnection` go through
 * `tenantQuery`, which opens its OWN transaction on the root pool and sets
 * tenant context only when given a tenant. With `undefined` it sets none, so
 * under the production `databridge_app` role (NOBYPASSRLS) the RLS predicate
 * is `tenant_id = NULL`: the first read (`connections WHERE id = …`) matches
 * nothing, `listSourceTables` short-circuits, and the DuckDB session comes up
 * with ZERO views. Every query against it then fails "table does not exist".
 *
 * It was racy rather than dead only because `middleware/auth.ts` still does a
 * session-level `SET app.current_tenant` on the pool that a reused connection
 * may happen to be carrying — which is exactly why it survived unnoticed.
 *
 * The suite's default handle is the superuser, for whom RLS is inert and this
 * is invisible. So, like `services-under-app-role.test.ts`, this file flips
 * DATABASE_URL to `databridge_app` BEFORE importing the catalog, and drives it
 * with no ambient context. The `undefined` cases below are the DEFECT pinned
 * in place: they are what every one of those six call sites used to do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';

// The superuser handle must exist BEFORE the env flip — db-helpers reads
// DATABASE_URL lazily on first call.
const superDb = getTestDb();
const superUrl = process.env.DATABASE_URL!;
process.env.DATABASE_URL = superUrl.replace(/\/\/[^@]+@/, '//databridge_app:databridge@');

type Catalog = typeof import('../services/tableCatalog');
let catalog: Catalog;

let tenantId: number;
let connectionId: number;

const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

beforeAll(async () => {
  await cleanTestDb();
  const helpers = await import('./helpers');
  const admin = await helpers.registerUser({ email: 'd2@catalog.test', companyName: 'Catalog D2' });
  tenantId = admin.user.tenantId;

  const [conn] = await superDb('connections').insert({
    tenant_id: tenantId, name: 'D2 source', type: 'duckdb', connector_type: 'exactonline',
    // No `ingested_tables` rows, so listSourceTables takes the
    // source-connector branch and derives from selected_entities.
    selected_entities: ['Accounts', 'SalesInvoices'],
    warehouse_path: '/tmp/d2-warehouse', config: JSON.stringify({}),
  }).returning('id');
  connectionId = idOf(conn);

  const [product] = await superDb('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: 'D2 Sales',
    description: 'x', status: 'approved', kind: 'analytics',
  }).returning('id');
  const [schema] = await superDb('star_schemas').insert({
    tenant_id: tenantId, data_product_id: idOf(product), name: 'D2 Sales schema',
  }).returning('id');
  await superDb('product_tables').insert({
    tenant_id: tenantId, star_schema_id: idOf(schema), table_name: 'fact_d2_sales',
    table_role: 'fact', transformation_status: 'success',
    delta_path: '/tmp/d2-warehouse/product_1/fact_d2_sales', row_count: 3,
  });

  catalog = await import('../services/tableCatalog');
});

afterAll(async () => {
  const { semanticDb } = await import('../db/knex');
  await semanticDb.destroy().catch(() => undefined);
  await closeTestDb();
});

describe('tableCatalog under databridge_app with no ambient tenant context', () => {
  it('the app-role pool really has no context (precondition)', async () => {
    const { semanticDb } = await import('../db/knex');
    expect(await semanticDb('connections')).toHaveLength(0);
    expect(await superDb('connections')).toHaveLength(1);
  });

  it('listSourceTables WITH the tenant returns the connection\'s entities', async () => {
    const rows = await catalog.listSourceTables(tenantId, connectionId);
    expect(rows.map((r) => r.tableName).sort()).toEqual(['Accounts', 'SalesInvoices']);
  });

  it('listSourceTables WITHOUT the tenant returns nothing — the D2 defect', async () => {
    // Not a quirk to preserve: this is what notebooks.ts:78,
    // productWarehouse.ts:39 and cells.ts:299 all did, and it is why a
    // notebook came up with an empty schema tree.
    expect(await catalog.listSourceTables(undefined, connectionId)).toEqual([]);
  });

  it('listProductTablesByConnection WITH the tenant returns the built table', async () => {
    const rows = await catalog.listProductTablesByConnection(tenantId, connectionId);
    expect(rows.map((r) => r.tableName)).toEqual(['fact_d2_sales']);
    expect(rows[0].uri).toContain('fact_d2_sales');
  });

  it('listProductTablesByConnection WITHOUT the tenant returns nothing — the D2 defect', async () => {
    expect(await catalog.listProductTablesByConnection(undefined, connectionId)).toEqual([]);
  });

  it('another tenant sees neither, even naming the right connection id', async () => {
    const helpers = await import('./helpers');
    const other = await helpers.registerUser({ email: 'other@catalog.test', companyName: 'Other D2' });
    expect(await catalog.listSourceTables(other.user.tenantId, connectionId)).toEqual([]);
    expect(await catalog.listProductTablesByConnection(other.user.tenantId, connectionId)).toEqual([]);
  });
});
