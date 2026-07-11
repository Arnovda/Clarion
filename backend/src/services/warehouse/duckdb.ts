/**
 * DuckDB session setup for warehouse access.
 *
 * Encapsulates the Azure extension dance (LOAD azure, set curl
 * transport, register secret). One implementation, called by every
 * surface that opens its own DuckDB session.
 */

import os from 'os';
import type { Database } from 'duckdb-async';

/**
 * Apply memory / thread / spill guardrails to a DuckDB session. Idempotent
 * and defensive: every setting is wrapped so an older DuckDB build that
 * doesn't recognise a pragma simply skips it rather than failing session
 * setup. Tunable via env:
 *
 *   • DUCKDB_MEMORY_LIMIT   — e.g. '512MB', '1GB' (default '70%').
 *   • DUCKDB_THREADS        — integer (default '2').
 *   • DUCKDB_TEMP_DIR       — spill directory (default the OS temp dir).
 *                             Set to '' to disable spilling explicitly.
 */
export async function applyResourceGuardrails(db: Database): Promise<void> {
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT ?? '70%';
  const threads = process.env.DUCKDB_THREADS ?? '2';
  const tempDir = process.env.DUCKDB_TEMP_DIR ?? os.tmpdir();

  // memory_limit accepts values like '512MB' / '1GB' / '70%'. Reject anything
  // that isn't one of those shapes so a bad env var can't inject SQL.
  if (/^\d+(\.\d+)?\s*(%|[KMGT]?B)$/i.test(memoryLimit)) {
    try { await db.exec(`SET memory_limit='${memoryLimit}';`); } catch { /* older build */ }
  }
  if (/^\d+$/.test(threads)) {
    try { await db.exec(`SET threads=${threads};`); } catch { /* older build */ }
  }
  if (tempDir) {
    const escaped = tempDir.replace(/\\/g, '/').replace(/'/g, "''");
    try { await db.exec(`SET temp_directory='${escaped}';`); } catch { /* older build */ }
  }
}

/**
 * Default cap on rows a single query may materialise into Node memory.
 * `memory_limit` bounds DuckDB's own memory (and spills to disk); this bounds
 * the *Node* heap against `db.all()` inflating a multi-million-row result into
 * JS objects. Env-tunable via `DUCKDB_MAX_RESULT_ROWS`; set to 0 to disable.
 */
function maxResultRows(): number {
  const raw = process.env.DUCKDB_MAX_RESULT_ROWS;
  if (raw === undefined) return 100_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 100_000;
}

/**
 * Wrap a single SELECT/WITH statement to cap the rows it returns. Returns the
 * SQL unchanged when capping doesn't apply — a multi-statement script, a
 * non-SELECT (notebook DDL / PRAGMA / COPY), or when the cap is disabled — so
 * this is safe to apply to every read without breaking the notebook surface.
 *
 * Pure string function (no DuckDB dependency) so it's unit-testable without a
 * native build.
 */
export function capResultRows(sql: string, cap = maxResultRows()): string {
  if (!cap || cap <= 0) return sql;
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (trimmed.includes(';')) return sql;              // multiple statements — leave alone
  if (!/^(select|with)\b/i.test(trimmed)) return sql; // not a read query
  return `SELECT * FROM (\n${trimmed}\n) AS _clarion_capped LIMIT ${Math.floor(cap)}`;
}

/**
 * Load the Delta and (if needed) Azure DuckDB extensions and register
 * Azure credentials. Idempotent — safe to call multiple times on the
 * same session.
 *
 * @param db        The DuckDB session.
 * @param needAzure Whether the session will read/write Azure Blob URIs.
 */
export async function setupDuckDBForWarehouse(
  db: Database,
  needAzure: boolean,
): Promise<void> {
  // ─── Resource guardrails ────────────────────────────────────────────────
  // Without these, DuckDB defaults to ~80% of container RAM and one thread
  // per core. On a 1 GB API replica, a couple of concurrent heavy analytical
  // scans (AI-generated SQL can touch any columns, no index to lean on) is a
  // direct OOM → container kill. We bound memory and threads, and point
  // `temp_directory` at scratch space so a query that exceeds the memory
  // budget SPILLS TO DISK and degrades gracefully instead of failing or
  // OOM-killing the process. All env-tunable; defaults are conservative and
  // safe for a 1 GB replica.
  await applyResourceGuardrails(db);

  // Delta extension is needed for both modes — source connector
  // ingestion writes Delta, even when the warehouse root is local.
  try {
    await db.exec('LOAD delta;');
  } catch {
    await db.exec('INSTALL delta; LOAD delta;');
  }

  // Read-path caching — a free latency win on the long-lived pooled session.
  // `enable_object_cache` keeps Parquet metadata (footers + column stats) in
  // memory across queries, so repeated dashboard scans of the same table skip
  // re-parsing the footer. Safe for us: nothing writes through this session, and
  // the pool entry is invalidated (dropped + rebuilt) whenever data is
  // refreshed — so the cache can never go stale within a session. Wrapped in
  // try/catch in case an older DuckDB build doesn't know the pragma.
  try {
    await db.exec('PRAGMA enable_object_cache=true;');
  } catch {
    /* older DuckDB — ignore, just no metadata cache */
  }

  if (!needAzure) return;

  try {
    await db.exec('LOAD azure;');
  } catch {
    await db.exec('INSTALL azure; LOAD azure;');
  }

  // curl transport — avoids SSL CA cert path issues in Docker containers
  // where DuckDB's default transport expects RHEL cert paths.
  await db.exec("SET azure_transport_option_type = 'curl';");

  // Cache HTTP metadata (HEAD / range-request headers) so repeat blob reads of
  // the same file skip re-fetching metadata over the network — the dominant
  // cost on a cold dashboard widget. Same safety argument as object cache:
  // read-only session, invalidated on refresh. No-op on builds without it.
  try {
    await db.exec('SET enable_http_metadata_cache=true;');
  } catch {
    /* setting absent on this build — ignore */
  }

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
  if (!connStr) {
    console.warn('[warehouse] AZURE_STORAGE_CONNECTION_STRING not set — blob reads will fail');
    return;
  }

  const escaped = connStr.replace(/'/g, "''");
  // CREATE OR REPLACE so re-loading the extension on the same session
  // doesn't error on an existing secret.
  await db.exec(`
    CREATE OR REPLACE SECRET azure_secret (
      TYPE AZURE,
      CONNECTION_STRING '${escaped}'
    );
  `);
}
