/**
 * Sync orchestrator — bridges Clarion's domain (connections, tenants,
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
  redact,
  type ConnectorConfig,
  type WorkerEvent,
} from '@databridge/connectors';
import {
  LocalProcessJobLauncher,
  type JobHandle,
  type JobLauncher,
  type JobSpec,
} from './JobLauncher';
import { sourceBasePathV2, ensureWarehouseContainer } from '../services/warehouse';
import { profilingProgressPct } from '../services/profilingProgress';

const log = rootLogger.child({ mod: 'sync-orchestrator' });

// Path layout matches existing conn_900 + the rest of the warehouse.
const WAREHOUSE_ROOT = path.resolve(__dirname, '../../../warehouse');

/**
 * Hard ceiling on a single sync's wall-clock time. A worker that hangs (stuck
 * socket, infinite loop the cycle-detector misses) is cancelled — and
 * force-killed by the launcher if it ignores the cancel — so a run can never
 * sit in `running` forever and block the connection. Override via env.
 */
const SYNC_MAX_DURATION_MS = Number(process.env.SYNC_MAX_DURATION_MS) || 30 * 60 * 1000;

/**
 * Set the tenant RLS context using a bound parameter (NOT string
 * interpolation). `set_config(..., false)` is session-scoped, equivalent to
 * `SET`. Parameterised so the isolation boundary can't become an injection
 * point if tenant ids ever stop being plain integers.
 */
async function setTenant(tenantId: number): Promise<void> {
  await semanticDb.raw(`SELECT set_config('app.current_tenant', ?, false)`, [String(Number(tenantId))]);
}

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
  const isAzureMode = !!process.env.AZURE_CONTAINER_APPS_JOB_NAME;
  if (isAzureMode) {
    // Delegates to the warehouse path layer so shared vs per-tenant-container
    // mode is decided in one place. Shared mode yields the historical
    // `az://warehouse/tenant_<tid>/conn_<cid>`; per-tenant mode yields
    // `az://tenant-<tid>/conn_<cid>`.
    return sourceBasePathV2(tenantId, connectionId);
  }
  return path.join(WAREHOUSE_ROOT, `tenant_${tenantId}`, `conn_${connectionId}`);
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

// ─── Cursor validation + comparison ───────────────────────────────────────
// Hand-rolled, not Zod, because these run per-entity per-sync and we want
// zero allocation overhead. Both functions are pure + total — they never
// throw, never log; callers decide what to do with a falsy return.

/**
 * Validate a cursor value's surface shape against its declared type.
 * Rejects values that would otherwise surface as opaque EO 400s on the
 * next sync (e.g. a non-ISO string fed back into a `datetime'…'` filter).
 */
function isValidCursorValue(type: string, value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (type === 'timestamp') {
    // ISO 8601 prefix; tolerant of fractional seconds + zone designators.
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(value);
  }
  if (type === 'integer') {
    return /^-?\d+$/.test(value);
  }
  // 'string' — accept anything non-empty within length bounds.
  return type === 'string';
}

/**
 * Returns true when `incoming > existing` per the cursor's declared type.
 * Cursors of different types are NEVER comparable — the platform refuses
 * to advance across a type change, so a connector that switches its
 * cursor scheme can't silently regress its watermark.
 */
