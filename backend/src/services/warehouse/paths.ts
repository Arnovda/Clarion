/**
 * Warehouse path primitives.
 *
 * The single place that knows how to detect, parse, and construct
 * warehouse URIs (local fs vs Azure Blob). Other modules should never
 * call `p.startsWith('az://')` directly — go through `isAzurePath`.
 *
 * For Phase 1 this module is intentionally behaviour-preserving: the
 * `productBasePath` / `productTablePath` rules match what
 * transformationRunner used. Phase 3 will introduce a tenant-prefixed
 * v2 layout — when that lands, this module becomes the only place that
 * has to choose between v1 and v2.
 */

import path from 'path';

/** True if the given URI points at Azure Blob Storage. */
export function isAzurePath(p: string): boolean {
  return p.startsWith('az://') || p.startsWith('abfss://');
}

/**
 * True if the deployment writes warehouse data to Azure Blob Storage.
 *
 * Marker is `AZURE_CONTAINER_APPS_JOB_NAME` — set in the Azure Container
 * Apps environment, never set locally. This matches the existing
 * SyncOrchestrator detection so source + product paths agree on the
 * environment.
 */
export function isAzureMode(): boolean {
  return !!process.env.AZURE_CONTAINER_APPS_JOB_NAME;
}

/**
 * Warehouse container isolation mode.
 *
 *   • `shared`     (default) — one Azure Blob container ('warehouse') holds
 *     every tenant's data, separated by a `tenant_<id>/` path prefix.
 *     Isolation is code-enforced (path prefix + catalog-mediated views).
 *   • `per-tenant`           — each tenant gets its own Blob container
 *     (`<prefix><tenantId>`, e.g. `tenant-42`). Isolation becomes a hard
 *     storage boundary: a worker SAS scoped to `tenant-42` is physically
 *     incapable of touching `tenant-43`, and offboarding a tenant is a
 *     single `deleteContainer` call.
 *
 * Default is `shared` so this is behaviour-preserving: existing deployments
 * are untouched until `WAREHOUSE_CONTAINER_MODE=per-tenant` is set. Because
 * every stored `delta_path` / `warehouse_path` is an absolute URI (it
 * includes the container), old data written under the shared container keeps
 * reading correctly after the flag flips — new writes simply land in the
 * per-tenant container. Migration is per-table, exactly like the v1→v2
 * path migration.
 *
 * Local (filesystem) mode has no containers; the tenant is always a path
 * segment there regardless of this flag.
 */
export type WarehouseContainerMode = 'shared' | 'per-tenant';

export function warehouseContainerMode(): WarehouseContainerMode {
  return process.env.WAREHOUSE_CONTAINER_MODE === 'per-tenant' ? 'per-tenant' : 'shared';
}

/**
 * The Azure Blob container name for a tenant.
 *
 *   • shared mode      → AZURE_WAREHOUSE_CONTAINER (default 'warehouse')
 *   • per-tenant mode  → `<AZURE_WAREHOUSE_CONTAINER_PREFIX><tenantId>`
 *                        (default prefix 'tenant-', e.g. 'tenant-42')
 *
 * When `tenantId` is omitted the shared container is always returned — so
 * legacy call-sites that don't yet thread a tenant id keep working (they
 * only ever mattered in shared mode). Azure container names must be 3–63
 * chars, lowercase alphanumeric + single hyphens; `tenant-<int>` satisfies
 * that for any realistic tenant id.
 */
export function warehouseContainer(tenantId?: number): string {
  const shared = process.env.AZURE_WAREHOUSE_CONTAINER ?? 'warehouse';
  if (warehouseContainerMode() === 'per-tenant') {
    // Fail CLOSED. Falling back to the shared container here would silently
    // place one tenant's data where every tenant can reach it — the exact
    // boundary per-tenant mode exists to create — and nothing downstream would
    // report it. A missing tenant id in this mode is a bug at the call site, so
    // say so loudly rather than writing to the wrong place.
    if (tenantId == null) {
      throw new Error(
        'warehouseContainer: tenantId is required in per-tenant mode — refusing to fall back to the shared container',
      );
    }
    const prefix = process.env.AZURE_WAREHOUSE_CONTAINER_PREFIX ?? 'tenant-';
    const name = `${prefix}${tenantId}`;
    assertValidContainerName(name);
    return name;
  }
  return shared;
}

