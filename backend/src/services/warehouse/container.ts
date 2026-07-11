/**
 * Azure Blob container lifecycle for the warehouse.
 *
 * Only relevant in per-tenant-container mode (WAREHOUSE_CONTAINER_MODE=
 * per-tenant). In shared mode the single 'warehouse' container is created by
 * Terraform and these helpers are no-ops.
 *
 * Why the backend (not the worker) provisions containers: creating a container
 * is an account-level operation. The worker only ever holds a container-scoped
 * SAS with write+create permission on *blobs* — it cannot create the container
 * itself. So the backend's managed identity (which must hold a role allowing
 * `.../blobServices/containers/write`, e.g. Storage Blob Data Contributor)
 * ensures the container exists before it hands the worker a SAS, and before a
 * product transformation writes there.
 *
 * NOTE: the Azure paths here can only be exercised against a real storage
 * account — they are guarded behind the per-tenant flag (default off) and the
 * Azure-mode check, so shipping them changes nothing until the flag is set.
 * Validate in a staging Azure environment before flipping the flag on.
 */

import { logger as rootLogger } from '../../utils/logger';
import { isAzureMode, warehouseContainer, warehouseContainerMode } from './paths';

const log = rootLogger.child({ mod: 'warehouse-container' });

/** True when we are in Azure mode AND per-tenant containers are enabled. */
export function perTenantContainersActive(): boolean {
  return isAzureMode() && warehouseContainerMode() === 'per-tenant';
}

/**
 * Lazily build a BlobServiceClient from the account's connection string (the
 * same credential DuckDB uses to read/write). Returns null when no connection
 * string is configured. Kept out of module scope so the Azure SDK only loads
 * when a container operation is actually attempted.
 */
async function blobServiceFromConnStr(): Promise<import('@azure/storage-blob').BlobServiceClient | null> {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    log.warn('AZURE_STORAGE_CONNECTION_STRING not set — cannot manage warehouse containers');
    return null;
  }
  const { BlobServiceClient } = await import('@azure/storage-blob');
  return BlobServiceClient.fromConnectionString(connStr);
}

// Remember containers we've already ensured this process lifetime, so the
// common hot path (repeat syncs/transforms for the same tenant) skips the
// round-trip. Cleared on restart — createIfNotExists is idempotent anyway.
const ensured = new Set<string>();

/**
 * Ensure the tenant's warehouse container exists. No-op unless per-tenant
 * containers are active. Best-effort and idempotent; a failure here is
 * logged and rethrown so the caller can decide (a sync/transform that can't
 * guarantee its container should not proceed to write).
 */
export async function ensureWarehouseContainer(tenantId: number): Promise<void> {
  if (!perTenantContainersActive()) return;
  const container = warehouseContainer(tenantId);
  if (ensured.has(container)) return;

  const service = await blobServiceFromConnStr();
  if (!service) return; // no creds → let the write path surface the real error

  const client = service.getContainerClient(container);
  await client.createIfNotExists();
  ensured.add(container);
  log.info({ tenantId, container }, 'ensured warehouse container');
}

/**
 * Delete a tenant's entire warehouse container — the offboarding primitive.
 * Only valid in per-tenant-container mode (in shared mode a tenant's data is
 * interleaved with others under a path prefix, so use `deleteWarehousePaths`
 * on the tenant's prefixes instead — this refuses, to avoid nuking the shared
 * container). Returns true if a container was deleted.
 */
export async function deleteTenantWarehouseContainer(tenantId: number): Promise<boolean> {
  if (!perTenantContainersActive()) {
    throw new Error(
      'deleteTenantWarehouseContainer requires WAREHOUSE_CONTAINER_MODE=per-tenant; ' +
      'in shared mode delete the tenant prefixes with deleteWarehousePaths instead.',
    );
  }
  const container = warehouseContainer(tenantId);
  const service = await blobServiceFromConnStr();
  if (!service) return false;

  const client = service.getContainerClient(container);
  const res = await client.deleteIfExists();
  ensured.delete(container);
  log.info({ tenantId, container, deleted: res.succeeded }, 'deleted warehouse container');
  return res.succeeded;
}
