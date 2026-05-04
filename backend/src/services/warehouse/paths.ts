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
