/**
 * Table Catalog — the single source of truth for "where does this
 * logical table live, and how do I access it?"
 *
 * Phase 2 of the storage-layer consolidation. Every consumer that
 * needs to read parquet/delta data should call into this module —
 * never query `product_tables.delta_path`, `ingested_tables.delta_path`,
 * or `connections.warehouse_path` directly.
 *
 * Why centralise:
 *   - Today the same question ("where is dim_account?") is answered
 *     differently by /query, /dashboards, /notebooks, /catalog,
 *     /quality, the dependency loader in transformationRunner, and
 *     dbtProjectBuilder. Each has its own join, its own fallback,
 *     its own remap logic. Bugs like the recent `delta_path` /
 *     `is_shared_dimension` cascade come from these surfaces falling
 *     out of sync.
 *   - The catalog encapsulates: which table to query (ingested_tables
 *     vs selected_entities vs product_tables), the docker→host path
 *     remap for legacy ETL, the upstream-owner lookup for stub rows,
 *     and tenant scoping. Callers ask "list product tables for this
 *     connection"; the catalog returns ready-to-use URIs.
 *   - The single writer (`publishProductTable`) is the only place
 *     that touches `delta_path` + `row_count` + `transformation_status`
 *     for the success path. That makes regressions like "runner says
 *     SUCCESS but delta_path is null" structurally impossible — the
 *     contract is enforced at the function boundary.
 *
 * What this module DOES NOT do (yet):
 *   - It does not yet construct paths for new product tables (Phase 3
 *     will introduce a tenant-prefixed v2 layout). For now it reads
 *     whatever `delta_path` was written by the runner.
 *   - It does not normalise `ingested_tables` vs `selected_entities`
 *     into a single `table_locations` view (Phase 4). It exposes a
 *     uniform read API on top of the current half-state.
 */

import path from 'path';
import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import {
  isAzurePath,
  productBasePath,
  productTablePath,
  productSlug,
  gridViewName,
} from './warehouse';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedTable {
  /** Logical table name (e.g. "dim_account", "fact_sales_invoices"). */
  tableName: string;
  /**
   * Host-usable URI:
   *   - Azure: `az://<container>/<blob/path>`
   *   - Local: absolute filesystem path
   * Pass directly to `createScanView` from `services/warehouse`.
   */
  uri: string;
  /** Row count if known. Null for sources where we don't track it. */
  rowCount: number | null;
  /** ISO timestamp of last successful refresh, if any. */
  lastUpdatedAt: string | null;
}

export interface ResolvedProductTable extends ResolvedTable {
  productId: number;
  productName: string;
  /** 'fact' | 'dimension' | 'bridge' | 'junk' — used by callers that
   *  only care about one role (e.g. dependency loaders that load
   *  conformed dimensions, not facts). */
  tableRole: string;
  /** True when this row is a downstream stub pointing at an upstream owner. */
  isStub: boolean;
  /**
   * URI of this fact's monthly pre-aggregation, when one was written. Callers
   * that register query views MUST register it as `rollup_monthly_<tableName>`
   * — the semantic context tells the model that table exists, and a name the
   * model is told to prefer but that resolves to no view is a guaranteed query
   * failure.
   */
  rollupUri: string | null;
}

// ---------------------------------------------------------------------------
// Resolution — single tables
// ---------------------------------------------------------------------------

/**
 * Resolve a single source table by connection + name.
 *
 * Looks at `ingested_tables` first (legacy ETL flow), falls back to
 * deriving the URI from `connections.warehouse_path` + entity name
 * (source-connector flow). Returns null if the table isn't ready yet.
 */
export async function resolveSourceTable(
  tenantId: number | undefined,
  connectionId: number,
  tableName: string,
): Promise<ResolvedTable | null> {
  const conn = await tenantQuery(tenantId, (trx) =>
    trx('connections').where({ id: connectionId }).first(),
  );
  if (!conn) return null;
  const warehousePath: string | null = conn.warehouse_path ?? null;
  if (!warehousePath) return null;

  // Try ingested_tables first (legacy ETL).
  const ingested = await tenantQuery(tenantId, (trx) =>
    trx('ingested_tables')
      .where({ connection_id: connectionId, table_name: tableName, status: 'done' })
      .first(),
  );
  if (ingested) {
    return {
      tableName,
      uri: resolveIngestedUri(ingested.delta_path, warehousePath),
      rowCount: ingested.row_count != null ? Number(ingested.row_count) : null,
      lastUpdatedAt: ingested.ingested_at ? String(ingested.ingested_at) : null,
    };
  }

  // Source-connector flow — table_name should be in selected_entities.
  const entities: string[] = Array.isArray(conn.selected_entities) ? conn.selected_entities : [];
  if (!entities.includes(tableName)) return null;

  return {
    tableName,
    uri: deriveSourceUri(warehousePath, tableName),
    rowCount: null,
    lastUpdatedAt: conn.last_synced_at ? String(conn.last_synced_at) : null,
  };
}

