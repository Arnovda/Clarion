/**
 * `JobLauncher` — abstraction over "where does the sync actually run?".
 *
 * Implementations:
 *   • `LocalProcessJobLauncher` (Day 5, this file) — spawns the worker
 *     as a child Node process. Same machine, separate process, separate
 *     memory, communication via stdout JSON-lines.
 *   • `AzureContainerAppsJobLauncher` (Day 6) — triggers an ephemeral
 *     Container Apps Job execution. Same JSON-line stream surfaces via
 *     Log Analytics and the Mgmt API.
 *
 * The orchestrator depends on this interface only. Switching launchers
 * (local ↔ Azure) is a config change, not a code change.
 *
 * The launcher's job is narrow:
 *   • Accept a `JobSpec` (env vars + the warehouse path)
 *   • Start the worker
 *   • Stream `WorkerEvent`s back via the `onEvent` callback
 *   • Resolve when the worker exits (with the final exit code)
 *
 * Cancellation is cooperative: callers invoke `cancel()` on the returned
 * handle, which signals the underlying process/job. The worker's SIGTERM
 * handler flips the cancellation token and the connector aborts cleanly.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import {
  EXIT_CANCELLED,
  isWorkerEvent,
  type WorkerEvent,
} from '@databridge/connectors';

// ─── Public interface ─────────────────────────────────────────────────────
export interface JobSpec {
  connectorType: string;
  /** PLAINTEXT config — encryption is the orchestrator's concern. */
  connectorConfig: Record<string, unknown>;
  entities: string[];
  tenantId: string;
  connectionId: string;
  syncRunId: string;
  /** Target for warehouse writes. Local FS path for LocalProcess; SAS URL for Azure. */
  warehousePath: string;
}

export interface JobHandle {
  /** Resolves when the job exits. Resolved with the exit code (0 on success). */
  readonly done: Promise<{ exitCode: number }>;
  /** Send SIGTERM (local) or stop the Container Apps Job (Azure). */
  cancel(): void;
}

export interface JobLauncher {
  launch(spec: JobSpec, onEvent: (event: WorkerEvent) => void): JobHandle;
}

// ─── Local child-process launcher ─────────────────────────────────────────
/**
 * Spawns `node worker/dist/main.js` as a child process. Stdout is parsed
 * line-by-line into `WorkerEvent`s and forwarded to the orchestrator's
 * callback. Stderr is captured and surfaced as a final `error` event if
 * the child exits non-zero without already emitting one.
 *
 * The worker's binary path is resolved relative to this file at module
 * load time. The orchestrator's running directory doesn't affect it.
 */
export class LocalProcessJobLauncher implements JobLauncher {
  /**
   * @param workerEntryPath Optional override for the worker entrypoint.
   *                        Defaults to `<repo-root>/worker/dist/main.js`.
   *                        Useful for tests that want to point at a stub.
   */
  constructor(private readonly workerEntryPath?: string) {}

  launch(spec: JobSpec, onEvent: (event: WorkerEvent) => void): JobHandle {
    const entryPath = this.workerEntryPath ?? defaultWorkerEntry();
    const child: ChildProcess = spawn(process.execPath, [entryPath], {
      env: {
        // Inherit the minimum from the parent — PATH so child can find duckdb
        // native binaries, NODE_OPTIONS for tracing if we ever set it. Drop
        // everything else so the child can't accidentally see DB / Anthropic
        // creds the orchestrator has in scope.
        PATH: process.env.PATH,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        // Worker contract — mirrors what Container Apps Job env will look
        // like in production.
        WORKER_CONNECTOR_TYPE: spec.connectorType,
        WORKER_CONNECTOR_CONFIG: JSON.stringify(spec.connectorConfig),
        WORKER_ENTITIES: spec.entities.join(','),
        WORKER_TENANT_ID: spec.tenantId,
        WORKER_CONNECTION_ID: spec.connectionId,
        WORKER_SYNC_RUN_ID: spec.syncRunId,
        WORKER_WAREHOUSE_PATH: spec.warehousePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detach=false so killing the parent kills the child — important
      // when developers Ctrl-C the backend mid-sync.
      detached: false,
    });

    let stderrBuffer = '';
    let stdoutBuffer = '';
    let terminalEventEmitted = false;

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let nl: number;
      while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (line.length === 0) continue;
        const parsed = tryParseJSON(line);
        if (parsed && isWorkerEvent(parsed)) {
          if (parsed.type === 'result' || parsed.type === 'error' || parsed.type === 'cancelled') {
            terminalEventEmitted = true;
          }
          onEvent(parsed);
        } else {
          // Non-IPC line on stdout (deprecation warnings, library noise).
          // Forward as a debug log so it's visible without polluting events.
          onEvent({
            type: 'log',
            ts: new Date().toISOString(),
            level: 'debug',
            msg: 'worker non-ipc stdout',
            fields: { line: truncate(line, 500) },
          });
        }
      }
    });

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => {
      // Ring-buffered last 8kB — used only for the synthetic error event
      // if the worker dies without emitting one of its own.
      stderrBuffer = (stderrBuffer + chunk).slice(-8192);
    });

    const done = new Promise<{ exitCode: number }>((resolve) => {
      child.on('close', (code, signal) => {
        const exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? EXIT_CANCELLED : 1);
        // If the worker died without emitting a terminal event, synthesise one
        // so the orchestrator never leaves a run in `running`.
        if (!terminalEventEmitted) {
          if (exitCode === EXIT_CANCELLED) {
            onEvent({ type: 'cancelled', ts: new Date().toISOString() });
          } else {
            onEvent({
              type: 'error',
              ts: new Date().toISOString(),
              message: `Worker exited unexpectedly with code ${exitCode}`,
              stack: stderrBuffer ? truncate(stderrBuffer, 4000) : undefined,
            });
          }
        }
        resolve({ exitCode });
      });
      // ENOENT etc. — emitted before close.
      child.on('error', (err) => {
        if (!terminalEventEmitted) {
          onEvent({
            type: 'error',
            ts: new Date().toISOString(),
            message: `Failed to spawn worker: ${err.message}`,
          });
          terminalEventEmitted = true;
        }
      });
    });

    return {
      done,
      cancel: () => {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      },
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function defaultWorkerEntry(): string {
  // Resolved at runtime relative to this compiled file's location.
  // backend/dist/orchestrator/JobLauncher.js → ../../../worker/dist/main.js
  // Falls back to the source path for ts-node dev (rare; backend npm-runs ts-node).
  const distPath = path.resolve(__dirname, '../../../worker/dist/main.js');
  return distPath;
}

function tryParseJSON(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
