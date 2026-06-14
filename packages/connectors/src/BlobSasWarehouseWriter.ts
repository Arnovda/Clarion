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
import type { TableWriteResult, WarehouseWriter, WriteTableOptions } from './types';

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
    opts?: WriteTableOptions,
  ): Promise<TableWriteResult> {
    if (!isSafeTableName(tableName)) {
      throw new Error(`Unsafe table name: ${tableName}`);
    }
    if (opts?.mergeKey && !isSafeColumnName(opts.mergeKey)) {
      throw new Error(`Unsafe mergeKey: ${opts.mergeKey}`);
    }

    const stagingNdjson = path.join(os.tmpdir(), `clarion-stage-${randomUUID()}.ndjson`);
    const stagingParquet = path.join(os.tmpdir(), `clarion-out-${randomUUID()}.parquet`);
    const existingParquet = path.join(os.tmpdir(), `clarion-existing-${randomUUID()}.parquet`);
    const blobPath = `${this.pathPrefix}${tableName}/data.parquet`;
    const blockBlob = this.container.getBlockBlobClient(blobPath);

    let rowsWritten = 0;
    let downloadedExisting = false;
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

      // ─── Merge or overwrite? ─────────────────────────────────────────
      // If a mergeKey is supplied AND the blob exists, download it
      // locally and run the same merge SQL the local writer uses. Then
      // re-upload. This keeps the merge logic in one place (DuckDB) and
      // bounds the trust surface (only @azure/storage-blob talks to
      // Azure; DuckDB only sees local files).
      let useMerge = false;
      if (opts?.mergeKey) {
        if (await blobExists(blockBlob)) {
          await blockBlob.downloadToFile(existingParquet);
          downloadedExisting = true;
          useMerge = true;
        }
      }

      if (rowsWritten === 0 && !useMerge) {
        // Empty entity. If the connector handed us an explicit schema
        // (e.g. from OData $metadata on a zero-row table), materialise
        // the parquet WITH those columns so the catalog can show the
        // table's shape. Otherwise fall back to the legacy
        // single-_placeholder schema.
        const emptyCols = opts?.emptySchema?.length ? opts.emptySchema : opts?.columns;
        if (emptyCols && emptyCols.length > 0) {
          await writeEmptyParquetWithSchema(stagingParquet, emptyCols);
        } else {
          await writeEmptyParquet(stagingParquet);
        }
      } else if (useMerge) {
        await mergeNdjsonIntoExistingParquet(
          stagingNdjson,
          existingParquet,
          stagingParquet,
          opts!.mergeKey!,
          opts?.columns,
        );
      } else {
        await convertNdjsonToParquet(stagingNdjson, stagingParquet, opts?.columns);
      }

      // ─── Upload to Blob ──────────────────────────────────────────────
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
      if (downloadedExisting) await fs.unlink(existingParquet).catch(() => undefined);
    }
  }
}

async function blobExists(blockBlob: { exists(): Promise<boolean> }): Promise<boolean> {
  try { return await blockBlob.exists(); } catch { return false; }
}

// ─── DuckDB helpers (mirror LocalFileWarehouseWriter) ─────────────────────
type ColumnSchema = ReadonlyArray<{ name: string; sqlType: string }>;

/** See ParquetWriter.readJsonExpr — kept in sync; library-isolated copy. */
function readJsonExpr(escNdPath: string, columns?: ColumnSchema): string {
  if (columns && columns.length > 0) {
    const struct = columns
      .filter((c) => isSafeColumnName(c.name) && isSafeSqlType(c.sqlType))
      .map((c) => `'${c.name}': '${c.sqlType}'`)
      .join(', ');
    if (struct.length > 0) {
      return `read_json('${escNdPath}', format='newline_delimited', columns={${struct}})`;
    }
  }
  return `read_json('${escNdPath}', format='newline_delimited', auto_detect=true)`;
}

function isSafeSqlType(t: string): boolean {
  return /^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|DOUBLE|REAL|DECIMAL\(\d+,\d+\)|BOOLEAN|DATE|TIMESTAMP|TIMESTAMPTZ|UUID|BLOB)$/.test(t);
}

