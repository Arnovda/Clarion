/**
 * Azure Container Apps Job launcher.
 *
 * The production counterpart to `LocalProcessJobLauncher`. Instead of
 * spawning a child process, it triggers an ephemeral Container Apps Job
 * execution — Azure spins up a fresh container, runs ONE sync, and tears
 * the container down on completion.
 *
 * Same `JobLauncher` interface; same `WorkerEvent` semantics; same
 * connector code. Two differences vs local:
 *
 *   1. Env vars are passed via the Mgmt API's `template.containers[0].env`
 *      override on `JobsClient.beginStartAndWait(...)`.
 *
 *   2. Live events come back via an APPEND-BLOB the worker mirrors into
 *      (the orchestrator polls it). Container Apps Jobs don't expose
 *      stdout to the Mgmt API in real-time — the heartbeat blob is the
 *      canonical channel for live progress. The same blob also serves as
 *      the audit record after completion.
 *
 * This file contains the launcher contract; SAS issuance lives in
 * `BlobSasTokenIssuer.ts` because it's reused by other code paths.
 *
 * Operational notes (verify when deploying — I can't reach Azure from
 * here):
 *   • The Container App Job must already exist in the env; we only START
 *     executions, we don't define the job. See infra/main.tf addition.
 *   • Backend's managed identity needs `Container Apps Contributor` on the
 *     job and `Storage Blob Data Contributor` on the warehouse + heartbeat
 *     containers.
 *   • Egress for the worker job is restricted via the Container Apps env
 *     NSG to: connector-specific FQDNs + Azure Storage + Azure Monitor.
 *     Per-connector egress profiles are deferred (one shared NSG today;
 *     fork later when a customer needs strict per-tenant egress).
 */

import {
  ContainerAppsAPIClient,
  type EnvironmentVar,
  type JobExecution,
} from '@azure/arm-appcontainers';
import { DefaultAzureCredential } from '@azure/identity';
import { AppendBlobClient } from '@azure/storage-blob';
import { isWorkerEvent, EXIT_CANCELLED, EXIT_ERROR, EXIT_OK, type WorkerEvent } from '@databridge/connectors';
import { logger as rootLogger } from '../utils/logger';
import type { JobHandle, JobLauncher, JobSpec } from './JobLauncher';

const log = rootLogger.child({ mod: 'azure-job-launcher' });

export interface AzureLauncherConfig {
  subscriptionId: string;
  resourceGroup: string;
  /** Name of the Container App Job (the *job*, not the *execution*). */
  jobName: string;
  /**
   * Async callback the orchestrator implements. Returns a SAS URL the
   * worker can write to. Two URLs needed per sync: one for warehouse
   * Parquet uploads, one for the heartbeat append-blob. The orchestrator's
   * `BlobSasTokenIssuer` typically backs this.
   */
  issueSas: (req: {
    purpose: 'warehouse' | 'heartbeat';
    syncRunId: string;
    connectionId: string;
    /** Path scope inside the container (e.g. `conn_42/` or `runs/123/`). */
    pathPrefix: string;
    /** Lifetime of the URL in minutes. Should be longer than the longest sync we'll run. */
    ttlMinutes: number;
  }) => Promise<string>;
  /**
   * Storage account + container names the heartbeat append-blob lives in.
   * Used to construct the AppendBlobClient that POLLS the heartbeat —
   * separate from the SAS URL given to the worker (which only has write
   * permissions, scoped to the run's path).
   */
  heartbeatContainer: {
    storageAccount: string;
    container: string;
  };
}

export class AzureContainerAppsJobLauncher implements JobLauncher {
  private readonly client: ContainerAppsAPIClient;

  constructor(private readonly cfg: AzureLauncherConfig) {
    this.client = new ContainerAppsAPIClient(new DefaultAzureCredential(), cfg.subscriptionId);
  }