/**
 * Resolve a product table by id (the `product_tables.id` PK). The
 * primary entry point used by single-table surfaces (catalog preview,
 * quality profiling).
 */
export async function resolveProductTableById(
  tenantId: number | undefined,
  productTableId: number,
): Promise<ResolvedProductTable | null> {
  const row = await tenantQuery(tenantId, (trx) =>
    trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where('pt.id', productTableId)
      .select(
        'pt.id', 'pt.table_name', 'pt.delta_path', 'pt.row_count',
        'pt.last_run_at', 'pt.transformation_status', 'pt.is_shared_dimension',
        'pt.table_role',
        'pt.rollup_path',
        'dp.id as product_id', 'dp.name as product_name',
      )
      .first(),
  );
  if (!row) return null;
  if (!row.delta_path) return null;
  if (row.transformation_status !== 'success') return null;

  return mapProductRow(row);
}

/** Resolve by (productId, tableName). */
export async function resolveProductTable(
  tenantId: number | undefined,
  productId: number,
  tableName: string,
): Promise<ResolvedProductTable | null> {
  const row = await tenantQuery(tenantId, (trx) =>
    trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where({ 'dp.id': productId, 'pt.table_name': tableName })
      .where('pt.transformation_status', 'success')
      .whereNotNull('pt.delta_path')
      .select(
        'pt.id', 'pt.table_name', 'pt.delta_path', 'pt.row_count',
        'pt.last_run_at', 'pt.transformation_status', 'pt.is_shared_dimension',
        'pt.table_role',
        'pt.rollup_path',
        'dp.id as product_id', 'dp.name as product_name',
      )
      .first(),
  );
  return row ? mapProductRow(row) : null;
}

// ---------------------------------------------------------------------------
// Resolution — listings
// ---------------------------------------------------------------------------

/**
 * List every ready source table for a connection. Combines legacy
 * `ingested_tables` rows and source-connector `selected_entities` so
 * callers don't need to know which flow ingested the data.
 */
export async function listSourceTables(
  tenantId: number | undefined,
  connectionId: number,
): Promise<ResolvedTable[]> {
  const conn = await tenantQuery(tenantId, (trx) =>
    trx('connections').where({ id: connectionId }).first(),
  );
  if (!conn) return [];
  const warehousePath: string | null = conn.warehouse_path ?? null;
  if (!warehousePath) return [];

  const ingested = await tenantQuery(tenantId, (trx) =>
    trx('ingested_tables')
      .where({ connection_id: connectionId, status: 'done' })
      .select('table_name', 'delta_path', 'row_count', 'ingested_at'),
  );

  if (ingested.length > 0) {
    return ingested.map((r) => ({
      tableName: r.table_name as string,
      uri: resolveIngestedUri(r.delta_path as string, warehousePath),
      rowCount: r.row_count != null ? Number(r.row_count) : null,
      lastUpdatedAt: r.ingested_at ? String(r.ingested_at) : null,
    }));
  }

  // Source-connector flow — derive from selected_entities.
  const entities: string[] = Array.isArray(conn.selected_entities) ? conn.selected_entities : [];
  return entities.map((entity) => ({
    tableName: entity,
    uri: deriveSourceUri(warehousePath, entity),
    rowCount: null,
    lastUpdatedAt: conn.last_synced_at ? String(conn.last_synced_at) : null,
  }));
}

/** List every ready product table for a single product (joined to its parent). */
export async function listProductTables(
  tenantId: number | undefined,
  productId: number,
): Promise<ResolvedProductTable[]> {
  const rows = await tenantQuery(tenantId, (trx) =>
    trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where('dp.id', productId)
      .where('pt.transformation_status', 'success')
      .whereNotNull('pt.delta_path')
      .select(
        'pt.id', 'pt.table_name', 'pt.delta_path', 'pt.row_count',
        'pt.last_run_at', 'pt.transformation_status', 'pt.is_shared_dimension',
        'pt.table_role',
        'pt.rollup_path',
        'dp.id as product_id', 'dp.name as product_name',
      ),
  );
  return rows.map(mapProductRow);
}

/**
 * List every ready product table across all products for a connection.
 * Used by `createProductConnector` to register one DuckDB session that
 * can JOIN across products (conformed dimensions etc.).
 */
