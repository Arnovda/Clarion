/**
 * Unified Parquet writer for warehouse outputs.
 *
 * Replaces three separate write code paths in transformationRunner.ts
 * (writeParquetToAzure, inline COPY TO for full-overwrite, inline COPY
 * TO for incremental merge) with one entry point. Picks the right
 * mechanism based on whether the URI is local or Azure.
 *
 * Why both paths exist:
 *   - Local: DuckDB writes the parquet directly (`COPY (...) TO '...'`).
 *   - Azure: DuckDB's azure ext (v1.4) returns "Writing to Azure
 *     containers is currently not supported" on `COPY TO az://...`. So
 *     we stage to a local temp file and upload via @azure/storage-blob.
 *
 * That asymmetry should NEVER leak to callers — they call
 * `writeParquet(db, uri, sql)` and don't care which side they're on.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Database } from 'duckdb-async';
import { isAzurePath, parseAzurePath, sqlEscapePath } from './paths';
import { logger as rootLogger } from '../../utils/logger';

const log = rootLogger.child({ mod: 'warehouse-writer' });

/**
 * Write the result of `selectSql` to `uri` as Parquet.
 *
 * @param db        DuckDB session.
 * @param uri       Destination — local path or `az://...` URI.
 * @param selectSql A SQL expression that produces rows. Wrapped in
 *                  parens internally so callers can pass either a full
 *                  `SELECT ...` statement or a CTE (`WITH ...`).
 */
export async function writeParquet(
  db: Database,
  uri: string,
  selectSql: string,
): Promise<void> {
  if (isAzurePath(uri)) {
    await writeParquetToAzure(db, selectSql, uri);
    return;
  }

  // Local — DuckDB handles it directly. Caller is responsible for
  // ensuring the parent directory exists.
  const escaped = sqlEscapePath(uri);
  await db.exec(`COPY (${selectSql}) TO '${escaped}' (FORMAT PARQUET);`);
}

/**
 * A declared column for `rowsToParquetSelect`. Both halves are validated
 * against strict allow-lists before interpolation — these strings end up
 * inside a `read_json(columns={...})` clause.
 */
export interface DeclaredColumn {
  name: string;
  sqlType: string;
}

// Same allow-lists as the connector-package writers (ParquetWriter /
// BlobSasWarehouseWriter) — duplicated here because the sync-worker package
// deliberately shares no imports with the backend.
const SAFE_SQL_TYPE_RE =
  /^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|DOUBLE|REAL|DECIMAL\(\d+,\d+\)|BOOLEAN|DATE|TIMESTAMP|TIMESTAMPTZ|UUID|BLOB)$/;
const SAFE_COLUMN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertDeclaredColumns(columns: ReadonlyArray<DeclaredColumn>): void {
  if (columns.length === 0) throw new Error('rowsToParquetSelect: at least one column is required');
  for (const c of columns) {
    if (!SAFE_COLUMN_NAME_RE.test(c.name) || c.name.length > 128) {
      throw new Error(`rowsToParquetSelect: unsafe column name ${JSON.stringify(c.name)}`);
    }
    if (!SAFE_SQL_TYPE_RE.test(c.sqlType)) {
      throw new Error(`rowsToParquetSelect: unsafe SQL type ${JSON.stringify(c.sqlType)}`);
    }
  }
}

/**
 * Write ARBITRARY IN-MEMORY ROWS to `uri` as Parquet with a declared schema.
 *
 * The connector-package pattern (NDJSON staging file + `read_json` with
 * explicit `columns={...}`), ported for backend features that hold their rows
 * in Postgres rather than in a source system — managed grids being the first.
 * Values travel as DATA through the staging file; only column names and types
 * are interpolated, and both are allow-list validated above.
 *
 * Zero rows is a first-class case: the parquet is written from a
 * `SELECT NULL::<type> AS "<name>" ... WHERE FALSE`, so the file still
 * carries the declared schema and the registered view has real columns.
 */
export async function writeRowsParquet(
  db: Database,
  uri: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<DeclaredColumn>,
): Promise<void> {
  assertDeclaredColumns(columns);

  if (rows.length === 0) {
    const emptySelect = columns
      .map((c) => `NULL::${c.sqlType} AS "${c.name}"`)
      .join(', ');
    await writeParquet(db, uri, `SELECT ${emptySelect} WHERE FALSE`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-grid-'));
  const ndPath = path.join(tmpDir, 'rows.ndjson');
  try {
    const stream = fs.createWriteStream(ndPath, { encoding: 'utf8' });
    for (const row of rows) {
      stream.write(JSON.stringify(row));
      stream.write('\n');
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    const struct = columns.map((c) => `'${c.name}': '${c.sqlType}'`).join(', ');
    const projection = columns.map((c) => `"${c.name}"`).join(', ');
    const escNd = sqlEscapePath(ndPath);
    const selectSql =
      `SELECT ${projection} FROM read_json('${escNd}', format='newline_delimited', columns={${struct}})`;
    await writeParquet(db, uri, selectSql);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Local-stage-then-upload write to Azure. Internal — `writeParquet` is
 * the public entry point.
 */
async function writeParquetToAzure(
  db: Database,
  selectSql: string,
  azurePath: string,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-pq-'));
  const tmpFile = path.join(tmpDir, 'data.parquet').replace(/\\/g, '/');
  const escaped = tmpFile.replace(/'/g, "''");
  try {
    await db.exec(`COPY (${selectSql}) TO '${escaped}' (FORMAT PARQUET);`);

    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING not set');

    const { container, blob } = parseAzurePath(azurePath);
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const svc = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = svc.getContainerClient(container);
    await containerClient.createIfNotExists();
    const blobClient = containerClient.getBlockBlobClient(blob);
    await blobClient.uploadFile(tmpFile);
    log.info(`uploaded parquet → ${azurePath}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