  launch(spec: JobSpec, onEvent: (event: WorkerEvent) => void): JobHandle {
    let executionName: string | null = null;
    let pollerStopped = false;
    const seenLines = { count: 0 }; // mutable cursor into the heartbeat blob

    const done: Promise<{ exitCode: number }> = (async () => {
      try {
        // ─── Issue SAS URLs (orchestrator → Azure Storage) ────────────
        const warehousePathPrefix = `conn_${spec.connectionId}/`;
        const heartbeatPathPrefix = `runs/${spec.syncRunId}/`;
        const warehouseSas = await this.cfg.issueSas({
          purpose: 'warehouse',
          syncRunId: spec.syncRunId,
          connectionId: spec.connectionId,
          pathPrefix: warehousePathPrefix,
          ttlMinutes: 90,
        });
        const heartbeatSas = await this.cfg.issueSas({
          purpose: 'heartbeat',
          syncRunId: spec.syncRunId,
          connectionId: spec.connectionId,
          pathPrefix: `${heartbeatPathPrefix}heartbeat.ndjson`,
          ttlMinutes: 90,
        });

        // ─── Build env-var overrides for the job execution ────────────
        const envOverrides: EnvironmentVar[] = [
          { name: 'WORKER_CONNECTOR_TYPE',   value: spec.connectorType },
          { name: 'WORKER_CONNECTOR_CONFIG', value: JSON.stringify(spec.connectorConfig) },
          { name: 'WORKER_ENTITIES',         value: spec.entities.join(',') },
          { name: 'WORKER_TENANT_ID',        value: spec.tenantId },
          { name: 'WORKER_CONNECTION_ID',    value: spec.connectionId },
          { name: 'WORKER_SYNC_RUN_ID',      value: spec.syncRunId },
          // The warehouse path encodes both the SAS URL and the path-prefix
          // scope in the URL fragment — see worker/src/main.ts:makeWarehouseWriter.
          { name: 'WORKER_WAREHOUSE_PATH', value: `${warehouseSas}#${warehousePathPrefix}` },
          // Heartbeat: the SAS URL points directly at the append-blob.
          { name: 'WORKER_HEARTBEAT_URL', value: heartbeatSas },
        ];

        // ─── Start the Job execution ──────────────────────────────────
        log.info({ syncRunId: spec.syncRunId }, 'starting Container Apps Job execution');
        const startRes = await this.client.jobs.beginStartAndWait(
          this.cfg.resourceGroup,
          this.cfg.jobName,
          {
            template: {
              containers: [{
                // The Job's existing container definition (image, resources)
                // stays in place; we only override env. Container Apps merges
                // these onto the base template.
                name: 'sync-worker',
                env: envOverrides,
              }],
            },
          },
        );
        executionName = (startRes as JobExecution).name ?? null;
        if (!executionName) throw new Error('Container Apps did not return an execution name');
        log.info({ executionName, syncRunId: spec.syncRunId }, 'execution started');

        // ─── Poll heartbeat blob for events + execution status ────────
        const heartbeat = new AppendBlobClient(
          // We construct a READ-only blob URL using the orchestrator's own
          // managed identity (DefaultAzureCredential) — no SAS needed for
          // our side because the backend has Storage Blob Data Reader on
          // the heartbeat container.
          `https://${this.cfg.heartbeatContainer.storageAccount}.blob.core.windows.net/${this.cfg.heartbeatContainer.container}/${heartbeatPathPrefix}heartbeat.ndjson`,
          new DefaultAzureCredential(),
        );

        while (!pollerStopped) {
          // (1) Drain any new heartbeat lines.
          await drainHeartbeat(heartbeat, seenLines, onEvent);

          // (2) Check execution status.
          const execStatus = await this.fetchExecutionStatus(executionName);
          if (execStatus === 'Succeeded') {
            // Final drain to catch the `result` event that lands right before exit.
            await drainHeartbeat(heartbeat, seenLines, onEvent);
            return { exitCode: EXIT_OK };
          }
          if (execStatus === 'Failed' || execStatus === 'Stopped') {
            await drainHeartbeat(heartbeat, seenLines, onEvent);
            return { exitCode: execStatus === 'Stopped' ? EXIT_CANCELLED : EXIT_ERROR };
          }
          // Still running — sleep + retry.
          await sleep(2_000);
        }
        return { exitCode: EXIT_CANCELLED };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'error', ts: new Date().toISOString(), message: `Launcher failure: ${message}` });
        return { exitCode: EXIT_ERROR };
      }
    })();

    return {
      done,
      cancel: () => {
        pollerStopped = true;
        if (executionName) {
          // Fire-and-forget — we don't wait for the stop to land before
          // resolving the handle. The poll loop has already noted
          // pollerStopped and will resolve with EXIT_CANCELLED.
          // Note: stop-execution lives on the Jobs operations group
          // (not JobsExecutions) — the SDK exposes it as `jobs.beginStopExecutionAndWait`.
          this.client.jobs
            .beginStopExecutionAndWait(this.cfg.resourceGroup, this.cfg.jobName, executionName)
            .catch((err) => log.warn({ err, executionName }, 'failed to stop job execution'));
        }
      },
    };
  }

  /**
   * The SDK only exposes `jobsExecutions.list(...)` (no per-execution `.get`),
   * so we paginate and find the row by name. Lists are short (Container Apps
   * keeps recent executions) and we only call this once every 2s during a
   * sync — overhead is negligible.
   */
  private async fetchExecutionStatus(executionName: string): Promise<string | undefined> {
    try {
      const iter = this.client.jobsExecutions.list(this.cfg.resourceGroup, this.cfg.jobName);
      for await (const exec of iter) {
        if (exec.name === executionName) return exec.status;
      }
      return undefined;
    } catch (err) {
      log.warn({ err, executionName }, 'failed to fetch execution status; assuming still running');
      return undefined;
    }
  }
}

// ─── Heartbeat polling ────────────────────────────────────────────────────
/**
 * Read whatever the worker has appended since our last poll. Tracks a
 * line cursor in the `seen` parameter so we don't re-emit events.
 */
async function drainHeartbeat(
  blob: AppendBlobClient,
  seen: { count: number },
  onEvent: (event: WorkerEvent) => void,
): Promise<void> {
  try {
    const exists = await blob.exists();
    if (!exists) return;
    const buf = await blob.downloadToBuffer();
    const lines = buf.toString('utf-8').split('\n').filter((l) => l.length > 0);
    const newLines = lines.slice(seen.count);
    seen.count = lines.length;
    for (const line of newLines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isWorkerEvent(parsed)) onEvent(parsed);
      } catch {
        // Malformed line — ignore. Could be a partial write the next poll catches.
      }
    }
  } catch (err) {
    log.debug({ err }, 'heartbeat poll failure (will retry)');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