export async function listProductTablesByConnection(
  tenantId: number | undefined,
  connectionId: number,
): Promise<ResolvedProductTable[]> {
  const rows = await tenantQuery(tenantId, (trx) =>
    trx('product_tables as pt')
      .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
      .join('data_products as dp', 'ss.data_product_id', 'dp.id')
      .where('dp.connection_id', connectionId)
      .where('pt.transformation_status', 'success')
      .whereNotNull('pt.delta_path')
      .select(
        'pt.id', 'pt.table_name', 'pt.delta_path', 'pt.row_count',
        'pt.last_run_at', 'pt.transformation_status', 'pt.is_shared_dimension',
        'pt.table_role',
        'pt.rollup_path',
        'dp.id as product_id', 'dp.name as product_name',
      ),
  );
  return rows.map(mapProductRow);
}

// ---------------------------------------------------------------------------
// Writes — the only place that mutates delta_path
// ---------------------------------------------------------------------------

/**
 * Mark a product table as successfully materialised at `uri`. Replaces
 * the inline `.update({ transformation_status: 'success', delta_path,
 * row_count, last_run_at, last_run_error: null })` pattern in
 * transformationRunner. Single writer = single contract = no more
 * "runner says SUCCESS but delta_path is null" regressions.
 */
export async function publishProductTable(
  tenantId: number | undefined,
  productTableId: number,
  uri: string,
  rowCount: number,
  trx?: Knex.Transaction,
): Promise<void> {
  const work = (q: Knex | Knex.Transaction) =>
    q('product_tables').where({ id: productTableId }).update({
      transformation_status: 'success',
      delta_path: uri,
      row_count: rowCount,
      last_run_at: new Date().toISOString(),
      last_run_error: null,
    });

  if (trx) {
    await work(trx);
    return;
  }
  await tenantQuery(tenantId, work);
}

/**
 * Record where a fact table's monthly pre-aggregation landed — or that it has
 * none. Pass `null` to clear.
 *
 * Rollups used to be written and only logged, so the sole way to find one was
 * an `fs.readdirSync` of the v1 local layout that returned nothing on Azure.
 * The result: the pre-aggregation the dashboard prompt tells the model to
 * prefer was invisible in production for its entire life. Paths belong in the
 * catalog for exactly this reason — a reader must never re-derive a location
 * from environment plus layout version.
 *
 * Always called after a successful refresh of a fact table, including with
 * `null`, so a table that stops qualifying does not keep advertising a stale
 * rollup.
 */
export async function publishRollup(
  tenantId: number | undefined,
  productTableId: number,
  rollup: { uri: string; rowCount: number } | null,
): Promise<void> {
  await tenantQuery(tenantId, (q) =>
    q('product_tables').where({ id: productTableId }).update({
      rollup_path: rollup?.uri ?? null,
      rollup_row_count: rollup?.rowCount ?? null,
    }),
  );
}

/** A materialised managed grid, ready to register as a DuckDB view. */
export interface ManagedGridTable {
  gridId: number;
  /** DuckDB view name — `grid_<slug>` via `gridViewName`. */
  viewName: string;
  /** Directory URI recorded at write time. */
  uri: string;
  displayName: string;
  kind: string;
  description: string | null;
  rowCount: number;
  /** Declared columns: [{ key, name, type }]. */
  columns: Array<{ key: string; name: string; type: string }>;
}

/**
 * List the tenant's materialised managed grids (the in-Clarion editable
 * tables). Same catalog doctrine as `publishRollup`: the URI is read back
 * verbatim from where the materialiser recorded it, never re-derived.
 * Grids are TENANT-level, not connection-level — every product-layer
 * session registers them, which is what makes budget-vs-actual an ordinary
 * join.
 */
export async function listManagedGridTables(
  tenantId: number | undefined,
): Promise<ManagedGridTable[]> {
  const rows = await tenantQuery(tenantId, (q) => {
    let qb = q('managed_grids')
      .whereNotNull('warehouse_path')
      .select('id', 'slug', 'name', 'kind', 'description', 'row_count', 'columns', 'warehouse_path');
    // Explicit tenant filter on top of RLS — same rule as every aggregate
    // read (the pooled-connection tenant var races).
    if (tenantId != null) qb = qb.where('tenant_id', tenantId);
    return qb;
  });
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    gridId: Number(r.id),
    viewName: gridViewName(String(r.slug)),
    uri: String(r.warehouse_path),
    displayName: String(r.name),
    kind: String(r.kind),
    description: r.description == null ? null : String(r.description),
    rowCount: Number(r.row_count) || 0,
    columns: Array.isArray(r.columns)
      ? (r.columns as Array<{ key: string; name: string; type: string }>)
      : [],
  }));
}

/**
 * Mark a stub product table as successful by mirroring the upstream
 * owner's location + row count. Returns `null` if no upstream owner
 * exists (caller can choose to mark as failed or skip).
 */
