/**
 * Warehouse — the single abstraction for reading/writing the data
 * warehouse (Delta Lake / Parquet, local fs or Azure Blob).
 *
 * Phase 1 of the storage-layer consolidation. Every surface that needs
 * to register a view, write a parquet, or construct a warehouse path
 * should import from here — never call DuckDB exec with a raw
 * `read_parquet`/`delta_scan`/`COPY TO` directly, never construct an
 * `az://...` URI inline. See CLAUDE.md → "Storage layer".
 *
 * Layered API:
 *   - paths   — URI construction (Layer 1)
 *   - duckdb  — DuckDB session setup, Azure extension dance
 *   - views   — Register a view over a Delta or Parquet location (Layer 2)
 *   - writer  — Write a SELECT result as Parquet (Layer 3)
 */

export {
  isAzurePath,
  isAzureMode,
  warehouseRoot,
  warehouseLayoutVersion,
  warehouseContainerMode,
  warehouseContainer,
  parseAzurePath,
  productBasePath,
  productBasePathV2,
  sourceBasePathV2,
  sourceWorkerPathPrefix,
  productTablePath,
  productSlug,
  rollupViewName,
  sqlEscapePath,
} from './paths';
export type { WarehouseLayoutVersion, WarehouseContainerMode } from './paths';

export { setupDuckDBForWarehouse, applyResourceGuardrails, capResultRows } from './duckdb';

export {
  ensureWarehouseContainer,
  deleteTenantWarehouseContainer,
  perTenantContainersActive,
} from './container';

export { createScanView } from './views';
export type { CreateScanViewOptions } from './views';

export { writeParquet } from './writer';

export { deleteWarehousePath, deleteWarehousePaths } from './deleter';
export type { DeleteResult } from './deleter';
