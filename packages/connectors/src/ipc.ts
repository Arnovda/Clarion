/**
 * Worker → Orchestrator IPC protocol (stdout JSON-lines).
 *
 * The sync-worker (whether running as a local child process today or in
 * an Azure Container Apps Job tomorrow) emits one JSON line per event on
 * stdout. The orchestrator parses lines back into typed events and
 * dispatches them: persists row counts, re-encrypts rotated credentials,
 * records final status, etc.
 *
 * Why JSON-lines on stdout vs an HTTP/IPC channel:
 *   • Container Apps captures stdout and forwards it to Log Analytics —
 *     the same channel doubles as our event channel and the audit trail.
 *   • Works identically for child-process IPC (just read child.stdout).
 *   • No extra network plumbing, no shared service for the worker to call.
 *   • The worker has zero credentials to talk to Clarion's DB — the
 *     orchestrator persists everything.
 *
 * Each emitted line is `JSON.stringify(event) + '\n'`. The orchestrator
 * splits on `\n` and JSON.parses each line; lines that fail to parse are
 * still streamed to a debug log (could be a stack trace, a deprecation
 * warning, etc.) but ignored as IPC.
 */

// ─── Shared envelope ──────────────────────────────────────────────────────
export type WorkerEvent =
  | { type: 'started'; ts: string }
  | { type: 'log'; ts: string; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; fields?: Record<string, unknown> }
  | { type: 'progress'; ts: string; message: string; perEntity?: Record<string, { rowsFetched?: number; pagesFetched?: number }>; percent?: number }
  | { type: 'credential_rotated'; ts: string; newConfig: Record<string, unknown> }
  | { type: 'entity_complete'; ts: string; entity: string; rowsWritten: number; bytesWritten: number }
  | { type: 'result'; ts: string; rowCounts: Record<string, number>; warnings: string[] }
  | { type: 'error'; ts: string; message: string; stack?: string }
  | { type: 'cancelled'; ts: string };

// ─── Type guards (used by the orchestrator's parser) ──────────────────────
export function isWorkerEvent(v: unknown): v is WorkerEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as { type?: unknown };
  if (typeof e.type !== 'string') return false;
  return [
    'started', 'log', 'progress', 'credential_rotated',
    'entity_complete', 'result', 'error', 'cancelled',
  ].includes(e.type);
}

// ─── Stdout emitter (used by the worker) ──────────────────────────────────
/**
 * Emit one event line to stdout. Synchronous write — we want events to
 * appear immediately, not be buffered behind subsequent connector work.
 *
 * Process.stdout.write is synchronous when writing to a pipe (the
 * orchestrator's child.stdout) up to the OS pipe buffer size (~64kB),
 * which is plenty for our line-sized events.
 */
export function emit(event: WorkerEvent, sink: (line: string) => void = (l) => process.stdout.write(l)): void {
  sink(`${JSON.stringify(event)}\n`);
}

// ─── Worker process exit codes ────────────────────────────────────────────
/**
 * The orchestrator inspects child exit codes alongside the stream of
 * events. A clean run emits a `result` event and exits 0; a failed run
 * emits `error` and exits 1; cancellation emits `cancelled` and exits
 * with EXIT_CANCELLED.
 *
 * If the process dies without emitting a terminal event (segfault,
 * killed by OOM), the orchestrator marks the run failed with an
 * "unexpected exit" message — we never leave a run in `running`
 * indefinitely.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CANCELLED = 124;
