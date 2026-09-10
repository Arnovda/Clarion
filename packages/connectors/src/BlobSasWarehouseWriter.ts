/**
 * SAS-scoped Azure Blob warehouse writer.
 *
 * The companion to `LocalFileWarehouseWriter` for cloud deployment.
 * Same `WarehouseWriter` interface; same Parquet output shape; same
 * call-site code in connectors. Only difference: Parquet bytes land in
 * Azure Blob Storage instead of the local filesystem.
 *
 * Security model:
 *   • The orchestrator generates a short-lived user-delegation SAS URL for
 *     the warehouse container and hands it to the worker.
 *   • The worker NEVER sees a Storage account key. All writes go through
 *     the SAS encoded in the URL.
 *   • Path confinement to `tenant_<tid>/conn_<cid>/` is enforced HERE: every
 *     write prepends `pathPrefix` and `isSafeTableName` rejects traversal.
 *     IMPORTANT: the SAS today is CONTAINER-scoped, so this is a code-level
 *     guarantee, not a storage-level one — Azure will NOT 403 an
 *     out-of-prefix path. Strong per-path scoping (per-blob SAS, an
 *     HNS-directory SAS, or a per-tenant container) is a tracked infra
 *     follow-up; until then do not weaken the pathPrefix/table-name guards.
 *
 * Pipeline:
 *   1. Stream rows → NDJSON file in the container's tmpdir (same as local
 *      writer — bounded memory, streaming friendly).
 *   2. Run the shared DuckDB operation (`parquetOps.ts`) → a local Parquet.
 *   3. Upload the Parquet file to Blob via the SAS URL.
 *   4. Delete the local tmp files.
 *
 * Why DuckDB→local-Parquet→Blob rather than DuckDB→Blob directly:
 *   • DuckDB's azure extension expects credentials in a different format
 *     than SAS URLs and would need broader permissions than this writer's
 *     per-connection scope.
 *   • Two stages keeps the trust surface small: DuckDB only writes to
 *     local disk; only `@azure/storage-blob` ever talks to Azure.
 *
 * Cost, stated plainly: every merge, finalisation and reconcile DOWNLOADS
 * the whole table and UPLOADS the whole result — O(table) per entity per
 * sync. That is the phase-2 B1 finding (see the ingestion-chain assessment)
 * and the reason the table format is being replaced; this writer is the
 * conservative path until then.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ContainerClient } from '@azure/storage-blob';
import type { TableWriteResult, WarehouseWriter, WriteTableOptions } from './types';
import {
  convertNdjsonToParquet,
  countAliveRows,
  finalizeFullSyncFile,
  isSafeColumnName,
  isSafeTableName,
  mergeNdjsonIntoExistingParquet,
  reconcileKeysFile,
  writeEmptyParquet,
  writeEmptyParquetWithSchema,
} from './parquetOps';
import { mapKeys, stageRows } from './ParquetWriter';

export class BlobSasWarehouseWriter implements WarehouseWriter {
  private readonly container: ContainerClient;
  private readonly pathPrefix: string;

  /**
   * @param sasUrl  Container-scoped SAS URL the orchestrator issued.
   *                Format: `https://<account>.blob.core.windows.net/<container>?<sas>`.
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

  private blobPath(tableName: string): string {
    return `${this.pathPrefix}${tableName}/data.parquet`;
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
    const blobPath = this.blobPath(tableName);
    const blockBlob = this.container.getBlockBlobClient(blobPath);

    let downloadedExisting = false;
    try {
      const rowsWritten = await stageRows(stagingNdjson, rows);

      // Merge or overwrite? A mergeKey AND an existing blob → download it and
      // run the shared merge; otherwise overwrite.
      let useMerge = false;
      if (opts?.mergeKey && !opts?.replace) {
        if (await blobExists(blockBlob)) {
          await blockBlob.downloadToFile(existingParquet);
          downloadedExisting = true;
          useMerge = true;
        }
      }

      if (rowsWritten === 0 && !useMerge && !opts?.replace && await blobExists(blockBlob)) {
        // Empty batch, overwrite path, table exists: keep it (P0-6 — same
        // rule as the local writer; a full re-sync clears it).
        const props = await blockBlob.getProperties();
        let rowsTotal: number | undefined;
        try {
          await blockBlob.downloadToFile(existingParquet);
          downloadedExisting = true;
          rowsTotal = await countAliveRows(existingParquet);
        } catch { /* the count is a nicety; the preserved table is the point */ }
        return {
          rowsWritten: 0,
          bytesWritten: Number(props.contentLength ?? 0),
          warehousePath: blobPath,
          preservedExisting: true,
          ...(rowsTotal !== undefined ? { rowsTotal } : {}),
        };
      }

      if (rowsWritten === 0 && !useMerge) {
        const emptyCols = opts?.emptySchema?.length ? opts.emptySchema : opts?.columns;
        if (emptyCols && emptyCols.length > 0) {
          await writeEmptyParquetWithSchema(stagingParquet, emptyCols);
        } else {
          await writeEmptyParquet(stagingParquet);
        }
      } else if (useMerge) {
        await mergeNdjsonIntoExistingParquet(stagingNdjson, existingParquet, stagingParquet, opts!.mergeKey!, opts?.columns);
      } else {
        await convertNdjsonToParquet(stagingNdjson, stagingParquet, opts?.columns);
      }

      const stat = await fs.stat(stagingParquet);
      await blockBlob.uploadFile(stagingParquet);
      return {
        rowsWritten,
        bytesWritten: stat.size,
        warehousePath: blobPath,
        rowsTotal: rowsWritten === 0 && !useMerge ? 0 : await countAliveRows(stagingParquet),
      };
    } finally {
      await fs.unlink(stagingNdjson).catch(() => undefined);
      await fs.unlink(stagingParquet).catch(() => undefined);
      if (downloadedExisting) await fs.unlink(existingParquet).catch(() => undefined);
    }
  }

  async finalizeFullSync(tableName: string, opts: { syncStartedAt: string }): Promise<{ tombstoned: number; rowsTotal: number }> {
    if (!isSafeTableName(tableName)) throw new Error(`Unsafe table name: ${tableName}`);
    let result = { tombstoned: 0, rowsTotal: 0 };
    await this.rewriteBlob(tableName, async (existing, out) => {
      result = await finalizeFullSyncFile(existing, out, opts.syncStartedAt);
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
    const keysPath = path.join(os.tmpdir(), `clarion-keys-${randomUUID()}.ndjson`);
    await stageRows(keysPath, mapKeys(keys));
    let result: { tombstoned: number; revived: number; rowsTotal: number; refusedEmpty?: boolean } = { tombstoned: 0, revived: 0, rowsTotal: 0 };
    try {
      await this.rewriteBlob(tableName, async (existing, out) => {
        result = await reconcileKeysFile(existing, out, keyColumn, keysPath);
        return !result.refusedEmpty;
      });
    } finally {
      await fs.unlink(keysPath).catch(() => undefined);
    }
    return result;
  }

  /** Download → `op` → upload. `op` may return false to leave the blob untouched. No blob → no-op. */
  private async rewriteBlob(
    tableName: string,
    op: (existingLocal: string, outLocal: string) => Promise<void | boolean>,
  ): Promise<void> {
    const blockBlob = this.container.getBlockBlobClient(this.blobPath(tableName));
    if (!await blobExists(blockBlob)) return;
    const existing = path.join(os.tmpdir(), `clarion-existing-${randomUUID()}.parquet`);
    const out = path.join(os.tmpdir(), `clarion-out-${randomUUID()}.parquet`);
    try {
      await blockBlob.downloadToFile(existing);
      const upload = await op(existing, out);
      if (upload === false) return;
      await blockBlob.uploadFile(out);
    } finally {
      await fs.unlink(existing).catch(() => undefined);
      await fs.unlink(out).catch(() => undefined);
    }
  }
}

async function blobExists(blockBlob: { exists(): Promise<boolean> }): Promise<boolean> {
  try { return await blockBlob.exists(); } catch { return false; }
}

function isSafePathPrefix(prefix: string): boolean {
  // Allow alphanum, _, -, /, no leading/trailing whitespace, no .. traversal.
  return /^[A-Za-z0-9_\-/]+$/.test(prefix) && !prefix.includes('..');
}
