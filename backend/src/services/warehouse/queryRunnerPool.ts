/**
 * Query runner pool — PARENT side.
 *
 * Keeps a small set of warm child processes, each holding a DuckDB session with
 * views already registered for one (warehouse × table-set) combination — the
 * same key the in-process `DuckDBPool` uses. Warm matters: registering views and
 * loading the delta/azure extensions costs ~500ms, which is unacceptable per
 * dashboard widget, so we pay it once per key and reuse.
 *
 * What this buys over the in-process path:
 *   • a real timeout — SIGKILL ends the query, frees the CPU and releases the
 *     concurrency permit for real (the in-process `Promise.race` does neither);
 *   • crash containment — a DuckDB OOM or native fault kills one runner instead
 *     of the API for every tenant;
 *   • a genuine per-query memory ceiling, because each runner is its own process.
 *
 * Deliberately NOT a general worker pool: one in-flight query per child. Adding
 * multiplexing would reintroduce the head-of-line blocking this exists to avoid
 * (you cannot kill one query without killing its neighbours in the same process).
 *
 * Opt-in via DUCKDB_RUNNER=child. Falls back to in-process automatically when
 * the compiled child script isn't present (e.g. running from TypeScript sources
 * in local dev), so nothing breaks if it can't be used.
 */

import { fork, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger as rootLogger } from '../../utils/logger';
import type { RunnerSpec } from './queryRunnerChild';

const log = rootLogger.child({ mod: 'query-runner-pool' });

const MAX_RUNNERS = Math.max(1, Number(process.env.DUCKDB_RUNNER_MAX) || 4);
const IDLE_TTL_MS = Number(process.env.DUCKDB_RUNNER_IDLE_MS) || 10 * 60 * 1000;
const INIT_TIMEOUT_MS = Number(process.env.DUCKDB_RUNNER_INIT_TIMEOUT_MS) || 60_000;

export class QueryTimeoutError extends Error {
  constructor(ms: number) {
    super(`Query exceeded ${ms}ms and was cancelled`);
    this.name = 'QueryTimeoutError';
  }
}

interface Runner {
  child: ChildProcess;
  key: string;
  ready: Promise<void>;
  busy: boolean;
  lastUsed: number;
  /** Resolver table for in-flight queries (at most one, but keyed for safety). */
  pending: Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (e: Error) => void }>;
  /** Set when we killed it deliberately, so the exit handler stays quiet. */
  killed: boolean;
}

const runners = new Map<string, Runner>();
let nextQueryId = 1;

/** Resolve the compiled child script; null when unavailable (TS dev mode). */
function childScriptPath(): string | null {
  // __dirname is .../dist/services/warehouse at runtime.
  const candidate = path.join(__dirname, 'queryRunnerChild.js');
  return fs.existsSync(candidate) ? candidate : null;
}

/** Whether the child-process runner should be used at all. */
export function runnerEnabled(): boolean {
  if (process.env.DUCKDB_RUNNER !== 'child') return false;
  if (childScriptPath() === null) {
    log.warn('DUCKDB_RUNNER=child but the compiled runner script was not found — using in-process execution');
    return false;
  }
  return true;
}

