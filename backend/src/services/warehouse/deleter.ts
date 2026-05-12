/**
 * Unified deleter for warehouse outputs. Mirrors `writer.ts` on the
 * delete side: callers pass a URI (local path or `az://...`) and we
 * pick the right mechanism.
 *
 * Used by:
 *   - DELETE /api/products/:id        — remove a product's data files
 *   - DELETE /api/connections/:id     — remove a source's ingested files
 *
 * Why this needs to exist:
 *   The old product/connection deletes only cleaned LOCAL files with
 *   `fs.rmSync`. On Azure they silently leaked — the database rows
 *   disappeared but the parquet/delta files stayed in the storage
 *   account, racking up cost and (worse) leaving customer data behind
 *   after a "delete." Audit + GDPR concerns aside, it's just wrong.
 *
 * Failure model: best-effort. We log per-blob failures and continue;
 * caller gets back a count so the audit row can say "deleted N blobs
 * (M failures)" rather than the all-or-nothing "deleted." A failure
 * to remove storage should NEVER block the DB-row deletion — orphan
 * blobs are recoverable (with cost), orphan rows are not.
 */

import fs from 'fs';
import { isAzurePath, parseAzurePath } from './paths';

export interface DeleteResult {
  /** What kind of URI this was. */
  kind: 'local' | 'azure' | 'skipped';
  /** Number of files / blobs actually removed. */
  deleted: number;
  /** Per-file errors (best-effort delete; we log + continue). */
  errors: string[];
}

/**
 * Recursively delete the data at `uri`. Safe to call on a directory
 * that doesn't exist — returns `{ deleted: 0 }` rather than throwing.
 *
 * For Azure URIs we list every blob under the prefix (delta tables
 * are directories of many files: parquet + _delta_log/*) and delete
 * them one at a time. The container is left in place — only the
 * prefix path is removed.
 *
 * For local paths we use `fs.rmSync` with `recursive: true, force:
 * true`, mirroring what the legacy delete code did.
 */
export async function deleteWarehousePath(uri: string): Promise<DeleteResult> {
  if (!uri || typeof uri !== 'string') {
    return { kind: 'skipped', deleted: 0, errors: [] };
  }

  if (isAzurePath(uri)) {
    return deleteAzurePrefix(uri);
  }

  return deleteLocalPath(uri);
}

/** Delete a single URI; tolerates missing files. */
function deleteLocalPath(uri: string): DeleteResult {
  try {
    if (!fs.existsSync(uri)) return { kind: 'local', deleted: 0, errors: [] };
    const stat = fs.statSync(uri);
    fs.rmSync(uri, { recursive: true, force: true });
    return { kind: 'local', deleted: stat.isDirectory() ? 1 : 1, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'local', deleted: 0, errors: [msg] };
  }
}

async function deleteAzurePrefix(azurePath: string): Promise<DeleteResult> {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    return {
      kind: 'azure',
      deleted: 0,
      errors: ['AZURE_STORAGE_CONNECTION_STRING not set — cannot delete Azure blobs'],
    };
  }

  let container: string;
  let prefix: string;
  try {
    ({ container, blob: prefix } = parseAzurePath(azurePath));
  } catch (err) {
    return {
      kind: 'azure',
      deleted: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }

  const { BlobServiceClient } = await import('@azure/storage-blob');
  const svc = BlobServiceClient.fromConnectionString(connStr);
  const containerClient = svc.getContainerClient(container);

  let deleted = 0;
  const errors: string[] = [];

  // Trailing slash so we don't match unrelated prefixes (e.g. deleting
  // tenant_1/product_2 must not delete tenant_1/product_20).
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const listPrefix = trimmed + '/';

  for await (const blob of containerClient.listBlobsFlat({ prefix: listPrefix })) {
    try {
      await containerClient.getBlockBlobClient(blob.name).delete();
      deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${blob.name}: ${msg}`);
    }
  }

  // Also try to delete the exact-prefix blob in case it was uploaded
  // as a single file rather than a directory (e.g. legacy parquet that
  // wasn't a Delta table). This is a no-op if the blob doesn't exist.
  try {
    const single = containerClient.getBlockBlobClient(trimmed);
    if (await single.exists()) {
      await single.delete();
      deleted++;
    }
  } catch {
    // ignore — covered by the prefix scan in most cases
  }

  return { kind: 'azure', deleted, errors };
}

/**
 * Delete multiple paths in sequence. Aggregates counts + errors into a
 * single result for audit logging. Continues after per-path failures.
 */
export async function deleteWarehousePaths(uris: Array<string | null | undefined>): Promise<DeleteResult> {
  const aggregate: DeleteResult = { kind: 'local', deleted: 0, errors: [] };
  let sawAzure = false;
  let sawLocal = false;

  for (const uri of uris) {
    if (!uri) continue;
    const result = await deleteWarehousePath(uri);
    aggregate.deleted += result.deleted;
    aggregate.errors.push(...result.errors);
    if (result.kind === 'azure') sawAzure = true;
    if (result.kind === 'local') sawLocal = true;
  }

  aggregate.kind = sawAzure && sawLocal
    ? 'local'  // mixed; fall back to local (audit ctx carries both anyway)
    : sawAzure
      ? 'azure'
      : 'local';

  return aggregate;
}