/**
 * Azure Blob container names must be 3–63 chars, lowercase alphanumeric with
 * single (non-leading/trailing) hyphens. `tenant-<int>` satisfies this for any
 * realistic tenant id, but a custom `AZURE_WAREHOUSE_CONTAINER_PREFIX` (or an
 * unexpected id) could produce an invalid name that only fails deep inside the
 * Azure SDK. Validate up front so the error is clear and local.
 */
export function assertValidContainerName(name: string): void {
  const ok = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/.test(name) && !name.includes('--');
  if (!ok) {
    throw new Error(
      `Invalid Azure container name "${name}" — must be 3–63 chars, lowercase ` +
      `alphanumeric with single interior hyphens. Check AZURE_WAREHOUSE_CONTAINER_PREFIX.`,
    );
  }
}

/**
 * The canonical warehouse root URI for the current environment.
 *
 *   • Azure: `az://<container>` (see `warehouseContainer` for the container)
 *   • Local: `<repo>/warehouse` (resolves relative to backend/src/services/warehouse/)
 *
 * All v2 paths (sources, products, rollups) compose on top of this root.
 * Pass `tenantId` so per-tenant-container mode resolves to the tenant's own
 * container; omit it (shared mode only) to get the shared root.
 */
export function warehouseRoot(tenantId?: number): string {
  if (isAzureMode()) {
    return `az://${warehouseContainer(tenantId)}`;
  }
  // backend/src/services/warehouse/paths.ts → ../../../../warehouse (repo root)
  return path.resolve(__dirname, '../../../../warehouse');
}

/**
 * Whether the tenant segment lives in the container name (per-tenant mode)
 * rather than as a path prefix. When true, source/product paths must NOT
 * repeat `tenant_<id>/` in the blob path — the container already encodes it.
 */
function tenantIsContainer(): boolean {
  return isAzureMode() && warehouseContainerMode() === 'per-tenant';
}

/**
 * Active warehouse layout version. v2 enables tenant-prefixed product
 * paths (`<root>/tenant_<tid>/product_<pid>/<table>`). Old data continues
 * to read from whatever `delta_path` is stored — migration is per-table,
 * naturally completed as each product is re-refreshed.
 */
export type WarehouseLayoutVersion = 'v1' | 'v2';

export function warehouseLayoutVersion(): WarehouseLayoutVersion {
  // v2 is the default as of the May 2026 security hardening (tenant-prefixed
  // paths eliminate cross-tenant collision risk for product warehouses).
  // Set WAREHOUSE_LAYOUT_VERSION=v1 explicitly to opt back into the legacy
  // non-prefixed layout — useful only when a deployment still has existing
  // v1 directories that haven't yet been migrated.
  return process.env.WAREHOUSE_LAYOUT_VERSION === 'v1' ? 'v1' : 'v2';
}

/**
 * v2 product directory — the new tenant-prefixed layout. Stable across
 * product renames (uses id, not slug). Use this for NEW writes; old
 * `delta_path`s in the DB still resolve via the catalog because the
 * catalog reads the stored URI verbatim.
 *
 *   `<root>/tenant_<tid>/product_<pid>`
 */
export function productBasePathV2(tenantId: number, productId: number): string {
  const root = warehouseRoot(tenantId);
  if (isAzurePath(root)) {
    // In per-tenant-container mode the container IS the tenant boundary, so we
    // don't repeat `tenant_<id>/` in the blob path. In shared mode we keep the
    // tenant segment so tenants don't collide inside the shared container.
    const tenantSeg = tenantIsContainer() ? '' : `/tenant_${tenantId}`;
    return `${root}${tenantSeg}/product_${productId}`;
  }
  return path.join(root, `tenant_${tenantId}`, `product_${productId}`);
}

