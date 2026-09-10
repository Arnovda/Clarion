/**
 * Parquet writers — sandboxed warehouse writers connectors use to land data.
 *
 * Two production implementations behind one `WarehouseWriter` interface:
 *
 *   • LocalFileWarehouseWriter — writes to a local filesystem path. Used in
 *     local dev and tests. Same on-disk layout as production so Clarion's
 *     existing DuckDBConnector reads it without modification.
 *
 *   • BlobSasWarehouseWriter — writes to Azure Blob via a SAS-scoped client.
 *     Same interface; just swaps the storage backend.
 *
 * Every DuckDB operation the two share lives in `parquetOps.ts` (phase 2:
 * one merge, one soft-delete rule, one row count). This file is only the
 * local-filesystem plumbing around it: staging, swapping files into place,
 * and the Windows-lock dance documented inline.
 *
 * Why DuckDB as the writer:
 *   • Already a dependency of Clarion — no new native binding to ship.
 *   • DuckDB's `COPY (...) TO '<path>' (FORMAT 'parquet')` is faster and more
 *     correct than any pure-JS Parquet writer.
 *   • Schema inference from JSON is built in — connectors can write
 *     heterogeneous row shapes and DuckDB widens types reasonably.
 *
 * Streaming model: writeTable(...) accepts an AsyncIterable of rows. We
 * batch rows in-memory up to BATCH_ROWS, then write a Parquet file
 * containing all batches via a temp NDJSON staging file → DuckDB COPY.
 * DuckDB's Node binding has no streaming append API for Parquet; staging
 * through NDJSON is fast (DuckDB reads NDJSON natively at GB/s) and copes
 * with sparse / heterogeneous row shapes without an Arrow schema.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { TableWriteResult, WarehouseWriter, WriteTableOptions } from './types';
import {
  convertNdjsonToParquet,
  countAliveRows,
  finalizeFullSyncFile,
  isSafeColumnName,
  isSafeTableName,
  jsonLine,
  mergeNdjsonIntoExistingParquet,
  reconcileKeysFile,
  writeEmptyParquet,
  writeEmptyParquetWithSchema,
} from './parquetOps';

const BATCH_ROWS = 5_000;

// ─── Local filesystem writer ──────────────────────────────────────────────
export class LocalFileWarehouseWriter implements WarehouseWriter {
  /**
   * @param warehouseRoot Absolute path to the warehouse root.
   *                       Final layout: <warehouseRoot>/<tableName>/data.parquet
   */
  constructor(private readonly warehouseRoot: string) {
    if (!path.isAbsolute(warehouseRoot)) {
      throw new Error(`warehouseRoot must be absolute, got: ${warehouseRoot}`);
    }
  }

  private tablePath(tableName: string): string {
    return path.join(this.warehouseRoot, tableName, 'data.parquet');
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

    const outFile = this.tablePath(tableName);
    await fs.mkdir(path.dirname(outFile), { recursive: true });

    const stagingPath = path.join(os.tmpdir(), `clarion-stage-${randomUUID()}.ndjson`);
    const rowsWritten = await stageRows(stagingPath, rows);

    // Merge mode: a mergeKey AND an existing file → existing UPSERT delta on
    // the key. Existing rows whose key is absent from the delta are KEPT —
    // a delete is only ever recorded by `finalizeFullSync` / `reconcileKeys`,
    // never inferred from a delta's silence.
    const existingPath = await fileExists(outFile) ? outFile : null;
    const useMerge = !!opts?.mergeKey && existingPath !== null && !opts?.replace;

    try {
      if (rowsWritten === 0 && !useMerge && existingPath !== null && !opts?.replace) {
        // An EMPTY batch on the overwrite path over an EXISTING table: keep
        // what is there (P0-6). A transient empty response must not wipe a
        // table the customer's dashboards read; a genuinely emptied source
        // table is cleared by a full re-sync.
        const stat = await fs.stat(outFile);
        return {
          rowsWritten: 0,
          bytesWritten: stat.size,
          warehousePath: path.relative(this.warehouseRoot, outFile),
          preservedExisting: true,
          rowsTotal: await countAliveRows(outFile),
        };
      }

      if (rowsWritten === 0 && !useMerge) {
        // Empty entity, nothing to preserve. With a schema from the connector
        // (OData $metadata, fields_get, …) write a parquet WITH those columns
        // so the catalog can show them; otherwise the legacy placeholder.
        const emptyCols = opts?.emptySchema?.length ? opts.emptySchema : opts?.columns;
        if (emptyCols && emptyCols.length > 0) {
          await writeEmptyParquetWithSchema(outFile, emptyCols);
        } else {
          await writeEmptyParquet(outFile);
        }
      } else if (useMerge) {
        await this.rewriteInPlace(outFile, (existingCopy, tmpOut) =>
          mergeNdjsonIntoExistingParquet(stagingPath, existingCopy, tmpOut, opts!.mergeKey!, opts?.columns));
      } else {
        await convertNdjsonToParquet(stagingPath, outFile, opts?.columns);
      }
    } finally {
      await fs.unlink(stagingPath).catch(() => undefined);
    }

    const stat = await fs.stat(outFile);
    return {
      rowsWritten,
      bytesWritten: stat.size,
      warehousePath: path.relative(this.warehouseRoot, outFile),
      rowsTotal: rowsWritten === 0 && !useMerge ? 0 : await countAliveRows(outFile),
    };
  }

  async finalizeFullSync(tableName: string, opts: { syncStartedAt: string }): Promise<{ tombstoned: number; rowsTotal: number }> {
    if (!isSafeTableName(tableName)) throw new Error(`Unsafe table name: ${tableName}`);
    const outFile = this.tablePath(tableName);
    if (!await fileExists(outFile)) return { tombstoned: 0, rowsTotal: 0 };
    let result = { tombstoned: 0, rowsTotal: 0 };
    await this.rewriteInPlace(outFile, async (existingCopy, tmpOut) => {
      result = await finalizeFullSyncFile(existingCopy, tmpOut, opts.syncStartedAt);
    });
    return result;
  }

  async reconcileKeys(
    tableName: string,
    keyColumn: string,
    keys: AsyncIterable<string | number>,
  ): Promise<{ tombstoned: number; revived: number; rowsTotal: number; refusedEmpty?: boolean }> {
    if (!isSafeTableName(tableName)) throw new Error(`Unsafe table name: ${tableName}`);
    if (!isSafeColumnName(keyColumn)) throw new Error(`Unsafe key column: ${keyColumn}`);
    const outFile = this.tablePath(tableName);
    if (!await fileExists(outFile)) return { tombstoned: 0, revived: 0, rowsTotal: 0 };
    const keysPath = path.join(os.tmpdir(), `clarion-keys-${randomUUID()}.ndjson`);
    await stageRows(keysPath, mapKeys(keys));
    let result: { tombstoned: number; revived: number; rowsTotal: number; refusedEmpty?: boolean } = { tombstoned: 0, revived: 0, rowsTotal: 0 };
    try {
      await this.rewriteInPlace(outFile, async (existingCopy, tmpOut) => {
        result = await reconcileKeysFile(existingCopy, tmpOut, keyColumn, keysPath);
        return !result.refusedEmpty;
      });
    } finally {
      await fs.unlink(keysPath).catch(() => undefined);
    }
    return result;
  }

  /**
   * Run `op` on a COPY of the existing parquet, writing to a tmpdir-staged
   * output, then move the output into place. Copying first is deliberate:
   * on Windows DuckDB holds a directory-level lock on the existing file's
   * folder past `db.close()`, so staging far away then doing one final move
   * sidesteps the EPERM. Linux/Mac don't need it; cheap insurance everywhere.
   * `op` may return false to say "keep the existing file" (nothing to swap).
   */
  private async rewriteInPlace(
    outFile: string,
    op: (existingCopy: string, tmpOut: string) => Promise<void | boolean>,
  ): Promise<void> {
    const existingCopy = path.join(os.tmpdir(), `clarion-existing-${randomUUID()}.parquet`);
    const tmpOut = path.join(os.tmpdir(), `clarion-merge-${randomUUID()}.parquet`);
    await fs.copyFile(outFile, existingCopy);
    try {
      const swap = await op(existingCopy, tmpOut);
      if (swap === false) return;
      // Delete-then-rename rather than overwrite-rename — Windows EPERM
      // otherwise. Worst case if the rename fails: the table is briefly
      // absent and the next sync rewrites it from its cursor.
      await fs.unlink(outFile).catch(() => undefined);
      await fs.rename(tmpOut, outFile);
    } finally {
      await fs.unlink(existingCopy).catch(() => undefined);
      await fs.unlink(tmpOut).catch(() => undefined);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
/** Stream rows to an NDJSON file in batches; returns the row count. */
export async function stageRows(stagingPath: string, rows: AsyncIterable<Record<string, unknown>>): Promise<number> {
  let rowsWritten = 0;
  const fh = await fs.open(stagingPath, 'w');
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
  return rowsWritten;
}

/** Keys as `{k}` rows for `reconcileKeysFile`. */
export async function* mapKeys(keys: AsyncIterable<string | number>): AsyncIterable<Record<string, unknown>> {
  for await (const k of keys) yield { k: typeof k === 'number' ? String(k) : k };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