export async function publishStubFromUpstream(
  tenantId: number | undefined,
  productTableId: number,
  productId: number,
  tableName: string,
): Promise<{ uri: string; rowCount: number } | null> {
  const upstream = await tenantQuery(tenantId, (trx) =>
    trx('data_product_dependencies as dpd')
      .join('star_schemas as ss', 'ss.data_product_id', 'dpd.source_product_id')
      .join('product_tables as pt', 'pt.star_schema_id', 'ss.id')
      .where('dpd.dependent_product_id', productId)
      .where('pt.table_name', tableName)
      .where('pt.is_shared_dimension', false)
      .select('pt.delta_path', 'pt.row_count')
      .first(),
  );
  const uri = (upstream?.delta_path as string) ?? null;
  const rowCount = upstream?.row_count != null ? Number(upstream.row_count) : 0;

  await tenantQuery(tenantId, (trx) =>
    trx('product_tables').where({ id: productTableId }).update({
      transformation_status: 'success',
      last_run_at: new Date().toISOString(),
      last_run_error: null,
      delta_path: uri,
      row_count: rowCount,
    }),
  );

  return uri ? { uri, rowCount } : null;
}

/**
 * Mark a product table as failed. Records the error message; leaves
 * `delta_path` untouched so the previous good copy stays queryable
 * (the catalog preview will show the last successful build).
 */
export async function markProductTableFailed(
  tenantId: number | undefined,
  productTableId: number,
  errorMessage: string,
  trx?: Knex.Transaction,
): Promise<void> {
  const work = (q: Knex | Knex.Transaction) =>
    q('product_tables').where({ id: productTableId }).update({
      transformation_status: 'error',
      last_run_at: new Date().toISOString(),
      last_run_error: errorMessage,
    });

  if (trx) {
    await work(trx);
    return;
  }
  await tenantQuery(tenantId, work);
}

/**
 * Mark a product table as currently running. Used at the start of a
 * transformation so the UI can show the in-flight state.
 */
export async function markProductTableRunning(
  tenantId: number | undefined,
  productTableId: number,
  trx?: Knex.Transaction,
): Promise<void> {
  const work = (q: Knex | Knex.Transaction) =>
    q('product_tables').where({ id: productTableId }).update({
      transformation_status: 'running',
      last_run_error: null,
    });

  if (trx) {
    await work(trx);
    return;
  }
  await tenantQuery(tenantId, work);
}

// ---------------------------------------------------------------------------
// Legacy compatibility — used by quality/products routes that still
// derive product directories the old way. Will be retired in Phase 3.
// ---------------------------------------------------------------------------

/**
 * Resolve the product warehouse directory (parent of all that product's
 * tables) from a product name + connection's warehouse base. Same rules
 * as `transformationRunner` uses.
 *
 * This is the migration target for inline path-construction in routes.
 * Phase 3 will replace name-based slugs with stable product ids.
 */
export function productWarehouseDir(connectionWarehouse: string, productName: string): string {
  return productBasePath(connectionWarehouse, productSlug(productName));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mapProductRow(row: Record<string, unknown>): ResolvedProductTable {
  return {
    tableName: String(row.table_name),
    uri: String(row.delta_path),
    rowCount: row.row_count != null ? Number(row.row_count) : null,
    lastUpdatedAt: row.last_run_at ? String(row.last_run_at) : null,
    productId: Number(row.product_id),
    productName: String(row.product_name),
    tableRole: String(row.table_role ?? 'unknown'),
    isStub: row.is_shared_dimension === true,
    rollupUri: row.rollup_path ? String(row.rollup_path) : null,
  };
}

/**
 * Resolve a path stored in `ingested_tables.delta_path` to a host-usable
 * URI. The ETL service may have written a docker-internal path
 * (`/warehouse/<table>`) — remap to the host's `connections.warehouse_path`.
 */
function resolveIngestedUri(deltaPath: string, warehousePath: string): string {
  if (isAzurePath(deltaPath)) return deltaPath;
  const normalised = deltaPath.replace(/\\/g, '/');
  if (normalised.startsWith('/warehouse/')) {
    const tableDir = normalised.split('/').pop()!;
    return path.resolve(warehousePath, tableDir);
  }
  return normalised;
}

/**
 * Derive a source-connector entity URI from `connections.warehouse_path`
 * + entity name. Used when `ingested_tables` is empty (the connector
 * flow doesn't populate it).
 */
function deriveSourceUri(warehousePath: string, entityName: string): string {
  if (isAzurePath(warehousePath)) {
    return `${warehousePath}/${entityName}`;
  }
  return path.resolve(warehousePath, entityName);
}

// Re-export `productTablePath` so callers that need to construct an
// output path for a NEW product table (the runner, before publishing)
// have one import.
export { productTablePath };
