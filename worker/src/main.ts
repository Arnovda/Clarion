/**
 * Sync-worker entrypoint.
 *
 * This is the entire worker — instantiate connector, build context, run
 * sync, emit IPC events to stdout, exit. No HTTP server, no database,
 * no schedulers. The orchestrator (in the backend) holds all the state.
 *
 * Lifecycle:
 *   1. Parse env (Zod-validated, exit 1 on failure).
 *   2. Build a `SyncContext` whose:
 *        • `warehouseWriter` is a `LocalFileWarehouseWriter` rooted at the
 *          path the orchestrator gave us (= `warehouse/conn_<id>/`)
 *        • `log` emits redacted JSON-line `log` events on stdout
 *        • `progress` emits `progress` events on stdout
 *        • `cancellationToken` flips on SIGTERM (the orchestrator's
 *          cancel signal in both local and Container Apps modes)
 *        • `onCredentialRotated` emits a `credential_rotated` event
 *          back to stdout — the orchestrator catches it, re-encrypts,
 *          and persists. Worker never persists anything itself.
 *   3. Run `connector.sync(...)`.
 *   4. Emit `result` event, exit EXIT_OK.
 *   5. On error, emit `error` event, exit EXIT_ERROR.
 *      On cancel, emit `cancelled`, exit EXIT_CANCELLED.
 *
 * Container Apps note: stdout is captured automatically by Container Apps
 * and forwarded to Log Analytics. The same lines that drive the orchestrator
 * are the audit trail.
 */

import {
  BlobSasWarehouseWriter,
  CancellationError,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  LocalFileWarehouseWriter,
  emitWorkerEvent,
  getConnector,
  type Logger,
  type SyncContext,
  type WarehouseWriter,
  type WorkerEvent,
} from '@databridge/connectors';
// Side-effect import — registers all connectors in the registry.
import '@databridge/connectors';
import { AnonymousCredential, AppendBlobClient } from '@azure/storage-blob';
import * as fs from 'fs/promises';
import { parseEnv } from './env';