/**
 * v2 source directory — where an ingested connection's tables live. Mirrors
 * `productBasePathV2` for the source layer so both agree on the container /
 * tenant-segment rules. This is the READ path DuckDB registers views over;
 * the worker WRITE path derives the same location from its SAS URL container
 * plus the `conn_<id>/` prefix (see BlobSasTokenIssuer / the launcher).
 *
 *   • shared Azure     : `az://warehouse/tenant_<tid>/conn_<cid>`
 *   • per-tenant Azure : `az://tenant_<tid>/conn_<cid>`  (container = tenant)
 *   • local            : `<repo>/warehouse/tenant_<tid>/conn_<cid>`
 */
export function sourceBasePathV2(tenantId: number, connectionId: number): string {
  const root = warehouseRoot(tenantId);
  if (isAzurePath(root)) {
    const tenantSeg = tenantIsContainer() ? '' : `/tenant_${tenantId}`;
    return `${root}${tenantSeg}/conn_${connectionId}`;
  }
  return path.join(root, `tenant_${tenantId}`, `conn_${connectionId}`);
}

/**
 * The blob path-prefix the sync worker writes under, inside whichever
 * container its SAS is scoped to.
 *
 *   • shared mode     → `tenant_<tid>/conn_<cid>/`  (tenant is a path segment)
 *   • per-tenant mode → `conn_<cid>/`               (tenant is the container)
 *
 * Keep this in lockstep with `sourceBasePathV2` — the worker's writes must
 * land exactly where the backend later reads.
 */
export function sourceWorkerPathPrefix(tenantId: number, connectionId: number): string {
  return tenantIsContainer()
    ? `conn_${connectionId}/`
    : `tenant_${tenantId}/conn_${connectionId}/`;
}

/** Parse an Azure Blob URI like `az://<container>/<path>` into parts. */
export function parseAzurePath(azPath: string): { container: string; blob: string } {
  const match = azPath.match(/^az:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid Azure path: ${azPath}`);
  return { container: match[1], blob: match[2] };
}

/**
 * Build the product output directory/URI for a product.
 *
 * Behaviour kept identical to the legacy in-place implementation in
 * transformationRunner.ts (which the dependency loader, the runner
 * itself, the quality route, and the dashboards path-resolver all
 * relied on):
 *
 *   • Azure: strip a trailing `/conn_<n>` from the connection's
 *     warehouse_path and append `/products/<slug>`. So
 *     `az://warehouse/tenant_1/conn_4` → `az://warehouse/tenant_1/products/<slug>`.
 *   • Local: ALWAYS resolves to `./warehouse/product/<slug>`, ignoring
 *     the connection's warehouse_path. (This is the cross-tenant
 *     collision risk flagged in the audit; will be fixed in Phase 3.)
 */
export function productBasePath(warehousePath: string, productSlug: string): string {
  if (isAzurePath(warehousePath)) {
    const stripped = warehousePath.replace(/\/conn_\d+$/, '');
    return `${stripped}/products/${productSlug}`;
  }
  return path.resolve('./warehouse/product', productSlug);
}

/** Build the URI for a specific product table inside a product directory. */
export function productTablePath(productDir: string, tableName: string): string {
  if (isAzurePath(productDir)) {
    return `${productDir}/${tableName}`;
  }
  return path.join(productDir, tableName);
}

/**
 * Slugify a product name the same way every caller does. Centralised so
 * a rename of e.g. `productSlug` is consistent across surfaces.
 */
export function productSlug(productName: string): string {
  return productName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * Normalise an arbitrary path string for use in DuckDB SQL. Forward
 * slashes only; single quotes escaped. Azure URIs pass through unchanged.
 */
export function sqlEscapePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "''");
}
