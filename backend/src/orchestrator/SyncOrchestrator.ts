/**
 * Sync orchestrator — bridges DataBridge's domain (connections, tenants,
 * source_sync_runs, schema profiler) to the connector framework via a
 * `JobLauncher`. The launcher decides WHERE the sync runs (local child
 * process today, Container Apps Job tomorrow); this orchestrator is
 * concerned only with the BEFORE (load + decrypt) and AFTER (persist +
 * profile) steps, plus translating worker events into DB updates.
 *
 * Lifecycle:
 *   1. trigger() inserts a `source_sync_runs` row, marks status='queued',
 *      kicks off background execution, returns immediately.
 *   2. Background task: load connection, decrypt config, build a JobSpec,
 *      call launcher.launch(...), stream events:
 *        • progress + entity_complete → update row_counts heartbeat
 *        • credential_rotated → re-encrypt + persist atomically
 *        • result/error/cancelled → final status update
 *   3. On success, kick off schema profiling so the new tables surface
 *      in /catalog automatically.
 *
 * Concurrency: a connection has at most one running sync. Triggering
 * while another is in flight returns the in-flight run id.
 *
 * Cancellation: each running sync has a `JobHandle.cancel()` registered;
 * callers invoke it via `requestCancellation(syncRunId)`. Local launcher
 * sends SIGTERM to the child; Azure launcher (Day 6) stops the Job
 * execution. Worker catches SIGTERM and aborts cleanly.
 */

import path from 'path';
import { semanticDb } from '../db/knex';
import { encryptCredentials, decryptCredentials } from '../utils/crypto';
import { logger as rootLogger } from '../utils/logger';
import {
  EXIT_CANCELLED,
  EXIT_OK,
  type ConnectorConfig,
  type WorkerEvent,
} from '@databridge/connectors';
import {
  LocalProcessJobLauncher,
  type JobHandle,
  type JobLauncher,
  type JobSpec,
} from './JobLauncher';

const log = rootLogger.child({ mod: 'sync-orchestrator' });

// Path layout matches existing conn_900 + the rest of the warehouse.
const WAREHOUSE_ROOT = path.resolve(__dirname, '../../../warehouse');

/**
 * Resolve the warehouse path that DuckDB should read from after a sync.
 *
 * Path scheme — `tenant_<tid>/conn_<cid>/<table>/data.parquet` — defends
 * tenant isolation in two ways:
 *   1. Even though Azure SAS is container-scoped (no native path-prefix
 *      restriction), the tenant prefix means a buggy connector that
 *      writes outside its `conn_<cid>/` prefix would still stay within
 *      its own tenant's subtree.
 *   2. Operational clarity — listing the storage container shows one
 *      directory per tenant, making access audits + lifecycle policies
 *      straightforward.
 *
 *   • Azure mode: `az://<container>/tenant_<tid>/conn_<cid>`
 *   • Local mode: `<repo>/warehouse/tenant_<tid>/conn_<cid>`
 *
 * The mode is determined by env: `AZURE_CONTAINER_APPS_JOB_NAME` set
 * means Azure.
 */
function computeWarehousePathForDuckDB(connectionId: number, tenantId: number): string {
  const tenantSeg = `tenant_${tenantId}`;
  const connSeg = `conn_${connectionId}`;
  const isAzureMode = !!process.env.AZURE_CONTAINER_APPS_JOB_NAME;
  if (isAzureMode) {
    const container = process.env.AZURE_WAREHOUSE_CONTAINER ?? 'warehouse';
    return `az://${container}/${tenantSeg}/${connSeg}`;
  }
  return path.join(WAREHOUSE_ROOT, tenantSeg, connSeg);
}

// ─── Launcher selection ──────────────────────────────────────────────────
/**
 * Picks the right launcher based on environment.
 *
 *   • If `AZURE_CONTAINER_APPS_JOB_NAME` is set, syncs run as ephemeral
 *     Container Apps Job executions (production / Azure mode).
 *   • Otherwise, syncs run as child Node processes on the same host
 *     (local dev mode).
 *
 * The instance is built lazily on first use so we only require the Azure
 * SDK to load when actually needed.
 *
 * Tests can override via `setJobLauncher()`.
 */
