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
