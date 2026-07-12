/**
 * Unified DuckDB view registration for warehouse tables.
 *
 * Replaces four near-duplicate implementations:
 *   • transformationRunner.createScanView
 *   • DuckDBConnector.createDeltaView
 *   • routes/notebooks.ts inline createView
 *   • dbtProjectBuilder inline read_parquet calls
 *
 * The fallback chain handles every shape of table the platform writes:
 *   - Delta Lake tables (source-connector ingestion writes these)
 *   - Parquet directories with `data.parquet` (transformationRunner
 *     writes these for product tables and rollups)
 *   - Parquet directories with `*.parquet` glob (older / wildcard
 *     writes)
 *   - Bare parquet files (some preview / introspection paths pass a
 *     direct `data.parquet` URI)
 */

import fs from 'fs';
import path from 'path';
import type { Database } from 'duckdb-async';
import { isAzurePath, sqlEscapePath } from './paths';
import { logger as rootLogger } from '../../utils/logger';

const log = rootLogger.child({ mod: 'warehouse-views' });

export interface CreateScanViewOptions {
  /**
   * Optional schema. When provided the view is registered as
   * `"<schema>"."<viewName>"` and the schema is created if missing.
   */
  schema?: string;
}

/**
 * Create a DuckDB view that scans `uri` (Delta or Parquet, local or
 * Azure). Idempotent (`CREATE OR REPLACE`). Throws if every fallback
 * fails — caller decides whether to log + skip or surface the error.
 */
export async function createScanView(
  db: Database,
  viewName: string,
  uri: string,
  opts: CreateScanViewOptions = {},
): Promise<void> {
  const safeView = viewName.replace(/"/g, '""');
  const qualified = opts.schema
    ? `"${opts.schema.replace(/"/g, '""')}"."${safeView}"`
    : `"${safeView}"`;

  if (opts.schema) {
    const safeSchema = opts.schema.replace(/"/g, '""');
    await db.exec(`CREATE SCHEMA IF NOT EXISTS "${safeSchema}";`);
  }

  const escaped = sqlEscapePath(uri);
  const azure = isAzurePath(uri);

  // Local mode: cheap fs.existsSync check first to pick the right scanner
  // without paying a DuckDB exec roundtrip per failed attempt.
  if (!azure) {
    const fsPath = uri.replace(/\//g, path.sep);

    // Delta table?
    const deltaLog = path.join(fsPath, '_delta_log');
    if (fs.existsSync(deltaLog)) {
      await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM delta_scan('${escaped}');`);
      return;
    }

    // Bare parquet file? Some callers pass a direct `<dir>/data.parquet`.
    if (fs.existsSync(fsPath) && fs.statSync(fsPath).isFile()) {
      await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}');`);
      return;
    }

    // Parquet directory — try `data.parquet` first (single-file convention
    // used by transformationRunner), then `*.parquet` glob (older writes).
    const dataParquet = path.join(fsPath, 'data.parquet');
    if (fs.existsSync(dataParquet)) {
      await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}/data.parquet');`);
      return;
    }
    await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}/*.parquet');`);
    return;
  }

  // Azure mode: can't fs-stat a blob URI cheaply, so try the same chain
  // via try-catch. Errors from each attempt are kept and surfaced if
  // every step fails — single noisy log line beats four silent ones.
  let deltaErr: unknown;
  try {
    await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM delta_scan('${escaped}');`);
    return;
  } catch (e) { deltaErr = e; }

  let parquetFileErr: unknown;
  try {
    await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}/data.parquet');`);
    return;
  } catch (e) { parquetFileErr = e; }

  try {
    await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}/*.parquet');`);
  } catch (globErr) {
    const dMsg = deltaErr instanceof Error ? deltaErr.message : String(deltaErr);
    const pMsg = parquetFileErr instanceof Error ? parquetFileErr.message : String(parquetFileErr);
    const gMsg = globErr instanceof Error ? globErr.message : String(globErr);
    log.warn(
      `createScanView("${viewName}") failed for ${uri} — ` +
      `delta=${dMsg} | data.parquet=${pMsg} | *.parquet=${gMsg}`,
    );
    throw globErr;
  }
}