function destroyRunner(runner: Runner, reason: string): void {
  runner.killed = true;
  runners.delete(runner.key);
  for (const [, p] of runner.pending) {
    p.reject(new Error(`Query runner terminated: ${reason}`));
  }
  runner.pending.clear();
  try {
    runner.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function spawnRunner(key: string, spec: RunnerSpec): Runner {
  const script = childScriptPath();
  if (!script) throw new Error('Query runner script unavailable');

  const child = fork(script, [], {
    // Inherit env (the child needs the Azure secret + DuckDB tuning vars).
    env: process.env,
    // Keep stdio piped so a native crash message lands in our logs rather than
    // the container's raw stdout.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const runner: Runner = {
    child,
    key,
    busy: false,
    lastUsed: Date.now(),
    pending: new Map(),
    killed: false,
    ready: Promise.resolve(),
  };

  runner.ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      destroyRunner(runner, 'init timeout');
      reject(new Error('Query runner failed to start in time'));
    }, INIT_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.on('message', (msg: { type: string; id?: number; rows?: Record<string, unknown>[]; message?: string }) => {
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (msg.type === 'init_error') {
        clearTimeout(timer);
        destroyRunner(runner, msg.message ?? 'init error');
        reject(new Error(msg.message ?? 'Query runner init failed'));
        return;
      }
      if (msg.id === undefined) return;
      const pending = runner.pending.get(msg.id);
      if (!pending) return;
      runner.pending.delete(msg.id);
      if (msg.type === 'result') pending.resolve(msg.rows ?? []);
      else pending.reject(new Error(msg.message ?? 'Query failed'));
    });
  });

  child.stderr?.on('data', (buf: Buffer) => {
    log.warn({ key, out: buf.toString().slice(0, 500) }, 'query runner stderr');
  });

  child.on('exit', (code, signal) => {
    if (runner.killed) return;
    // Unexpected death — a native crash or the OOM killer. This is exactly the
    // failure that used to take the API down with it.
    log.error({ key, code, signal }, 'Query runner exited unexpectedly');
    destroyRunner(runner, `runner exited (code=${code} signal=${signal})`);
  });

  child.send({ type: 'init', spec });
  runners.set(key, runner);
  return runner;
}

function evictIfNeeded(): void {
  const cutoff = Date.now() - IDLE_TTL_MS;
  for (const runner of [...runners.values()]) {
    if (!runner.busy && runner.lastUsed < cutoff) {
      destroyRunner(runner, 'idle');
    }
  }
  if (runners.size <= MAX_RUNNERS) return;
  const idle = [...runners.values()].filter((r) => !r.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const runner of idle) {
    if (runners.size <= MAX_RUNNERS) break;
    destroyRunner(runner, 'over capacity');
  }
}

/**
 * Run `sql` on the runner for `key`, spawning/reusing one as needed.
 * On timeout the child is SIGKILLed — the query genuinely stops.
 *
 * Throws if a runner for this key is already busy; the caller (DuckDBConnector)
 * holds a concurrency permit, so this indicates a real over-subscription and is
 * better surfaced than silently queued behind an unkillable query.
 */
export async function runQuery(
  key: string,
  spec: RunnerSpec,
  sql: string,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  evictIfNeeded();

  let runner = runners.get(key);
  if (runner && runner.busy) {
    // One query at a time per runner — see the header note on multiplexing.
    runner = undefined;
  }
  if (!runner) {
    // Spawn a dedicated runner for this query. It gets pooled on completion
    // only if the key isn't already taken.
    runner = spawnRunner(runners.has(key) ? `${key}#${nextQueryId}` : key, spec);
  }

  await runner.ready;

  const id = nextQueryId++;
  runner.busy = true;
  runner.lastUsed = Date.now();

  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      runner!.pending.set(id, { resolve, reject });

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            log.warn({ key, timeoutMs }, 'Query exceeded its budget — killing runner');
            destroyRunner(runner!, 'timeout');
            reject(new QueryTimeoutError(timeoutMs));
          }, timeoutMs)
        : null;
      if (timer?.unref) timer.unref();

      const clear = () => { if (timer) clearTimeout(timer); };
      const original = runner!.pending.get(id)!;
      runner!.pending.set(id, {
        resolve: (rows) => { clear(); original.resolve(rows); },
        reject: (e) => { clear(); original.reject(e); },
      });

      try {
        runner!.child.send({ type: 'query', id, sql });
      } catch (err) {
        clear();
        runner!.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  } finally {
    if (!runner.killed) {
      runner.busy = false;
      runner.lastUsed = Date.now();
    }
  }
}

/** Invalidate runners whose key starts with `prefix` (after a data refresh). */
export function invalidateRunnersByPrefix(prefix: string): void {
  for (const runner of [...runners.values()]) {
    if (runner.key.startsWith(prefix)) destroyRunner(runner, 'invalidated');
  }
}

/** Close every runner. Call on graceful shutdown. */
export function drainRunners(): void {
  for (const runner of [...runners.values()]) destroyRunner(runner, 'shutdown');
}

/** For tests / diagnostics. */
export function _runnerCount(): number {
  return runners.size;
}
