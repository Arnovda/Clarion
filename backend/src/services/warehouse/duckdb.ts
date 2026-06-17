/**
 * DuckDB session setup for warehouse access.
 *
 * Encapsulates the Azure extension dance (LOAD azure, set curl
 * transport, register secret). One implementation, called by every
 * surface that opens its own DuckDB session.
 */

import type { Database } from 'duckdb-async';

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