function cursorAdvances(type: string, existing: string, incoming: string): boolean {
  if (type === 'integer') {
    const a = Number(existing); const b = Number(incoming);
    return Number.isFinite(a) && Number.isFinite(b) && b > a;
  }
  if (type === 'timestamp') {
    const a = Date.parse(existing); const b = Date.parse(incoming);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    return b > a;
  }
  // 'string' — lexicographic. Documented assumption: caller picks a
  // collation that makes lex comparison meaningful (e.g. zero-padded
  // numeric strings, ISO-8601 dates).
  return incoming > existing;
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

  await setTenant(tenantId);

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

  // The SELECT-then-INSERT above is a TOCTOU race (two concurrent triggers can
  // both pass the SELECT). A partial unique index on (connection_id) WHERE
  // status IN ('queued','running') makes "one in-flight run per connection" a
  // DB-enforced invariant; here we catch the conflict and return the run that
  // won the race instead of erroring.
  let syncRunId: number;
  try {
    const [insertedId] = await semanticDb('source_sync_runs')
      .insert({
        tenant_id: tenantId,
        connection_id: connectionId,
        status: 'queued',
        triggered_by_user_id: triggeredByUserId ?? null,
      })
      .returning('id');
    syncRunId =
      typeof insertedId === 'object' ? (insertedId as { id: number }).id : (insertedId as number);
  } catch (e) {
    // 23505 = unique_violation. Another trigger inserted the in-flight row
    // between our SELECT and INSERT — return it rather than starting a second.
    if ((e as { code?: string }).code === '23505') {
      const winner = await semanticDb('source_sync_runs')
        .where({ connection_id: connectionId, tenant_id: tenantId })
        .whereIn('status', ['queued', 'running'])
        .orderBy('id', 'desc')
        .first();
      if (winner) {
        log.info({ connectionId, syncRunId: winner.id }, 'lost in-flight insert race — returning existing run');
        return { syncRunId: winner.id, started: false };
      }
    }
    throw e;
  }

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
    await setTenant(tenantId);

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

    // ── Load prior cursors for incremental sync ─────────────────────────
    // Per-entity rows from `entity_sync_cursors` for this connection.
    // Defence in depth: explicit `tenant_id` filter alongside RLS.
    // Failures here downgrade the sync to full (logged) — the entity_sync_cursors
    // table being missing or unreadable must not block ingestion.
    let priorCursors: Record<string, { type: 'timestamp' | 'integer' | 'string'; value: string }> = {};
    try {
      const rows = await semanticDb('entity_sync_cursors')
        .where({ tenant_id: tenantId, connection_id: connectionId })
        .select('entity_name', 'cursor_type', 'cursor_value');
      for (const r of rows as Array<{ entity_name: string; cursor_type: string; cursor_value: string }>) {
        // Tight allow-list on cursor_type to match the CHECK constraint.
        if (r.cursor_type === 'timestamp' || r.cursor_type === 'integer' || r.cursor_type === 'string') {
          priorCursors[r.entity_name] = { type: r.cursor_type, value: r.cursor_value };
        }
      }
      childLog.info({ cursorCount: Object.keys(priorCursors).length }, 'loaded prior cursors');
    } catch (err) {
      childLog.warn({ err }, 'failed to load prior cursors — defaulting to full sync');
      priorCursors = {};
    }
    // Two distinct paths matter here:
    //   • `localWarehousePath`: what the LocalProcessJobLauncher tells the
    //     worker to write to. Only used in local-dev mode; the Azure
    //     launcher overrides with its own SAS URL.
    //   • `duckdbReadPath`: what we persist on `connections.warehouse_path`
    //     so DuckDB can read the data later. In Azure mode this is an
    //     `az://` URL; in local mode it's the same filesystem path.
    const localWarehousePath = path.join(WAREHOUSE_ROOT, `tenant_${tenantId}`, `conn_${connectionId}`);
    const duckdbReadPath = computeWarehousePathForDuckDB(connectionId, tenantId);

    // In per-tenant-container mode the worker's SAS is scoped to the tenant's
    // own Blob container, which must exist before we issue that SAS. No-op in
    // shared mode (the single 'warehouse' container is Terraform-managed).
    await ensureWarehouseContainer(tenantId);

    const jobSpec: JobSpec = {
      connectorType: conn.connector_type,
      connectorConfig: config,
      entities,
      tenantId: String(tenantId),
      connectionId: String(connectionId),
      syncRunId: String(syncRunId),
      warehousePath: localWarehousePath,
      cursors: priorCursors,
    };

    childLog.info({ entities }, 'launching sync worker');

    // Last DB-flush timestamp for progress events — we batch heartbeats so
    // a chatty connector doesn't hammer the DB.
    let lastFlushAt = 0;
    const FLUSH_EVERY_MS = 1500;

    // Per-entity new cursors emitted by the connector. We persist these
    // to `entity_sync_cursors` ONLY after the run is recorded as
    // succeeded — per-entity granularity is enforced because the
    // connector only puts a key in here for entities that completed
    // without raising.
    const cursorsOut: Record<string, { type: 'timestamp' | 'integer' | 'string'; value: string }> = {};

    const handle: JobHandle = getLauncher().launch(jobSpec, (event) => {
      handleWorkerEvent({
        event,
        rowCounts,
        warnings,
        cursorsOut,
        onLogLine: (line) => { logExcerpt = (logExcerpt + line + '\n').slice(-10_000); },
        onCredentialRotated: (newConfig) => {
          // Fire-and-forget re-encrypt; if it fails the next sync will fail
          // and we'll discover it then. Log loudly either way.
          (async () => {
            try {
              const reencrypted = encryptCredentials(JSON.stringify(newConfig));
              await setTenant(tenantId);
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
              await setTenant(tenantId);
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

    // Wall-clock guard. If the worker exceeds the ceiling, cancel it (the
    // launcher escalates SIGTERM → SIGKILL). `handle.done` still resolves
    // once the process is gone, so we never leak a `running` row.
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      childLog.error({ maxMs: SYNC_MAX_DURATION_MS }, 'sync exceeded max duration — cancelling worker');
      handle.cancel();
    }, SYNC_MAX_DURATION_MS);

    let exitCode: number;
    try {
      ({ exitCode } = await handle.done);
    } finally {
      clearTimeout(timeoutTimer);
    }
    cancellationHandles.delete(syncRunId);
    if (timedOut && exitCode !== EXIT_OK) {
      errorMessage = errorMessage ?? `Sync exceeded the maximum duration (${Math.round(SYNC_MAX_DURATION_MS / 60000)} min) and was cancelled`;
    }

    // Scrub anything connector/worker-derived before it's persisted + shown in
    // the UI. HttpClient already redacts its error excerpts, but a connector
    // can throw arbitrary strings — defence in depth on the isolation boundary.
    const safeWarnings = warnings.map((w) => redact(w));
    const safeLogExcerpt = logExcerpt ? redact(logExcerpt) : null;

    // Map exit code → final status. The worker's `result`/`error`/`cancelled`
    // event already populated `rowCounts` / `errorMessage`. Exit code is the
    // backstop for "worker died silently" — covered by the launcher's
    // synthetic error event.
    if (exitCode === EXIT_OK) {
      childLog.info({ rowCounts, newCursorCount: Object.keys(cursorsOut).length }, 'sync succeeded');
      // Defence in depth — every UPDATE includes tenant_id alongside the PK
      // so a misconfigured app.current_tenant can't accidentally cross
      // tenant boundaries even if RLS isn't enabled in the deployment.
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'succeeded',
          completed_at: semanticDb.fn.now(),
          row_counts: JSON.stringify(rowCounts),
          warnings: JSON.stringify(safeWarnings),
          log_excerpt: safeLogExcerpt,
        });

      // ── Persist per-entity cursors ──────────────────────────────────
      // Upsert one row per entity that emitted a new cursor. Defensive:
      //   • Validate the cursor value shape per cursor_type before write —
      //     a malformed timestamp passed back as a $filter on the next
      //     sync would surface as an opaque EO 400.
      //   • Refuse to write a cursor that goes backwards. A non-advancing
      //     cursor signals a connector bug (returned a stale value) or
      //     data corruption upstream (EO eventual-consistency edge case).
      //     Either way, silently keeping the old cursor is the safe choice
      //     so the next sync re-reads from the trusted high-water mark.
      //   • Tenant + connection in both INSERT body and WHERE so RLS +
      //     explicit filter both apply.
      // Cursor-persistence failures DO NOT mark the sync as failed —
      // the data is already in the warehouse; worst case the next sync
      // re-pulls some rows (idempotent via merge-by-key).
      for (const [entityName, cursor] of Object.entries(cursorsOut)) {
        try {
          if (!isValidCursorValue(cursor.type, cursor.value)) {
            childLog.error({ entityName, cursorType: cursor.type, cursorValue: cursor.value },
              'connector returned malformed cursor value — refusing to persist (next sync re-reads from prior cursor)');
            continue;
          }
          // Read current value first to enforce monotonicity in app logic
          // (the DB can't easily express "new >= old" in a single
          // INSERT ... ON CONFLICT).
          const existing = await semanticDb('entity_sync_cursors')
            .where({ tenant_id: tenantId, connection_id: connectionId, entity_name: entityName })
            .first() as { cursor_value: string; cursor_type: string } | undefined;
          if (existing && !cursorAdvances(cursor.type, existing.cursor_value, cursor.value)) {
            // Backwards / non-advancing. Loud log so this surfaces in
            // alerting — the data is fine (we just don't advance) but
            // it's evidence of a real bug somewhere.
            childLog.error({
              entityName,
              existingType: existing.cursor_type,
              existing: existing.cursor_value,
              incomingType: cursor.type,
              incoming: cursor.value,
            }, 'CRITICAL: connector returned non-advancing cursor; refusing to update (possible connector bug)');
            continue;
          }
          await semanticDb('entity_sync_cursors')
            .insert({
              tenant_id:        tenantId,
              connection_id:    connectionId,
              entity_name:      entityName,
              cursor_type:      cursor.type,
              cursor_value:     cursor.value,
              rows_synced_last: rowCounts[entityName] ?? 0,
              last_sync_at:     semanticDb.fn.now(),
              last_status:      'success',
              last_error:       null,
              updated_at:       semanticDb.fn.now(),
            })
            .onConflict(['tenant_id', 'connection_id', 'entity_name'])
            .merge({
              cursor_type:      cursor.type,
              cursor_value:     cursor.value,
              rows_synced_last: rowCounts[entityName] ?? 0,
              last_sync_at:     semanticDb.fn.now(),
              last_status:      'success',
              last_error:       null,
              updated_at:       semanticDb.fn.now(),
            });
        } catch (err) {
          childLog.warn({ err, entityName }, 'failed to persist cursor — sync still counted as succeeded');
        }
      }
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
      // Skip when zero rows were written across every entity — profiling
      // an empty warehouse just churns AI tokens and surfaces a "all
      // tables removed" schema-drift notification that's just noise.
      const totalRows = Object.values(rowCounts).reduce((sum, n) => sum + (n || 0), 0);
      if (totalRows > 0) {
        void runProfilerInBackground({ connectionId, tenantId }).catch((e) => {
          childLog.error({ err: e }, 'schema profiling failed (sync still counted as succeeded)');
        });
      } else {
        childLog.info({ connectionId }, 'sync wrote zero rows across all entities — skipping schema profiling');
      }

      // Fire any pipelines configured with `on_source_sync_succeeded`
      // for this connection. Fire-and-forget by design: a missing
      // pipeline or downstream queue failure must NOT mark the source
      // sync as failed (it's already succeeded). Errors are logged
      // inside the helper.
      void import('../jobs/pipelineScheduler').then(({ firePipelineTriggersOnSourceSync }) =>
        firePipelineTriggersOnSourceSync({ connectionId, tenantId }),
      ).catch((e) => {
        childLog.error({ err: e }, 'on-source-sync pipeline triggers failed (sync still counted as succeeded)');
      });
    } else if (exitCode === EXIT_CANCELLED) {
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'cancelled',
          completed_at: semanticDb.fn.now(),
          row_counts: JSON.stringify(rowCounts),
          warnings: JSON.stringify(safeWarnings),
          log_excerpt: safeLogExcerpt,
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
          warnings: JSON.stringify(safeWarnings),
          error_message: redact(errorMessage ?? `Worker exited with code ${exitCode}`).slice(0, 4000),
          log_excerpt: safeLogExcerpt,
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
      await setTenant(tenantId);
      await semanticDb('source_sync_runs')
        .where({ id: syncRunId, tenant_id: tenantId })
        .update({
          status: 'failed',
          completed_at: semanticDb.fn.now(),
          error_message: redact(message).slice(0, 4000),
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
  cursorsOut: Record<string, { type: 'timestamp' | 'integer' | 'string'; value: string }>;
  onLogLine: (line: string) => void;
  onCredentialRotated: (newConfig: Record<string, unknown>) => void;
  onError: (msg: string) => void;
}): void {
  const { event, rowCounts, warnings, cursorsOut, onLogLine, onCredentialRotated, onError } = args;
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
      if (event.cursors) Object.assign(cursorsOut, event.cursors);
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
//
// Cost model:
//   • Default behaviour (AUTO_REPROFILE_ON_SYNC unset or 'false'): every
//     sync runs a CHEAP introspection + hash compare, with NO AI calls.
//     If the structure changed, we emit a notification asking the user to
//     re-profile manually. The user controls when AI tokens are spent.
//   • Opt-in legacy behaviour (AUTO_REPROFILE_ON_SYNC='true'): the post-
//     sync auto-profile fires whenever the hash differs from the stored
//     value, automatically spending ~$0.85 per source per drift event.
//
// Why default-off: routine SaaS source syncs (Exact Online, etc.) almost
// never produce schema changes, but the auto-profile was firing anyway in
// some cases (introspection non-determinism, missing schema_hash, etc.).
// Cost was running into tens of dollars/day for no useful work. The new
// default keeps refreshes free and surfaces drift via notification — the
// user clicks Re-profile when they actually want to spend the tokens.
async function runProfilerInBackground(args: {
  connectionId: number;
  tenantId: number;
}): Promise<void> {
  const { connectionId, tenantId } = args;
  await setTenant(tenantId);

  // Read the current connection state once. We need its stored
  // schema_hash for drift detection, plus the live row to pass into
  // introspectAndHash.
  const conn = await semanticDb('connections')
    .where({ id: connectionId, tenant_id: tenantId })
    .first();
  if (!conn) {
    log.warn({ connectionId }, 'runProfilerInBackground: connection not found, skipping');
    return;
  }

  // Cheap path: introspect + hash. No AI cost.
  let currentHash: string | null = null;
  let nextTables: NormalisedTable[] | null = null;
  try {
    const result = await introspectAndHash(conn);
    currentHash = result.hash;
    nextTables = result.tables ?? null;
  } catch (err) {
    log.warn({ err, connectionId }, 'introspectAndHash failed — skipping post-sync profile work');
    return;
  }

  const existingTablesCount = (await semanticDb('source_tables')
    .where({ connection_id: connectionId, tenant_id: tenantId })
    .count<{ count: string }[]>('id as count')
    .first())?.count ?? '0';
  const existingTables = Number(existingTablesCount);

  // Hash matches stored value AND we already have tables persisted →
  // nothing to do. This is the steady-state branch for routine syncs.
  if (currentHash && conn.schema_hash === currentHash && existingTables > 0) {
    log.info({ connectionId, hash: currentHash }, 'schema unchanged — no profiling needed');
    return;
  }

  // Drift detected (or first sync, or schema_hash never persisted).
  // Decide based on the env var whether to spend AI tokens automatically
  // or just notify the user.
  const autoReprofile = String(process.env.AUTO_REPROFILE_ON_SYNC ?? '').toLowerCase() === 'true';

  if (!autoReprofile) {
    // Opt-out path: emit a notification, persist nothing. The user can
    // click Re-profile manually to update descriptions; that path is
    // unchanged and DOES update schema_hash on success. We don't update
    // schema_hash here on purpose — we want the next sync to also see
    // drift if the user hasn't acted yet (notifications dedupe at read
    // time, and persistent drift is a real signal).
    const driftKind = !conn.schema_hash || existingTables === 0 ? 'first_sync' : 'changed';
    log.info(
      { connectionId, driftKind, currentHash, storedHash: conn.schema_hash, existingTables },
      'AUTO_REPROFILE_ON_SYNC disabled — notifying user instead of auto-profiling',
    );

    const connName = String(conn.name ?? `connection ${connectionId}`);

    // Compute + persist the diff so the user can review before re-profiling.
    // First-sync = no previous shape to diff against, so we skip the
    // schema_changes row but still notify ("ready for AI profiling").
    let diffSummary: string | null = null;
    let schemaChangeId: number | null = null;
    let diffHasContent = false;
    if (driftKind === 'changed' && nextTables) {
      try {
        const prevTables = await loadPersistedSchema(connectionId, tenantId);
        const diff = diffSchema(prevTables, nextTables);
        diffSummary = summariseSchemaDiff(diff);
        diffHasContent =
          (diff.added_tables.length + diff.removed_tables.length + diff.changed_tables.length) > 0;
        if (diffHasContent && diffSummary) {
          const colsAdded = diff.changed_tables.reduce((n, t) => n + t.added_columns.length, 0);
          const colsRemoved = diff.changed_tables.reduce((n, t) => n + t.removed_columns.length, 0);
          const colsChanged = diff.changed_tables.reduce((n, t) => n + t.changed_columns.length, 0);
          const [row] = await semanticDb('schema_changes').insert({
            tenant_id: tenantId,
            connection_id: connectionId,
            summary: diffSummary,
            diff: JSON.stringify(diff),
            tables_added: diff.added_tables.length,
            tables_removed: diff.removed_tables.length,
            columns_added: colsAdded,
            columns_removed: colsRemoved,
            columns_changed: colsChanged,
          }).returning('id');
          schemaChangeId = typeof row === 'object' ? (row as { id: number }).id : (row as number);
        }
      } catch (e) {
        log.warn({ err: e, connectionId }, 'schema-diff capture failed');
        // Treat as empty diff — better to swallow one notification than
        // to spam the user. They'll get one for the NEXT real change.
        diffHasContent = false;
        diffSummary = null;
      }
    }

    // ── Hash mismatch with empty diff = false positive ──────────────────
    // The normalised structures match (same tables, same columns, same
    // types) but the SHA differs. Causes include: connector returning
    // metadata in different order, type coercion edge cases, or transient
    // introspection artefacts. Sync the stored hash silently — no
    // notification, no row, no spam. Real changes will trip the diff and
    // come through normally.
    if (driftKind === 'changed' && !diffHasContent) {
      try {
        await semanticDb('connections')
          .where({ id: connectionId, tenant_id: tenantId })
          .update({ schema_hash: currentHash });
        log.info(
          { connectionId, currentHash, storedHash: conn.schema_hash },
          'hash mismatch with empty diff — sync\'d hash silently (no notification fired)',
        );
      } catch (e) {
        log.warn({ err: e, connectionId }, 'failed to sync schema_hash on empty-diff drift');
      }
      return;
    }

    const title = driftKind === 'first_sync'
      ? `${connName}: ready for AI profiling`
      : `${connName}: schema changed — re-profile recommended`;
    const message = driftKind === 'first_sync'
      ? `Sync completed. Click Re-profile on the source to generate AI descriptions for the catalog.`
      : (diffSummary
          ? `Sync detected: ${diffSummary}. Click through to review, then Re-profile to refresh AI descriptions. No AI tokens are being spent automatically.`
          : `Sync detected structural changes (new or renamed columns). Click Re-profile to refresh AI descriptions. No AI tokens are being spent automatically.`);

    try {
      const { notifyAdmins } = await import('../services/notificationService');
      // Link includes ?schemaChange=<id> when we have one so the
      // /sources page can scroll/expand directly to the diff.
      const link = schemaChangeId != null
        ? `/sources?connectionId=${connectionId}&schemaChange=${schemaChangeId}`
        : `/sources?connectionId=${connectionId}`;
      await notifyAdmins(tenantId, 'approval', title, {
        message,
        entityType: 'connection',
        entityId: connectionId,
        link,
      });
    } catch (notifyErr) {
      log.warn({ err: notifyErr, connectionId }, 'schema-drift notification failed (non-fatal)');
    }

    // ── Update stored hash so we don't re-fire on every subsequent sync ──
    // Previous design was "remind every sync until the user acts" but
    // that produced notification spam — the user already has an unread
    // notification in the bell, that IS the reminder. Update the hash
    // so the next sync only re-fires if ANOTHER change happens.
    // Re-profile (when the user clicks "Re-analyse now") still updates
    // schema_hash on success, so this code path harmonises with the
    // existing acted-on path.
    if (driftKind === 'changed' && currentHash) {
      try {
        await semanticDb('connections')
          .where({ id: connectionId, tenant_id: tenantId })
          .update({ schema_hash: currentHash });
      } catch (e) {
        log.warn({ err: e, connectionId }, 'failed to update schema_hash post-notification');
      }
    }
    return;
  }

  // Legacy auto-profile path — only reached when AUTO_REPROFILE_ON_SYNC=true.
  // Spends AI tokens to update descriptions whenever drift is detected.
  const { runSchemaProfiler } = await import('../semantic/SchemaProfiler');
  await semanticDb('connections')
    .where({ id: connectionId, tenant_id: tenantId })
    .update({
      profiling_status: 'running',
      profiling_phase: 'schema',
      profiling_message: 'Checking schema…',
      profiling_progress: 0,
      profiling_started_at: new Date().toISOString(),
    });

  try {
    await runSchemaProfiler(connectionId, (p) => {
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

    // Persist the new schema hash so the next sync can short-circuit if
    // nothing structural changed. Recompute from scratch — the in-memory
    // hash from the gate above is stale by the time the profiler returns
    // (the profiler may have observed slightly different schema in its
    // own introspection).
    let newHash: string | null = null;
    try {
      const conn2 = await semanticDb('connections')
        .where({ id: connectionId, tenant_id: tenantId })
        .first();
      if (conn2) {
        const { hash } = await introspectAndHash(conn2);
        newHash = hash;
      }
    } catch (err) {
      log.warn({ err, connectionId }, 'failed to compute schema hash post-profile (next sync will re-AI)');
    }

    await semanticDb('connections')
      .where({ id: connectionId, tenant_id: tenantId })
      .update({
        profiling_status: 'done',
        profiling_phase: 'done',
        profiling_message: 'Profiling complete',
        profiling_progress: 100,
        last_profiled_at: new Date().toISOString(),
        ...(newHash ? { schema_hash: newHash } : {}),
      });
    log.info({ connectionId, schemaHashed: !!newHash }, 'schema profiling complete');
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

// ─── Schema hashing (cost gate helper) ───────────────────────────────────
/**
 * Introspect the connection's schema and compute a hash of its STRUCTURE
 * (table names + column names + types). Insensitive to data, sample
 * values, or column ordering. Returns `{ hash: null }` when the connector
 * doesn't expose schema information yet (e.g. fresh connection that
 * hasn't synced).
 *
 * Used by `runProfilerInBackground` to skip the AI-draft step when nothing
 * structural changed since the last successful profile.
 */
/**
 * Normalised schema shape used for both hashing and diffing. Sorted +
 * structural fields only — sample values, comments, etc. excluded so
 * cosmetic-only changes don't trigger "schema drift".
 */
interface NormalisedTable {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

async function introspectAndHash(conn: Record<string, unknown>): Promise<{
  hash: string | null;
  hadSchema: boolean;
  /** Present when hadSchema is true. Used by callers that need to diff
   *  the new shape against the old (Postgres `source_tables`/`source_columns`
   *  hold the previous shape — we don't persist a normalised snapshot
   *  separately). */
  tables?: NormalisedTable[];
}> {
  const { createConnector } = await import('../connectors/ConnectorFactory');
  const crypto = await import('crypto');

  let connector;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connector = await createConnector(conn as any);
    await connector.connect();
  } catch {
    return { hash: null, hadSchema: false };
  }
  try {
    const schema = await connector.introspectSchema();
    if (!schema?.tables || schema.tables.length === 0) {
      return { hash: null, hadSchema: false };
    }
    // Normalised representation — sorted, only structural fields, no
    // sample values. Stable across runs as long as the structure is.
    const normalised: NormalisedTable[] = schema.tables
      .map((t) => ({
        name: t.tableName,
        columns: t.columns
          .map((c) => ({ name: c.name, type: String(c.type ?? '').toLowerCase() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const json = JSON.stringify(normalised);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    return { hash, hadSchema: true, tables: normalised };
  } finally {
    try { connector.disconnect(); } catch { /* swallow */ }
  }
}

/**
 * Compute a structural diff between two normalised schemas. Same shape
 * persisted to `schema_changes.diff`. Renames are intentionally treated
 * as remove+add — reliable detection requires a similarity heuristic,
 * which costs more than it saves at this scope.
 */
interface SchemaDiff {
  added_tables:   Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  removed_tables: Array<{ name: string }>;
  changed_tables: Array<{
    name: string;
    added_columns:   Array<{ name: string; type: string }>;
    removed_columns: Array<{ name: string; type: string }>;
    changed_columns: Array<{ name: string; old_type: string; new_type: string }>;
  }>;
}

function diffSchema(prev: NormalisedTable[], next: NormalisedTable[]): SchemaDiff {
  const prevByName = new Map(prev.map((t) => [t.name, t] as const));
  const nextByName = new Map(next.map((t) => [t.name, t] as const));

  const added_tables: SchemaDiff['added_tables'] = [];
  const removed_tables: SchemaDiff['removed_tables'] = [];
  const changed_tables: SchemaDiff['changed_tables'] = [];

  for (const [name, t] of nextByName) {
    if (!prevByName.has(name)) added_tables.push({ name, columns: t.columns });
  }
  for (const [name] of prevByName) {
    if (!nextByName.has(name)) removed_tables.push({ name });
  }
  for (const [name, prevT] of prevByName) {
    const nextT = nextByName.get(name);
    if (!nextT) continue;
    const prevCols = new Map(prevT.columns.map((c) => [c.name, c] as const));
    const nextCols = new Map(nextT.columns.map((c) => [c.name, c] as const));
    const added_columns: typeof prevT.columns = [];
    const removed_columns: typeof prevT.columns = [];
    const changed_columns: SchemaDiff['changed_tables'][number]['changed_columns'] = [];
    for (const [cName, c] of nextCols) {
      if (!prevCols.has(cName)) added_columns.push(c);
    }
    for (const [cName, c] of prevCols) {
      if (!nextCols.has(cName)) removed_columns.push(c);
    }
    for (const [cName, prevC] of prevCols) {
      const nextC = nextCols.get(cName);
      if (!nextC) continue;
      if (prevC.type !== nextC.type) {
        changed_columns.push({ name: cName, old_type: prevC.type, new_type: nextC.type });
      }
    }
    if (added_columns.length || removed_columns.length || changed_columns.length) {
      changed_tables.push({ name, added_columns, removed_columns, changed_columns });
    }
  }
  return { added_tables, removed_tables, changed_tables };
}

/**
 * Build a one-line human summary of a schema diff. Used in the
 * notification body so the user has context before clicking through.
 * Returns null when the diff is empty (caller can short-circuit).
 */
function summariseSchemaDiff(diff: SchemaDiff): string | null {
  const parts: string[] = [];
  if (diff.added_tables.length) parts.push(`${diff.added_tables.length} new table${diff.added_tables.length === 1 ? '' : 's'}`);
  if (diff.removed_tables.length) parts.push(`${diff.removed_tables.length} removed table${diff.removed_tables.length === 1 ? '' : 's'}`);
  const colsAdded = diff.changed_tables.reduce((n, t) => n + t.added_columns.length, 0);
  const colsRemoved = diff.changed_tables.reduce((n, t) => n + t.removed_columns.length, 0);
  const colsChanged = diff.changed_tables.reduce((n, t) => n + t.changed_columns.length, 0);
  if (colsAdded) parts.push(`${colsAdded} new column${colsAdded === 1 ? '' : 's'}`);
  if (colsRemoved) parts.push(`${colsRemoved} removed column${colsRemoved === 1 ? '' : 's'}`);
  if (colsChanged) parts.push(`${colsChanged} type change${colsChanged === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  return parts.join(', ');
}

/**
 * Load the previous normalised schema from Postgres `source_tables` +
 * `source_columns`. Returns the same shape as `introspectAndHash`
 * produces, so the two can be diffed directly.
 */
async function loadPersistedSchema(connectionId: number, tenantId: number): Promise<NormalisedTable[]> {
  const tables = await semanticDb('source_tables')
    .where({ connection_id: connectionId, tenant_id: tenantId, is_active: true })
    .select('id', 'table_name');
  if (tables.length === 0) return [];
  const tableIds = (tables as Array<{ id: number; table_name: string }>).map((t) => t.id);
  const cols = await semanticDb('source_columns')
    .whereIn('source_table_id', tableIds)
    .select<Array<{ source_table_id: number; column_name: string; data_type: string | null }>>(
      'source_table_id', 'column_name', 'data_type',
    );
  const colsByTable = new Map<number, NormalisedTable['columns']>();
  for (const c of cols) {
    const arr = colsByTable.get(c.source_table_id) ?? [];
    arr.push({ name: c.column_name, type: String(c.data_type ?? '').toLowerCase() });
    colsByTable.set(c.source_table_id, arr);
  }
  return (tables as Array<{ id: number; table_name: string }>)
    .map((t) => ({
      name: t.table_name,
      columns: (colsByTable.get(t.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
