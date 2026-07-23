/**
 * Warehouse container-lifecycle tests.
 *
 * Exercises the per-tenant-container branch WITHOUT a real Azure account by
 * mocking @azure/storage-blob. Proves:
 *   - shared mode is a no-op (no SDK call); offboarding refuses.
 *   - per-tenant mode creates the container once (memoised) and deletes it.
 *   - the tenant id maps to the expected container name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Azure SDK mock ---------------------------------------------------------
const createIfNotExists = vi.fn(async () => ({ succeeded: true }));
const deleteIfExists = vi.fn(async () => ({ succeeded: true }));
const getContainerClient = vi.fn((_name: string) => ({ createIfNotExists, deleteIfExists }));
const fromConnectionString = vi.fn((_c: string) => ({ getContainerClient }));

vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString },
}));

const AZURE_MARKER = 'AZURE_CONTAINER_APPS_JOB_NAME';

describe('warehouse container lifecycle', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [AZURE_MARKER, 'WAREHOUSE_CONTAINER_MODE', 'AZURE_STORAGE_CONNECTION_STRING', 'AZURE_WAREHOUSE_CONTAINER_PREFIX']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    createIfNotExists.mockClear();
    deleteIfExists.mockClear();
    getContainerClient.mockClear();
    fromConnectionString.mockClear();
    vi.resetModules();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('shared mode: ensure is a no-op and delete refuses', async () => {
    process.env[AZURE_MARKER] = 'sync-worker'; // Azure mode
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
    // WAREHOUSE_CONTAINER_MODE unset → shared
    const mod = await import('./container');
    expect(mod.perTenantContainersActive()).toBe(false);

    await mod.ensureWarehouseContainer(7);
    expect(fromConnectionString).not.toHaveBeenCalled();
    expect(createIfNotExists).not.toHaveBeenCalled();

    await expect(mod.deleteTenantWarehouseContainer(7)).rejects.toThrow(/per-tenant/);
  });

  it('per-tenant mode: creates the tenant container once (memoised)', async () => {
    process.env[AZURE_MARKER] = 'sync-worker';
    process.env.WAREHOUSE_CONTAINER_MODE = 'per-tenant';
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
    const mod = await import('./container');
    expect(mod.perTenantContainersActive()).toBe(true);

    await mod.ensureWarehouseContainer(42);
    await mod.ensureWarehouseContainer(42); // memoised — no second SDK round-trip
    expect(getContainerClient).toHaveBeenCalledWith('tenant-42');
    expect(createIfNotExists).toHaveBeenCalledTimes(1);
  });

  it('per-tenant mode: offboarding deletes the tenant container', async () => {
    process.env[AZURE_MARKER] = 'sync-worker';
    process.env.WAREHOUSE_CONTAINER_MODE = 'per-tenant';
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
    const mod = await import('./container');

    const deleted = await mod.deleteTenantWarehouseContainer(99);
    expect(getContainerClient).toHaveBeenCalledWith('tenant-99');
    expect(deleteIfExists).toHaveBeenCalledTimes(1);
    expect(deleted).toBe(true);
  });

  it('per-tenant mode: missing connection string degrades gracefully (no throw)', async () => {
    process.env[AZURE_MARKER] = 'sync-worker';
    process.env.WAREHOUSE_CONTAINER_MODE = 'per-tenant';
    // no AZURE_STORAGE_CONNECTION_STRING
    const mod = await import('./container');
    await expect(mod.ensureWarehouseContainer(5)).resolves.toBeUndefined();
    expect(createIfNotExists).not.toHaveBeenCalled();
  });
});
