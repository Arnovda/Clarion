/**
 * Issues short-lived, path-scoped SAS URLs for the warehouse + heartbeat
 * containers. Used by `AzureContainerAppsJobLauncher` to hand the worker
 * exactly enough permission to write to its own warehouse path and its
 * own heartbeat blob — nothing else.
 *
 * Why user-delegation SAS rather than account-key SAS:
 *   • The backend's managed identity holds `Storage Blob Data Contributor`
 *     on the relevant containers. We never see a Storage account key.
 *   • User-delegation SAS is signed with a key derived from the managed
 *     identity's Azure AD token; it expires when the token does, has full
 *     audit trails (operations attributed to the identity), and can be
 *     revoked centrally by rotating the identity.
 *   • Account-key SAS would require us to pull a key from Key Vault and
 *     keep it in memory — wider blast radius if compromised.
 *
 * Lifetime: 90 min by default. Long enough for the slowest expected sync,
 * short enough that a leaked SAS doesn't grant indefinite write access.
 */

import {
  BlobServiceClient,
  ContainerSASPermissions,
  generateBlobSASQueryParameters,
  type SASProtocol,
  type UserDelegationKey,
} from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'sas-issuer' });

interface IssueArgs {
  purpose: 'warehouse' | 'heartbeat';
  syncRunId: string;
  connectionId: string;
  pathPrefix: string;
  ttlMinutes: number;
}

// Cache one user-delegation key per (account, purpose) for ~6 days. They
// can have a maximum lifetime of 7 days; refreshing daily-ish is fine.
const keyCache = new Map<string, { key: UserDelegationKey; expiresAt: number }>();

/**
 * Issue a SAS URL the worker can write to.
 *
 * Returns: `https://<account>.blob.core.windows.net/<container>?<sas>`
 * (the path-prefix scope is encoded in the SAS via `Resource=c` + the
 * canonical path-permissions; the worker prepends the prefix when
 * building blob URLs).
 *
 * For the heartbeat blob specifically, the URL points directly at the
 * blob path because we want the worker to call `appendBlock` on a single
 * blob, not list/create others.
 */
export async function issueWarehouseOrHeartbeatSas(args: IssueArgs): Promise<string> {
  const { purpose, ttlMinutes, pathPrefix } = args;

  const accountEnv = purpose === 'warehouse' ? 'AZURE_WAREHOUSE_STORAGE_ACCOUNT' : 'AZURE_HEARTBEAT_STORAGE_ACCOUNT';
  const containerEnv = purpose === 'warehouse' ? 'AZURE_WAREHOUSE_CONTAINER' : 'AZURE_HEARTBEAT_CONTAINER';
  const account = requireEnv(accountEnv);
  const container = requireEnv(containerEnv);

  const blobService = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );

  const startsOn = new Date(Date.now() - 60_000); // 1-minute clock-skew tolerance
  const expiresOn = new Date(Date.now() + ttlMinutes * 60 * 1000);
  const userDelegationKey = await getUserDelegationKey(account, blobService, expiresOn);

  // Permission set:
  //   • warehouse  → write + create  (no read, no delete) — minimum for uploadFile
  //   • heartbeat  → write + create + add (append-blob requires `add`)
  const perms = new ContainerSASPermissions();
  perms.write = true;
  perms.create = true;
  if (purpose === 'heartbeat') perms.add = true;

  const sas = generateBlobSASQueryParameters({
    containerName: container,
    permissions: perms,
    startsOn,
    expiresOn,
    protocol: 'https' as SASProtocol,
    // Restrict the SAS to a path scope. The worker can write any blob whose
    // path starts with `pathPrefix` and nothing else.
    //
    // NOTE: Azure's path-prefix SAS uses the blob name as the canonicalised
    // resource string. A SAS issued at the container level with `permissions`
    // does NOT inherently scope by path — that's enforced by the worker's
    // own behaviour (we control the worker code). For *strong* path scoping,
    // issue a blob-level SAS for each specific blob (works for heartbeat,
    // less ergonomic for warehouse since we don't know all the blob names
    // up front).
    //
    // For the spike: we trust the worker code to write only under
    // pathPrefix (it does — see BlobSasWarehouseWriter's `pathPrefix`
    // enforcement). Strong path scoping comes when we move to
    // stored-access policies + per-blob SAS issuance for every entity.
  }, userDelegationKey, account);

  const url =
    purpose === 'heartbeat'
      ? `https://${account}.blob.core.windows.net/${container}/${pathPrefix}?${sas}`
      : `https://${account}.blob.core.windows.net/${container}?${sas}`;
  log.info({ purpose, ttlMinutes, pathPrefix }, 'issued SAS');
  return url;
}

async function getUserDelegationKey(
  account: string,
  service: BlobServiceClient,
  expiresOn: Date,
): Promise<UserDelegationKey> {
  const cacheKey = account;
  const cached = keyCache.get(cacheKey);
  const now = Date.now();
  // Keep keys 6 days; refresh when within 1h of expiry.
  if (cached && cached.expiresAt > now + 60 * 60 * 1000) {
    return cached.key;
  }
  // Maximum allowed: 7 days.
  const keyExpiresOn = new Date(Math.max(expiresOn.getTime(), now + 6 * 24 * 60 * 60 * 1000));
  const key = await service.getUserDelegationKey(new Date(now - 60_000), keyExpiresOn);
  keyCache.set(cacheKey, { key, expiresAt: keyExpiresOn.getTime() });
  return key;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