let launcherInstance: JobLauncher | null = null;
export function setJobLauncher(launcher: JobLauncher): void {
  launcherInstance = launcher;
}
function getLauncher(): JobLauncher {
  if (launcherInstance) return launcherInstance;
  launcherInstance = createLauncherFromEnv();
  return launcherInstance;
}

function createLauncherFromEnv(): JobLauncher {
  const azureJobName = process.env.AZURE_CONTAINER_APPS_JOB_NAME;
  if (!azureJobName) {
    log.info('using LocalProcessJobLauncher (set AZURE_CONTAINER_APPS_JOB_NAME for Azure mode)');
    return new LocalProcessJobLauncher();
  }
  // Lazy-import the Azure launcher so the Azure SDK only loads when used.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { AzureContainerAppsJobLauncher } = require('./AzureContainerAppsJobLauncher');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { issueWarehouseOrHeartbeatSas } = require('./BlobSasTokenIssuer');
  log.info({ jobName: azureJobName }, 'using AzureContainerAppsJobLauncher');
  return new AzureContainerAppsJobLauncher({
    subscriptionId: requireEnv('AZURE_SUBSCRIPTION_ID'),
    resourceGroup: requireEnv('AZURE_RESOURCE_GROUP'),
    jobName: azureJobName,
    heartbeatContainer: {
      storageAccount: requireEnv('AZURE_HEARTBEAT_STORAGE_ACCOUNT'),
      container: requireEnv('AZURE_HEARTBEAT_CONTAINER'),
    },
    issueSas: issueWarehouseOrHeartbeatSas,
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name} (needed when AZURE_CONTAINER_APPS_JOB_NAME is set)`);
  }
  return v;
}

// ─── triggerSync ─────────────────────────────────────────────────────────
export interface TriggerSyncResult {
  syncRunId: number;
  /** True if we started a new run; false if we returned an in-flight one. */
  started: boolean;
}

export async function triggerSync(args: {
  connectionId: number;
  tenantId: number;
  triggeredByUserId?: number;
}): Promise<TriggerSyncResult> {
  const { connectionId, tenantId, triggeredByUserId } = args;

  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  const conn = await semanticDb('connections')
    .where({ id: connectionId, tenant_id: tenantId })
    .first();
  if (!conn) throw new Error(`Connection ${connectionId} not found for this tenant`);
  if (!conn.connector_type) {
    throw new Error(`Connection ${connectionId} is not a source-connector connection — nothing to sync`);
  }
  if (!Array.isArray(conn.selected_entities) || conn.selected_entities.length === 0) {
    throw new Error('Connection has no selected entities — nothing to sync');
  }

  const inFlight = await semanticDb('source_sync_runs')
    .where({ connection_id: connectionId, tenant_id: tenantId })
    .whereIn('status', ['queued', 'running'])
    .orderBy('id', 'desc')
    .first();
  if (inFlight) {
    log.info({ connectionId, syncRunId: inFlight.id }, 'sync already in flight');
    return { syncRunId: inFlight.id, started: false };
  }

  const [insertedId] = await semanticDb('source_sync_runs')
    .insert({
      tenant_id: tenantId,
      connection_id: connectionId,
      status: 'queued',
      triggered_by_user_id: triggeredByUserId ?? null,
    })
    .returning('id');
  const syncRunId: number =
    typeof insertedId === 'object' ? (insertedId as { id: number }).id : (insertedId as number);

  log.info({ connectionId, syncRunId, tenantId }, 'sync queued');

  setImmediate(() => {
    void runSyncInBackground({ syncRunId, connectionId, tenantId }).catch((e) => {
      log.error({ err: e, syncRunId }, 'unexpected error in runSyncInBackground');
    });
  });

  return { syncRunId, started: true };
}

// ─── Background execution ────────────────────────────────────────────────
async function runSyncInBackground(args: {
  syncRunId: number;
  connectionId: number;
  tenantId: number;
}): Promise<void> {
  const { syncRunId, connectionId, tenantId } = args;
  const childLog = log.child({ syncRunId, connectionId, tenantId });

  // Local accumulators — kept in memory to avoid one DB round trip per
  // worker event. Flushed on terminal events + every progress tick.
  const rowCounts: Record<string, number> = {};
  const warnings: string[] = [];
  let errorMessage: string | null = null;
  let logExcerpt = '';

  try {
    await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

    // Mark running. Loaded fresh after to make sure connector_config_encrypted
    // wasn't cleared between queue + start (defence in depth).
    await semanticDb('source_sync_runs')
      .where({ id: syncRunId, tenant_id: tenantId })
      .update({ status: 'running', started_at: semanticDb.fn.now() });
    await semanticDb('connections')
      .where({ id: connectionId, tenant_id: tenantId })
      .update({ last_sync_status: 'running' });

    const conn = await semanticDb('connections')
      .where({ id: connectionId, tenant_id: tenantId })
      .first();
    if (!conn) throw new Error('Connection vanished mid-sync');
    if (!conn.connector_type) throw new Error('connector_type was cleared mid-sync');
    if (!conn.connector_config_encrypted) throw new Error('connector_config_encrypted is missing');

    const config: ConnectorConfig = JSON.parse(decryptCredentials(conn.connector_config_encrypted));
    const entities: string[] = Array.isArray(conn.selected_entities) ? conn.selected_entities : [];
    // Two distinct paths matter here:
    //   • `localWarehousePath`: what the LocalProcessJobLauncher tells the
    //     worker to write to. Only used in local-dev mode; the Azure
    //     launcher overrides with its own SAS URL.
    //   • `duckdbReadPath`: what we persist on `connections.warehouse_path`
    //     so DuckDB can read the data later. In Azure mode this is an
    //     `az://` URL; in local mode it's the same filesystem path.
    const localWarehousePath = path.join(WAREHOUSE_ROOT, `tenant_${tenantId}`, `conn_${connectionId}`);
    const duckdbReadPath = computeWarehousePathForDuckDB(connectionId, tenantId);

    const jobSpec: JobSpec = {
      connectorType: conn.connector_type,
      connectorConfig: config,
      entities,
      tenantId: String(tenantId),
      connectionId: String(connectionId),
      syncRunId: String(syncRunId),
      warehousePath: localWarehousePath,
    };

    childLog.info({ entities }, 'launching sync worker');

    // Last DB-flush timestamp for progress events — we batch heartbeats so
    // a chatty connector doesn't hammer the DB.
    let lastFlushAt = 0;
    const FLUSH_EVERY_MS = 1500;

    const handle: JobHandle = getLauncher().launch(jobSpec, (event) => {
      handleWorkerEvent({
        event,
        rowCounts,
        warnings,
        onLogLine: (line) => { logExcerpt = (logExcerpt + line + '\n').slice(-10_000); },
        onCredentialRotated: (newConfig) => {
          // Fire-and-forget re-encrypt; if it fails the next sync will fail
          // and we'll discover it then. Log loudly either way.
          (async () => {
            try {
              const reencrypted = encryptCredentials(JSON.stringify(newConfig));
              await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
              await semanticDb('connections')
                .where({ id: connectionId, tenant_id: tenantId })
                .update({ connector_config_encrypted: reencrypted });
              childLog.info('rotated credential persisted');
            } catch (err) {
              childLog.error({ err }, 'CRITICAL: failed to persist rotated credential — next sync may fail');
            }
          })().catch(() => undefined);
        },
        onError: (msg) => { errorMessage = msg; },
      });

      // Heartbeat flush — best-effort, swallow errors.
      if (event.type === 'progress' || event.type === 'entity_complete') {
        const now = Date.now();
        if (now - lastFlushAt >= FLUSH_EVERY_MS) {
          lastFlushAt = now;
          (async () => {
            try {
              await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
              await semanticDb('source_sync_runs')
                .where({ id: syncRunId, tenant_id: tenantId })
                .update({ row_counts: JSON.stringify(rowCounts) });
            } catch { /* heartbeat swallowed */ }
          })().catch(() => undefined);
        }
      }
    });

    // Register cancellation handle so requestCancellation(syncRunId) can hit it.
    cancellationHandles.set(syncRunId, { handle, tenantId });

    const { exitCode } = await handle.done;
    cancellationHandles.delete(syncRunId);

    // Map exit code → final status. The worker's `result`/`error`/`cancelled`
    // event already populated `rowCounts` / `errorMessage`. Exit code is the
    // backstop for "worker died silently" — covered by the launcher's
    // synthetic error event.
    if (exitCode === EXIT_OK) {
      childLog.info({ rowCounts }, 'sync succeeded');
      // Defence in depth — every UPDATE includes tenant_id alongside the PK
      // so a misconfigured app.current_tenant can't accidentally cross
      // tenant boundaries even if RLS isn't enabled in the deployment.
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'succeeded',
          completed_at: semanticDb.fn.now(),
          row_counts: JSON.stringify(rowCounts),
          warnings: JSON.stringify(warnings),
          log_excerpt: logExcerpt || null,
        });
      await semanticDb('connections')
        .where({ id: connectionId, tenant_id: tenantId })
        .update({
          last_sync_status: 'succeeded',
          last_synced_at: semanticDb.fn.now(),
          // Persist the path DuckDB will read from — `az://...` in Azure,
          // local FS path in dev. NOT the localWarehousePath above (that's
          // only what we passed to the local launcher).
          warehouse_path: duckdbReadPath,
          query_engine: 'duckdb',
        });

      // Fire-and-forget profiling. Sync is already counted as succeeded —
      // a profiler failure is its own concern, not a sync failure.
      void runProfilerInBackground({ connectionId, tenantId }).catch((e) => {
        childLog.error({ err: e }, 'schema profiling failed (sync still counted as succeeded)');
      });
    } else if (exitCode === EXIT_CANCELLED) {
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'cancelled',
          completed_at: semanticDb.fn.now(),
          row_counts: JSON.stringify(rowCounts),
          warnings: JSON.stringify(warnings),
          log_excerpt: logExcerpt || null,
        });
      await semanticDb('connections')
        .where({ id: connectionId, tenant_id: tenantId })
        .update({ last_sync_status: 'cancelled' });
    } else {
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'failed',
          completed_at: semanticDb.fn.now(),
          row_counts: JSON.stringify(rowCounts),
          warnings: JSON.stringify(warnings),
          error_message: (errorMessage ?? `Worker exited with code ${exitCode}`).slice(0, 4000),
          log_excerpt: logExcerpt || null,
        });
      await semanticDb('connections')
        .where({ id: connectionId, tenant_id: tenantId })
        .update({ last_sync_status: 'failed' });
    }
  } catch (e) {
    cancellationHandles.delete(syncRunId);
    const message = e instanceof Error ? e.message : String(e);
    childLog.error({ err: e }, 'orchestrator-side error');
    try {
      await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'failed',
          completed_at: semanticDb.fn.now(),
          error_message: message.slice(0, 4000),
        });
      await semanticDb('connections')
        .where({ id: connectionId, tenant_id: tenantId })
        .update({ last_sync_status: 'failed' });
    } catch (persistErr) {
      childLog.error({ err: persistErr }, 'failed to persist orchestrator-side failure');
    }
  }
}

