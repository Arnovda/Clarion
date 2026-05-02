/**
 * SAS-scoped Azure Blob warehouse writer.
 *
 * The companion to `LocalFileWarehouseWriter` for cloud deployment.
 * Same `WarehouseWriter` interface; same Parquet output shape; same
 * call-site code in connectors. Only difference: Parquet bytes land in
 * Azure Blob Storage instead of the local filesystem.
 *
 * Security model:
 *   • The orchestrator generates a short-lived SAS URL scoped to a
 *     single connection's path (e.g. `warehouse-container?<sas>` with
 *     a path-prefix permission of `conn_<id>/`). It hands the URL to
 *     the worker via env var.
 *   • The worker NEVER sees a Storage account key. All writes go through
 *     the BlobSASSignatureValues encoded in the URL.
 *   • A worker that tries to write outside its scoped path gets a 403
 *     from Azure regardless of what the connector code does.
 *
 * Pipeline:
 *   1. Stream rows → NDJSON file in the container's tmpdir (same as local
 *      writer — bounded memory, streaming friendly).
 *   2. Run DuckDB COPY → produce a local Parquet file.
 *   3. Upload the Parquet file to Blob via the SAS URL.
 *   4. Delete the local tmp files.
 *
 * Why DuckDB→local-Parquet→Blob rather than DuckDB→Blob directly:
 *   • DuckDB's azure_blob extension exists but expects credentials in a
 *     different format than SAS URLs and has weaker isolation guarantees
 *     (it'd need broader permissions than this writer's per-connection scope).
 *   • Two stages keeps the trust surface small: DuckDB only writes to
 *     local disk; only `@azure/storage-blob` ever talks to Azure.
 *   • Parquet files at SMB scale are tens of MB — the upload step is
 *     bounded and predictable.
 */

import { Database } from 'duckdb-async';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ContainerClient } from '@azure/storage-blob';
import type { TableWriteResult, WarehouseWriter } from './types';

const BATCH_ROWS = 5_000;

export class BlobSasWarehouseWriter implements WarehouseWriter {
  private readonly container: ContainerClient;
  private readonly pathPrefix: string;

  /**
   * @param sasUrl  Container-scoped SAS URL the orchestrator issued.
   *                Format: `https://<account>.blob.core.windows.net/<container>?<sas>`.
   *                Optional `?prefix=` query param sandboxes writes — the
   *                writer will prepend it to every blob path.
   * @param pathPrefix Path inside the container to scope all writes to,
   *                e.g. `conn_42/`. Trailing slash optional.
   */
  constructor(sasUrl: string, pathPrefix: string) {
    if (!/^https:\/\/[^/]+\.blob\.core\.windows\.net\/[^?]+\?/.test(sasUrl)) {
      throw new Error('sasUrl must be a container-scoped SAS URL');
    }
    if (!isSafePathPrefix(pathPrefix)) {
      throw new Error(`Unsafe path prefix: ${pathPrefix}`);
    }
    this.container = new ContainerClient(sasUrl);
    this.pathPrefix = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
  }

  async writeTable(
    tableName: string,
    rows: AsyncIterable<Record<string, unknown>>,
  ): Promise<TableWriteResult> {
    if (!isSafeTableName(tableName)) {
      throw new Error(`Unsafe table name: ${tableName}`);
    }

    const stagingNdjson = path.join(os.tmpdir(), `databridge-stage-${randomUUID()}.ndjson`);
    const stagingParquet = path.join(os.tmpdir(), `databridge-out-${randomUUID()}.parquet`);

    let rowsWritten = 0;
    try {
      // ─── Stream rows to NDJSON ────────────────────────────────────────
      const fh = await fs.open(stagingNdjson, 'w');
      try {
        let batch: string[] = [];
        for await (const row of rows) {
          batch.push(jsonLine(row));
          rowsWritten += 1;
          if (batch.length >= BATCH_ROWS) {
            await fh.write(batch.join(''));
            batch = [];
          }
        }
        if (batch.length > 0) await fh.write(batch.join(''));
      } finally {
        await fh.close();
      }

      // ─── DuckDB → local Parquet ──────────────────────────────────────
      if (rowsWritten === 0) {
        await writeEmptyParquet(stagingParquet);
      } else {
        await convertNdjsonToParquet(stagingNdjson, stagingParquet);
      }

      // ─── Upload to Blob ──────────────────────────────────────────────
      const blobPath = `${this.pathPrefix}${tableName}/data.parquet`;
      const blockBlob = this.container.getBlockBlobClient(blobPath);
      const stat = await fs.stat(stagingParquet);
      await blockBlob.uploadFile(stagingParquet);

      return {
        rowsWritten,
        bytesWritten: stat.size,
        warehousePath: blobPath,
      };
    } finally {
      // Best-effort cleanup; never throw from the cleanup path.
      await fs.unlink(stagingNdjson).catch(() => undefined);
      await fs.unlink(stagingParquet).catch(() => undefined);
    }
  }
}

// ─── DuckDB helpers (mirror LocalFileWarehouseWriter) ─────────────────────
async function convertNdjsonToParquet(ndjsonPath: string, parquetPath: string): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    const escNd = ndjsonPath.replace(/'/g, "''");
    const escPq = parquetPath.replace(/'/g, "''");
    await db.all(`
      COPY (
        SELECT * FROM read_json('${escNd}', format='newline_delimited', auto_detect=true)
      )
      TO '${escPq}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

async function writeEmptyParquet(parquetPath: string): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    const esc = parquetPath.replace(/'/g, "''");
    await db.all(`
      COPY (SELECT NULL::VARCHAR AS _placeholder WHERE FALSE)
      TO '${esc}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

// ─── Validation ──────────────────────────────────────────────────────────
function isSafeTableName(name: string): boolean {
  return /^[A-Za-z0-9_\-]+$/.test(name) && name.length <= 128 && !name.startsWith('-');
}

function isSafePathPrefix(prefix: string): boolean {
  // Allow alphanum, _, -, /, no leading/trailing whitespace, no .. traversal.
  return /^[A-Za-z0-9_\-/]+$/.test(prefix) && !prefix.includes('..');
}

function jsonLine(row: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) cleaned[k] = null;
    else cleaned[k] = v;
  }
  return `${JSON.stringify(cleaned)}\n`;
}
