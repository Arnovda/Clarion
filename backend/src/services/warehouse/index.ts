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
  parseAzurePath,
  productBasePath,
  productTablePath,
  productSlug,
  sqlEscapePath,
} from './paths';

export { setupDuckDBForWarehouse } from './duckdb';

export { createScanView } from './views';
export type { CreateScanViewOptions } from './views';

export { writeParquet } from './writer';