// ─── Worker event dispatch ───────────────────────────────────────────────
function handleWorkerEvent(args: {
  event: WorkerEvent;
  rowCounts: Record<string, number>;
  warnings: string[];
  onLogLine: (line: string) => void;
  onCredentialRotated: (newConfig: Record<string, unknown>) => void;
  onError: (msg: string) => void;
}): void {
  const { event, rowCounts, warnings, onLogLine, onCredentialRotated, onError } = args;
  switch (event.type) {
    case 'started':
      onLogLine(`[started]`);
      return;
    case 'log':
      onLogLine(`[${event.level}] ${event.msg}`);
      return;
    case 'progress':
      if (event.perEntity) {
        for (const [name, p] of Object.entries(event.perEntity)) {
          if (typeof p.rowsFetched === 'number') rowCounts[name] = p.rowsFetched;
        }
      }
      return;
    case 'entity_complete':
      rowCounts[event.entity] = event.rowsWritten;
      return;
    case 'credential_rotated':
      onCredentialRotated(event.newConfig);
      return;
    case 'result':
      // Result is authoritative — overwrite anything we accumulated from
      // progress events.
      Object.assign(rowCounts, event.rowCounts);
      warnings.push(...event.warnings);
      return;
    case 'error':
      onError(event.message);
      onLogLine(`[ERROR] ${event.message}${event.stack ? `\n${event.stack}` : ''}`);
      return;
    case 'cancelled':
      onLogLine('[cancelled]');
      return;
  }
}

