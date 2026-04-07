/**
 * Storage abstraction for warehouse files (Delta Lake / Parquet).
 *
 * In development: reads/writes to local filesystem (default).
 * In production on Azure: reads/writes to Azure Blob Storage.
 *
 * The storage backend is chosen by the AZURE_STORAGE_CONNECTION_STRING env var:
 * - If set → Azure Blob Storage
 * - If not set → local filesystem (WAREHOUSE_ROOT or ./warehouse)
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StorageProvider {
  /** Upload a file from a local path to storage. */
  upload(localPath: string, remotePath: string): Promise<void>;
  /** Download a file from storage to a local path. */
  download(remotePath: string, localPath: string): Promise<void>;
  /** List files/directories under a prefix. */
  list(prefix: string): Promise<string[]>;
  /** Delete a file or directory from storage. */
  delete(remotePath: string): Promise<void>;
  /** Check if a file/directory exists. */
  exists(remotePath: string): Promise<boolean>;
  /** Get the provider type. */
  type: 'local' | 'azure-blob';
}

// ---------------------------------------------------------------------------
// Local filesystem provider
// ---------------------------------------------------------------------------

class LocalStorageProvider implements StorageProvider {
  type = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const dest = path.join(this.root, remotePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const src = path.join(this.root, remotePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.copyFileSync(src, localPath);
  }

  async list(prefix: string): Promise<string[]> {
    const dir = path.join(this.root, prefix);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
  }

  async delete(remotePath: string): Promise<void> {
    const target = path.join(this.root, remotePath);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  async exists(remotePath: string): Promise<boolean> {
    return fs.existsSync(path.join(this.root, remotePath));
  }
}

// ---------------------------------------------------------------------------
// Azure Blob Storage provider
// ---------------------------------------------------------------------------

class AzureBlobStorageProvider implements StorageProvider {
  type = 'azure-blob' as const;
  private readonly connectionString: string;
  private readonly containerName: string;

  constructor(connectionString: string, containerName = 'warehouse') {
    this.connectionString = connectionString;
    this.containerName = containerName;
  }

  private async getClient() {
    // Dynamic import to avoid requiring the SDK when not using Azure
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const blobService = BlobServiceClient.fromConnectionString(this.connectionString);
    const container = blobService.getContainerClient(this.containerName);
    // Ensure container exists
    await container.createIfNotExists();
    return container;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const container = await this.getClient();
    const blob = container.getBlockBlobClient(remotePath);
    await blob.uploadFile(localPath);
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const container = await this.getClient();
    const blob = container.getBlockBlobClient(remotePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await blob.downloadToFile(localPath);
  }

  async list(prefix: string): Promise<string[]> {
    const container = await this.getClient();
    const items: string[] = [];
    for await (const blob of container.listBlobsFlat({ prefix })) {
      items.push(blob.name);
    }
    return items;
  }

  async delete(remotePath: string): Promise<void> {
    const container = await this.getClient();
    // Delete all blobs under the prefix (directory-like delete)
    for await (const blob of container.listBlobsFlat({ prefix: remotePath })) {
      await container.getBlockBlobClient(blob.name).delete();
    }
  }

  async exists(remotePath: string): Promise<boolean> {
    const container = await this.getClient();
    const blob = container.getBlockBlobClient(remotePath);
    return blob.exists();
  }
}

// ---------------------------------------------------------------------------
// Factory — singleton
// ---------------------------------------------------------------------------

let _instance: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (_instance) return _instance;

  const azureConn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (azureConn) {
    console.log('[storage] Using Azure Blob Storage');
    _instance = new AzureBlobStorageProvider(azureConn);
  } else {
    const root = process.env.WAREHOUSE_ROOT ?? path.resolve(__dirname, '../../../warehouse');
    console.log(`[storage] Using local filesystem: ${root}`);
    _instance = new LocalStorageProvider(root);
  }

  return _instance;
}