async function main(): Promise<void> {
  const env = parseEnv();

  // ─── Resolve connector config ──────────────────────────────────────────
  // Two delivery paths:
  //   • Local launcher → WORKER_CONFIG_FILE (path to a 0600 JSON file the
  //     worker reads once and deletes). A file rather than an env var
  //     because a config can exceed the 128 KB env-var ceiling — a
  //     spreadsheet source carries the workbook — and because env vars are
  //     world-readable via /proc to anything running as the same user.
  //     `WORKER_CONNECTOR_CONFIG` still works and is the legacy path.
  //   • Azure launcher → WORKER_CONFIG_BLOB_URL (read SAS to a private
  //     blob containing the JSON). The credential never appears in the
  //     Container Apps Job execution env, which Azure retains for ~30 days.
  //
  // Exactly one of the two must be present.
  const connectorConfig = await resolveConnectorConfig(env);

  // ─── Heartbeat blob (Azure mode) ───────────────────────────────────────
  // When WORKER_HEARTBEAT_URL is set, every emitted event is mirrored into
  // an append-blob the orchestrator polls. This is how live progress
  // reaches Clarion's UI when the worker runs in Container Apps Jobs.
  let heartbeat: AppendBlobClient | null = null;
  if (env.WORKER_HEARTBEAT_URL) {
    // SAS URL — auth is in the URL itself, so we use AnonymousCredential.
    heartbeat = new AppendBlobClient(env.WORKER_HEARTBEAT_URL, new AnonymousCredential());
    // Create the blob (idempotent — `createIfNotExists` is safe to call repeatedly).
    try {
      await heartbeat.createIfNotExists();
    } catch (err) {
      // If we can't create the heartbeat blob, the sync can still run;
      // we just lose live progress in the UI. Surface a warning + continue.
      // eslint-disable-next-line no-console
      console.error('failed to create heartbeat blob — continuing without live progress:', err);
      heartbeat = null;
    }
  }

  emit({ type: 'started', ts: new Date().toISOString() }, heartbeat);

  // ─── Cancellation token, wired to SIGTERM ──────────────────────────────
  // Both child-process and Container Apps Job cancellation send SIGTERM.
  // We flip the flag and let the running connector observe it on its next
  // cancellation check between API pages.
  let cancelled = false;
  const cancellationToken = {
    get isCancelled() { return cancelled; },
    throwIfCancelled() {
      if (cancelled) throw new CancellationError();
    },
  };
  const onSigterm = () => {
    cancelled = true;
    emit({ type: 'log', ts: new Date().toISOString(), level: 'info', msg: 'SIGTERM received — cancelling sync' }, heartbeat);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  // ─── Logger that streams to stdout as `log` IPC events ─────────────────
  const log: Logger = {
    debug: (msg, fields) => emit({ type: 'log', ts: new Date().toISOString(), level: 'debug', msg, fields }, heartbeat),
    info:  (msg, fields) => emit({ type: 'log', ts: new Date().toISOString(), level: 'info',  msg, fields }, heartbeat),
    warn:  (msg, fields) => emit({ type: 'log', ts: new Date().toISOString(), level: 'warn',  msg, fields }, heartbeat),
    error: (msg, fields) => emit({ type: 'log', ts: new Date().toISOString(), level: 'error', msg, fields }, heartbeat),
  };

  // ─── Warehouse writer ──────────────────────────────────────────────────
  // Today: LocalFileWarehouseWriter targeting an absolute path. Day 6:
  // BlobSasWarehouseWriter when WORKER_WAREHOUSE_PATH is a https:// URL.
  // The fork lives here so the connector code stays storage-agnostic.
  const writer = makeWarehouseWriter(env.WORKER_WAREHOUSE_PATH);

  // ─── Sync context ──────────────────────────────────────────────────────
  const ctx: SyncContext = {
    tenantId: env.WORKER_TENANT_ID,
    connectionId: env.WORKER_CONNECTION_ID,
    warehouseWriter: writer,
    log,
    progress: (msg) => emit({
      type: 'progress',
      ts: new Date().toISOString(),
      message: msg.message,
      perEntity: msg.perEntity,
      percent: msg.percent,
    }, heartbeat),
    cancellationToken,
    onCredentialRotated: async (newConfig) => {
      // Stream the rotated config back to the orchestrator. The orchestrator
      // re-encrypts and persists. We do NOT keep the new config in any
      // worker-side persistence — once this process exits, the only place
      // the new refresh_token lives is the encrypted DB cell.
      emit({ type: 'credential_rotated', ts: new Date().toISOString(), newConfig }, heartbeat);
    },
  };

  // ─── Run the sync ──────────────────────────────────────────────────────
  const connector = getConnector(env.WORKER_CONNECTOR_TYPE);

  try {
    const result = await connector.sync(
      connectorConfig,
      { entities: env.WORKER_ENTITIES, cursors: env.WORKER_CURSORS },
      ctx,
    );
    emit({
      type: 'result',
      ts: new Date().toISOString(),
      rowCounts: result.rowCounts,
      warnings: result.warnings ?? [],
      cursors: result.cursors,
    }, heartbeat);
    process.exit(EXIT_OK);
  } catch (e) {
    if (e instanceof CancellationError) {
      emit({ type: 'cancelled', ts: new Date().toISOString() }, heartbeat);
      process.exit(EXIT_CANCELLED);
    }
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    emit({ type: 'error', ts: new Date().toISOString(), message, stack }, heartbeat);
    process.exit(EXIT_ERROR);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
/**
 * Emit an event to stdout AND, if a heartbeat blob is configured, mirror
 * the same JSON line into it. Heartbeat append failures are swallowed —
 * the sync continues; we just lose live progress on the affected event.
 */
function emit(e: WorkerEvent, heartbeat: AppendBlobClient | null): void {
  emitWorkerEvent(e);
  if (heartbeat) {
    const line = `${JSON.stringify(e)}\n`;
    // Fire-and-forget. We don't await to avoid serialising the connector
    // behind blob round trips; events are append-blob-atomic per call.
    heartbeat.appendBlock(line, line.length).catch(() => {/* swallowed */});
  }
}

/**
 * Pull the connector config from whichever delivery path the launcher
 * chose. Fetches over plain HTTPS using the SAS URL — no Azure SDK
 * dependency, no managed-identity setup needed on the worker container.
 * The SAS is a self-contained capability bound to the blob and expires
 * in 15 min, so a 5-second fetch is well within bounds.
 */
async function resolveConnectorConfig(env: ReturnType<typeof parseEnv>): Promise<Record<string, unknown>> {
  if (env.WORKER_CONFIG_BLOB_URL) {
    const resp = await fetch(env.WORKER_CONFIG_BLOB_URL);
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch staged config blob (HTTP ${resp.status}). ` +
        `Either the SAS expired (15-min TTL) or the orchestrator unstaged the blob prematurely.`,
      );
    }
    const text = await resp.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Staged config blob is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (env.WORKER_CONFIG_FILE) {
    let text: string;
    try {
      text = await fs.readFile(env.WORKER_CONFIG_FILE, 'utf-8');
    } catch (e) {
      throw new Error(`Failed to read the staged config file: ${(e as Error).message}`);
    } finally {
      // Read once, then remove it. The orchestrator also cleans up when the
      // child exits; doing it here as well means the window in which the
      // config sits on disk is the shortest it can be, and a worker that
      // crashes after this point leaves nothing behind.
      await fs.unlink(env.WORKER_CONFIG_FILE).catch(() => undefined);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Staged config file is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (env.WORKER_CONNECTOR_CONFIG) {
    return env.WORKER_CONNECTOR_CONFIG;
  }
  throw new Error(
    'Missing connector config — set WORKER_CONFIG_BLOB_URL (Azure), WORKER_CONFIG_FILE (local) '
    + 'or WORKER_CONNECTOR_CONFIG (legacy).',
  );
}

function makeWarehouseWriter(warehousePath: string): WarehouseWriter {
  // SAS-scoped Blob URL — used in Azure (Container Apps Job mode).
  // Format: `https://<account>.blob.core.windows.net/<container>?<sas>#<pathPrefix>`
  // The fragment carries the path-prefix scope; the SAS portion grants write
  // permission. We split them here to feed the writer's two arguments.
  if (warehousePath.startsWith('https://')) {
    const hashIdx = warehousePath.indexOf('#');
    if (hashIdx < 0) {
      throw new Error(
        'WORKER_WAREHOUSE_PATH SAS URL must include a `#<pathPrefix>` fragment ' +
        'identifying which container path to scope writes to (e.g. `#conn_42/`)',
      );
    }
    const sasUrl = warehousePath.slice(0, hashIdx);
    const pathPrefix = warehousePath.slice(hashIdx + 1);
    return new BlobSasWarehouseWriter(sasUrl, pathPrefix);
  }
  // Local filesystem (dev mode).
  return new LocalFileWarehouseWriter(warehousePath);
}

// ─── Entry ────────────────────────────────────────────────────────────────
main().catch((e) => {
  // This catch only runs if main() rejects synchronously before its own
  // try/catch (e.g. env-validation failure). Emit a structured error so
  // the orchestrator can render it. Heartbeat is null because env
  // parsing failed before we could create one.
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  emit({ type: 'error', ts: new Date().toISOString(), message, stack }, null);
  process.exit(EXIT_ERROR);
});