// ─── Cancellation registry ───────────────────────────────────────────────
// Stores tenant_id alongside the handle so a guessed sync_run_id from
// another tenant can't cancel our run. The route layer also passes the
// caller's tenantId to `requestCancellation` for cross-check.
interface CancellationEntry { handle: JobHandle; tenantId: number }
const cancellationHandles = new Map<number, CancellationEntry>();

/**
 * Mark an in-flight sync as cancelled, but only if the caller's tenant
 * owns the run. Returns:
 *   • `'cancelled'` — handle found, tenant matched, cancel signal sent
 *   • `'not_found'` — no in-flight handle for this run
 *   • `'forbidden'` — handle found but tenant doesn't match (HTTP 404 from
 *     the route layer to avoid leaking existence)
 */
export function requestCancellation(syncRunId: number, tenantId: number): 'cancelled' | 'not_found' | 'forbidden' {
  const entry = cancellationHandles.get(syncRunId);
  if (!entry) return 'not_found';
  if (entry.tenantId !== tenantId) return 'forbidden';
  entry.handle.cancel();
  return 'cancelled';
}

// ─── Schema profiling trigger ────────────────────────────────────────────
async function runProfilerInBackground(args: {
  connectionId: number;
  tenantId: number;
}): Promise<void> {
  const { connectionId, tenantId } = args;
  const { runSchemaProfiler } = await import('../semantic/SchemaProfiler');
  // Lazy-import the progress-percentage helper to keep this orchestrator
  // self-contained; the helper is the same one /api/connections/:id/profile
  // uses for its SSE updates so the wizard's progress bar maths match.
  const { profilingProgressPct } = await import('../routes/connections');
  await semanticDb.raw(`SET app.current_tenant = '${Number(tenantId)}'`);

  // Mark running so the UI can render "Analysing…" instead of guessing.
  // Mirrors the existing POST /api/connections/:id/profile flow exactly,
  // so the frontend's existing polling logic just works.
  await semanticDb('connections')
    .where({ id: connectionId, tenant_id: tenantId })
    .update({
      profiling_status: 'running',
      profiling_phase: 'schema',
      profiling_message: 'Starting profiling…',
      profiling_progress: 0,
      profiling_started_at: new Date().toISOString(),
    });

  try {
    await runSchemaProfiler(connectionId, null, (p) => {
      log.debug({ connectionId, phase: p.phase, msg: p.message }, 'profiler progress');
      // Best-effort persistence of progress — never break the profiler if
      // the DB write hiccups.
      semanticDb('connections')
        .where({ id: connectionId, tenant_id: tenantId })
        .update({
          profiling_phase: p.phase,
          profiling_message: p.message,
          profiling_progress: profilingProgressPct(p.phase, p.tableIndex, p.tableCount),
        })
        .catch(() => undefined);
    });

    await semanticDb('connections')
      .where({ id: connectionId, tenant_id: tenantId })
      .update({
        profiling_status: 'done',
        profiling_phase: 'done',
        profiling_message: 'Profiling complete',
        profiling_progress: 100,
        last_profiled_at: new Date().toISOString(),
      });
    log.info({ connectionId }, 'schema profiling complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Profiling failed';
    log.error({ err, connectionId }, 'schema profiling failed');
    await semanticDb('connections')
      .where({ id: connectionId, tenant_id: tenantId })
      .update({
        profiling_status: 'error',
        profiling_phase: 'error',
        profiling_message: msg,
        profiling_progress: 0,
      })
      .catch(() => undefined);
    // Re-throw so the orchestrator's caller-side .catch() can log too.
    throw err;
  }
}