async function convertNdjsonToParquet(
  ndjsonPath: string,
  parquetPath: string,
  columns?: ColumnSchema,
): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    const escNd = ndjsonPath.replace(/'/g, "''");
    const escPq = parquetPath.replace(/'/g, "''");
    await db.all(`
      COPY (
        SELECT * FROM ${readJsonExpr(escNd, columns)}
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

/**
 * Empty parquet with a connector-supplied schema. Same shape as the
 * ParquetWriter mirror — see that file for the validation rationale.
 */
async function writeEmptyParquetWithSchema(
  parquetPath: string,
  schema: ReadonlyArray<{ name: string; sqlType: string }>,
): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    const esc = parquetPath.replace(/'/g, "''");
    const projections = schema.map((col, i) => {
      const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name) && col.name.length <= 128 ? col.name : `col_${i}`;
      const safeType = /^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|DOUBLE|REAL|DECIMAL\(\d+,\d+\)|BOOLEAN|DATE|TIMESTAMP|TIMESTAMPTZ|UUID|BLOB)$/.test(col.sqlType) ? col.sqlType : 'VARCHAR';
      return `NULL::${safeType} AS "${safeName.replace(/"/g, '""')}"`;
    }).join(', ');
    await db.all(`
      COPY (SELECT ${projections} WHERE FALSE)
      TO '${esc}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

/**
 * Merge an NDJSON delta into an existing Parquet, writing to `outPath`.
 * Same shape as the local writer's merge — see ParquetWriter.ts for the
 * detailed comment. Lives here too because the BlobSasWarehouseWriter
 * runs in the sandboxed sync-worker container, which has no shared
 * library imports with the main backend (egress + library isolation).
 */
async function mergeNdjsonIntoExistingParquet(
  ndjsonPath: string,
  existingParquetPath: string,
  outPath: string,
  mergeKey: string,
  columns?: ColumnSchema,
): Promise<void> {
  // The Blob writer's `existingParquetPath` is already a tmpdir-local
  // file (the downloadToFile result), so no further staging copy is
  // needed — the file Azure SDK created is exclusively ours.
  const db = await Database.create(':memory:');
  try {
    const escNd = ndjsonPath.replace(/'/g, "''");
    const escEx = existingParquetPath.replace(/'/g, "''");
    const escOut = outPath.replace(/'/g, "''");
    const escKey = mergeKey.replace(/"/g, '""');
    const deltaExpr = readJsonExpr(escNd, columns);

    // Mirror of ParquetWriter's NULL-key guard. PARTITION BY treats each
    // NULL as a distinct partition, so a merge with NULL business keys
    // silently produces one duplicate per sync. Fail loudly instead.
    const nullCheck = await db.all(
      `SELECT COUNT(*) AS n FROM ${deltaExpr} WHERE "${escKey}" IS NULL`,
    ) as Array<{ n: number | bigint }>;
    const nullCount = Number(nullCheck[0]?.n ?? 0);
    if (nullCount > 0) {
      throw new Error(
        `Merge refused: ${nullCount} delta row(s) have NULL in business-key column '${mergeKey}'. ` +
        `Merging with NULL keys would silently produce duplicates on every sync.`,
      );
    }

    await db.all(`
      COPY (
        WITH delta AS (
          SELECT * FROM ${deltaExpr}
        ),
        existing AS (
          SELECT * FROM read_parquet('${escEx}')
        ),
        merged AS (
          SELECT *, 0 AS _origin FROM existing
          UNION ALL BY NAME
          SELECT *, 1 AS _origin FROM delta
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY "${escKey}"
            ORDER BY _origin DESC
          ) AS _rn
          FROM merged
        )
        SELECT * EXCLUDE (_origin, _rn) FROM ranked WHERE _rn = 1
      )
      TO '${escOut}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

// ─── Validation ──────────────────────────────────────────────────────────
function isSafeTableName(name: string): boolean {
  return /^[A-Za-z0-9_\-]+$/.test(name) && name.length <= 128 && !name.startsWith('-');
}

function isSafeColumnName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 128;
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
