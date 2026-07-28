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

/**
 * How many runner processes can be ALIVE AT ONCE — the divisor for the resource
 * budget below.
 *
 * It is NOT simply MAX_RUNNERS. When the runner for a key is busy, `runQuery`
 * spawns an extra one (one query per child is the whole point), and
 * `evictIfNeeded` can only reap runners that are idle. The real ceiling is
 * therefore the number of queries that can be in flight at once, which
 * `DuckDBConnector`'s global semaphore caps at DUCKDB_MAX_CONCURRENT_QUERIES —
 * a value that DEFAULTS HIGHER than MAX_RUNNERS (6 vs 4). Dividing by 4 while 6
 * processes can exist would put the aggregate back over budget, so take the max
 * of the two. Kept in sync with DuckDBConnector's own default on purpose.
 */
const MAX_CONCURRENT_QUERIES = Math.max(1, Number(process.env.DUCKDB_MAX_CONCURRENT_QUERIES) || 6);
const BUDGET_DIVISOR = Math.max(MAX_RUNNERS, MAX_CONCURRENT_QUERIES);

/** Never hand a runner a memory budget so small that every query spills. */
const MIN_RUNNER_MEMORY_MB = 128;

const MEMORY_UNIT_MB: Record<string, number> = {
  B: 1 / (1024 * 1024),
  KB: 1 / 1024,
  MB: 1,
  GB: 1024,
  TB: 1024 * 1024,
};

/**
 * Split a `memory_limit` value across `divisor` runner processes.
 *
 * The child process calls the same `setupDuckDBForWarehouse` as the in-process
 * path, which applies `DUCKDB_MEMORY_LIMIT` (default `'70%'`). Inheriting that
 * verbatim would let EVERY runner claim the whole replica's budget: at
 * `DUCKDB_RUNNER_MAX=4` that is 280% of container memory, so a few concurrent
 * heavy queries get the container OOM-killed — strictly worse than the
 * in-process path this is meant to improve on. Dividing keeps the AGGREGATE
 * footprint of all runners equal to what one in-process session was allowed.
 *
 * Percentages stay percentages (they need no knowledge of the replica size);
 * absolute sizes are divided in MB and floored at `MIN_RUNNER_MEMORY_MB`. A
 * value in neither shape is returned untouched — `applyResourceGuardrails`
 * rejects it either way, and silently inventing a number would hide the typo.
 */
export function dividedMemoryLimit(limit: string, divisor: number): string {
  const d = Math.max(1, Math.floor(divisor));
  const raw = limit.trim();

  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw);
  if (pct) {
    const share = Math.max(1, Math.floor(Number(pct[1]) / d));
    return `${share}%`;
  }

  const abs = /^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i.exec(raw);
  if (abs) {
    const unit = abs[2].toUpperCase();
    const totalMb = Number(abs[1]) * MEMORY_UNIT_MB[unit];
    const share = Math.max(MIN_RUNNER_MEMORY_MB, Math.floor(totalMb / d));
    return `${share}MB`;
  }

  return raw;
}

/** Split a thread budget across runner processes; every runner keeps ≥1. */
export function dividedThreads(threads: string, divisor: number): string {
  const d = Math.max(1, Math.floor(divisor));
  if (!/^\d+$/.test(threads.trim())) return threads;
  return String(Math.max(1, Math.floor(Number(threads.trim()) / d)));
}

/**
 * Environment for a runner: the parent's, with the DuckDB resource budget
 * divided across the runner slots. Everything else is inherited on purpose —
 * the child needs the Azure secret and the rest of the DuckDB tuning vars.
 */
export function runnerEnv(parent: NodeJS.ProcessEnv, divisor: number): NodeJS.ProcessEnv {
  return {
    ...parent,
    DUCKDB_MEMORY_LIMIT: dividedMemoryLimit(parent.DUCKDB_MEMORY_LIMIT ?? '70%', divisor),
    DUCKDB_THREADS: dividedThreads(parent.DUCKDB_THREADS ?? '2', divisor),
  };
}

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
  /**
   * Set when the runner's data was invalidated while it was mid-query. It must
   * not serve another query (its views point at the pre-refresh file set) but is
   * left alive until the in-flight one finishes — see invalidateRunnersByPrefix.
   */
  stale: boolean;
}

