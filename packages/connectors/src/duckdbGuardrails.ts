/**
 * Resource guardrails for the DuckDB sessions the SYNC WORKER opens.
 *
 * The backend applies `memory_limit` / `threads` / `temp_directory` to every
 * session it opens (`services/warehouse/duckdb.ts: applyResourceGuardrails`).
 * The two warehouse writers in this package did not, so a worker session ran
 * with DuckDB's defaults: 80% of visible RAM and one thread per core. In a
 * 1-vCPU / 1-GiB Container Apps job that is the difference between a large
 * incremental merge spilling to disk and the platform OOM-killing the job
 * mid-write.
 *
 * The merge path is exactly where this bites: it reads the WHOLE existing
 * parquet, unions the delta, and re-ranks — the peak is proportional to the
 * table, not to the batch.
 *
 * Deliberately a copy of the backend's rule rather than a shared import: this
 * package has no backend dependency and must stay standalone (the worker
 * installs it alone). The env var NAMES are the contract between them.
 */

import type { Database } from 'duckdb-async';
import os from 'os';

/**
 * Turn a configured memory limit into a value DuckDB 1.4 accepts.
 *
 * DuckDB 1.4.2 REJECTS the percentage form (`Unknown unit for memory: '%'`),
 * and both guardrails wrapped the SET in a try/catch meant for "older build
 * without the setting" — so from the day the pinned DuckDB moved past the
 * percentage-accepting builds, every `60%` / `70%` silently applied NOTHING and
 * the session ran at DuckDB's own default (80% of visible RAM). Found by the
 * phase-2 PoC on 2026-09-10, whose first run under the worker's configured
 * limit could not set it. A percentage is resolved here against the memory
 * this process is actually allowed (`process.constrainedMemory()` reads the
 * cgroup limit in a container; `os.totalmem()` is the host otherwise) into an
 * absolute `<n>MB`. Absolute values pass through; anything else is null so a
 * typo is "the default applied", visibly, never a silently different ceiling.
 * Exported for tests and mirrored verbatim in the backend's
 * `services/warehouse/duckdb.ts` — keep the two in step.
 */
export function resolveMemoryLimit(raw: string, totalBytes: number): string | null {
  const v = raw.trim();
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(v);
  if (pct) {
    const share = Number(pct[1]);
    if (!(share > 0) || !(totalBytes > 0)) return null;
    const mb = Math.max(64, Math.floor((totalBytes * Math.min(share, 100)) / 100 / (1024 * 1024)));
    return `${mb}MB`;
  }
  if (/^\d+(\.\d+)?\s*[KMGT]?B$/i.test(v)) return v;
  return null;
}

/** Memory this process may use: the cgroup limit inside a container, else the host. */
export function visibleMemoryBytes(): number {
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  return constrained && constrained > 0 ? constrained : os.totalmem();
}

/** Default memory ceiling. Below DuckDB's own 80% default so the Node heap,
 *  the HTTP client's buffers and the child's own overhead have room. */
const DEFAULT_MEMORY_LIMIT = '60%';
/** One thread by default: the sync worker is sized at ≤1 vCPU and extra
 *  threads buy nothing while multiplying per-thread buffers. */
const DEFAULT_THREADS = '1';

/**
 * Apply memory / thread / spill settings to a worker DuckDB session.
 *
 * Never throws: a DuckDB build that does not know one of these settings must
 * not fail a sync over it. Every value is validated against a shape before it
 * reaches SQL — DuckDB has no parameter binding for `SET`, and these come from
 * the environment.
 */
export async function applyWorkerGuardrails(db: Database): Promise<void> {
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT ?? DEFAULT_MEMORY_LIMIT;
  const threads = process.env.DUCKDB_THREADS ?? DEFAULT_THREADS;
  const tempDir = process.env.DUCKDB_TEMP_DIR ?? os.tmpdir();

  // Accepts '512MB' / '1GB' / '60%' — a percentage is resolved to an absolute
  // size first (see `resolveMemoryLimit`: DuckDB 1.4 refuses '%', and the
  // try/catch below is for a build that lacks the SETTING, not for a value
  // it cannot parse). Anything else is ignored rather than substituted — a
  // typo should be visible as "the default applied", not as a silently
  // different ceiling.
  const resolved = resolveMemoryLimit(memoryLimit, visibleMemoryBytes());
  if (resolved) {
    try { await db.exec(`SET memory_limit='${resolved}';`); } catch { /* older build */ }
  }
  if (/^\d+$/.test(threads)) {
    try { await db.exec(`SET threads=${threads};`); } catch { /* older build */ }
  }
  if (tempDir) {
    // Spilling to disk is the whole point of the memory limit: without a temp
    // directory DuckDB raises an out-of-memory error instead of spilling.
    const escaped = tempDir.replace(/\\/g, '/').replace(/'/g, "''");
    try { await db.exec(`SET temp_directory='${escaped}';`); } catch { /* older build */ }
  }
}

/**
 * `Database.create(':memory:')` + guardrails. Use this instead of calling
 * `Database.create` directly so a new write path cannot forget them.
 */
export async function createGuardedDuckDb(): Promise<Database> {
  const { Database } = await import('duckdb-async');
  const db = await Database.create(':memory:');
  await applyWorkerGuardrails(db);
  return db;
}
