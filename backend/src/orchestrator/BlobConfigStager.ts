/**
 * Stages connector config to a private blob and hands the worker a
 * short-lived read SAS. Replaces the previous practice of passing
 * plaintext credentials via the `WORKER_CONNECTOR_CONFIG` env var on
 * the Container Apps Job execution.
 *
 * Why this matters: Container Apps Job execution metadata (including
 * the env block) is preserved in Azure for ~30 days, visible to anyone
 * with `containerapp job execution show` access. The previous approach
 * meant a freshly-rotated OAuth refresh_token + client_secret sat in
 * a developer-readable structure for a month. Cleartext credentials in
 * a long-retention audit trail is the textbook anti-pattern.
 *
 * The new flow:
 *
 *   1. Backend uploads the plaintext config JSON to a private blob in
 *      the heartbeat container at `runs/<syncRunId>/config.json`. The
 *      blob is encrypted at rest by Azure Storage (SSE, AES-256,
 *      Microsoft-managed keys).
 *   2. Backend issues a BLOB-scoped read-only SAS with a 15-minute TTL.
 *   3. The SAS URL goes in the worker's `WORKER_CONFIG_BLOB_URL` env
 *      var. The SAS URL is a capability — possession grants read on
 *      one specific blob, no listing, no write, no other paths.
 *   4. Worker reads the blob, parses, and uses the config in-memory.
 *   5. After the sync exits (any terminal state), the orchestrator
 *      deletes the blob (`unstage`). Even if the env var leaks via
 *      a log or replicated Azure metadata store, by the time anyone
 *      attempts to use the SAS URL the blob is gone — or the SAS has
 *      expired, whichever comes first.
 *
 * Why not app-layer encryption on top:
 *   Adding AES-256-GCM at the app layer would require distributing
 *   the encryption key to the worker (either via a Container Apps
 *   secretRef → Key Vault, or as another env var defeating the
 *   purpose). Three layers is gold-plated. Azure SSE + private
 *   container + 15-min blob SAS + delete-after-use is the bar Azure
 *   itself recommends for ephemeral inter-service secrets.
 *
 * Local launcher unchanged: `LocalProcessJobLauncher` still passes
 * config via env var in dev (no Azure exposure path). This stager is
 * Azure-only.
 */

import { BlobServiceClient, BlobSASPermissions, generateBlobSASQueryParameters, type SASProtocol, type UserDelegationKey } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'config-stager' });

/**
 * Cached user-delegation key per storage account. Mirrors the cache in
 * BlobSasTokenIssuer — same shape, same 6-day TTL.
 */
const keyCache = new Map<string, { key: UserDelegationKey; expiresAt: number }>();

interface StagedConfig {
  /** SAS URL the worker fetches to obtain its config. */
  blobUrl: string;
  /**
   * Internal handle used by `unstageConfig`. The orchestrator passes it
   * back after the sync exits to delete the blob.
   */
  cleanupHandle: { account: string; container: string; blobName: string };
}

/**
 * Upload `config` as JSON to a private blob and return a read-only SAS
 * URL the worker can fetch. The blob lifetime is bounded by:
 *   • The 15-minute SAS expiry (after that, the URL is useless).
 *   • `unstageConfig` being called when the sync completes.
 *
 * @param config The plaintext connector config (clientSecret, refreshToken, …).
 *               Passed through `JSON.stringify` only — no app-layer encryption.
 * @param syncRunId Used to build a stable, unguessable blob name.
 */
export async function stageConfig(
  config: Record<string, unknown>,
  syncRunId: string,
): Promise<StagedConfig> {
  const account = requireEnv('AZURE_HEARTBEAT_STORAGE_ACCOUNT');
  const container = requireEnv('AZURE_HEARTBEAT_CONTAINER');
  const blobName = `runs/${syncRunId}/config.json`;

  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
  const blobClient = service.getContainerClient(container).getBlockBlobClient(blobName);

  // Upload — backend's managed identity has Storage Blob Data Contributor
  // on the heartbeat container, so we don't need a SAS for the WRITE side.
  const body = JSON.stringify(config);
  await blobClient.upload(body, Buffer.byteLength(body, 'utf-8'), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });

  // Blob-scoped read SAS — bound to this exact blob name, 15 minutes,
  // HTTPS-only. Even if the env var leaks (Azure replication, logging,
  // someone calling `az containerapp job execution show`), the worst
  // anyone can do is fetch this one blob for the next ≤15 min, and the
  // orchestrator deletes it once the sync ends.
  const startsOn = new Date(Date.now() - 60_000); // 1-min clock skew
  const expiresOn = new Date(Date.now() + 15 * 60 * 1000);
  const udk = await getUserDelegationKey(account, service, expiresOn);

  const perms = new BlobSASPermissions();
  perms.read = true;

  const sas = generateBlobSASQueryParameters({
    containerName: container,
    blobName,
    permissions: perms,
    startsOn,
    expiresOn,
    protocol: 'https' as SASProtocol,
  }, udk, account);

  const blobUrl = `https://${account}.blob.core.windows.net/${container}/${blobName}?${sas}`;
  log.info({ syncRunId, blobName, ttlMinutes: 15 }, 'staged connector config to private blob');

  return {
    blobUrl,
    cleanupHandle: { account, container, blobName },
  };
}

/**
 * Delete the staged config blob. Called by the orchestrator after the
 * sync reaches a terminal state (success, failure, cancellation —
 * doesn't matter which, the blob's job is done in all cases).
 *
 * Best-effort: a failure here doesn't fail the sync. Worst case the
 * blob lingers up to the SAS expiry (15 min) and then becomes
 * inaccessible anyway. Azure Storage's blob lifecycle policy on the
 * heartbeat container catches stragglers (7-day delete).
 */
export async function unstageConfig(
  handle: { account: string; container: string; blobName: string },
): Promise<void> {
  try {
    const service = new BlobServiceClient(
      `https://${handle.account}.blob.core.windows.net`,
      new DefaultAzureCredential(),
    );
    await service.getContainerClient(handle.container).getBlockBlobClient(handle.blobName).deleteIfExists();
    log.info({ blobName: handle.blobName }, 'unstaged connector config blob');
  } catch (err) {
    log.warn({ err, blobName: handle.blobName }, 'failed to unstage config blob — will expire on its own');
  }
}

async function getUserDelegationKey(
  account: string,
  service: BlobServiceClient,
  expiresOn: Date,
): Promise<UserDelegationKey> {
  const cached = keyCache.get(account);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60 * 60 * 1000) {
    return cached.key;
  }
  const keyExpiresOn = new Date(Math.max(expiresOn.getTime(), now + 6 * 24 * 60 * 60 * 1000));
  const key = await service.getUserDelegationKey(new Date(now - 60_000), keyExpiresOn);
  keyCache.set(account, { key, expiresAt: keyExpiresOn.getTime() });
  return key;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