const runners = new Map<string, Runner>();
let nextQueryId = 1;

/**
 * Resolve the compiled child script; null when unavailable (TS dev mode).
 *
 * Memoised: `runnerEnabled()` is consulted on EVERY query, and an unmemoised
 * `existsSync` would mean a filesystem syscall per query. The script is baked
 * into the image, so it cannot appear or vanish while the process lives.
 */
let scriptPathResolved = false;
let scriptPathCache: string | null = null;
function childScriptPath(): string | null {
  if (!scriptPathResolved) {
    // __dirname is .../dist/services/warehouse at runtime.
    const candidate = path.join(__dirname, 'queryRunnerChild.js');
    scriptPathCache = fs.existsSync(candidate) ? candidate : null;
    scriptPathResolved = true;
  }
  return scriptPathCache;
}

/** Logged at most once each — boot-time conditions, not per-query events. */
let missingScriptWarned = false;
let activeLogged = false;

/** Whether the child-process runner should be used at all. */
export function runnerEnabled(): boolean {
  if (process.env.DUCKDB_RUNNER !== 'child') return false;
  if (childScriptPath() === null) {
    if (!missingScriptWarned) {
      missingScriptWarned = true;
      log.warn('DUCKDB_RUNNER=child but the compiled runner script was not found — using in-process execution');
    }
    return false;
  }
  if (!activeLogged) {
    activeLogged = true;
    // The positive signal to look for after flipping DUCKDB_RUNNER=child: without
    // it, a silent fall back to in-process is indistinguishable from success.
    log.info(
      {
        maxRunners: MAX_RUNNERS,
        budgetDivisor: BUDGET_DIVISOR,
        memoryLimitPerRunner: runnerEnv(process.env, BUDGET_DIVISOR).DUCKDB_MEMORY_LIMIT,
      },
      'Child-process query runner ACTIVE',
    );
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
    // Inherit env (the child needs the Azure secret + DuckDB tuning vars), but
    // with memory/threads divided across the runner slots — see runnerEnv().
    env: runnerEnv(process.env, BUDGET_DIVISOR),
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
    stale: false,
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
  if (runner && (runner.busy || runner.stale)) {
    // One query at a time per runner (see the header note on multiplexing), and
    // never reuse a runner whose data was invalidated — its views still point at
    // the pre-refresh file set, so it would serve silently stale rows.
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
      // Retired by an invalidation that arrived mid-query: the query has now
      // settled, so close it. Doing it here rather than leaving it to idle
      // eviction also frees its base key for a fresh, post-refresh runner.
      if (runner.stale) destroyRunner(runner, 'invalidated (deferred)');
    }
  }
}

/**
 * Invalidate runners whose key starts with `prefix` (after a data refresh).
 *
 * A BUSY runner is marked stale rather than killed. Killing it would abort a
 * user's in-flight query with an infrastructure error the moment a
 * transformation finished — the same mid-query-close failure that was fixed for
 * the in-process `DuckDBPool` (review finding H2), and it would be worse here
 * because SIGKILL gives the query no chance to complete. A stale runner serves
 * no further queries (its views point at the pre-refresh file set) and is
 * destroyed as soon as the in-flight query settles.
 */
export function invalidateRunnersByPrefix(prefix: string): void {
  for (const runner of [...runners.values()]) {
    if (!runner.key.startsWith(prefix)) continue;
    if (runner.busy) {
      runner.stale = true;
      log.info({ key: runner.key }, 'Runner invalidated while busy — retiring it after the in-flight query');
    } else {
      destroyRunner(runner, 'invalidated');
    }
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

/** For tests / diagnostics: the divisor applied to the DuckDB resource budget. */
export function _budgetDivisor(): number {
  return BUDGET_DIVISOR;
}
