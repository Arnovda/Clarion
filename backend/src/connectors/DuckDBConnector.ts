import { Database } from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo } from './BaseConnector';
import { getOrInit, invalidateByPrefix, beginQuery, endQuery } from './DuckDBPool';
import {
  isAzurePath,
  setupDuckDBForWarehouse,
  createScanView,
  capResultRows,
} from '../services/warehouse';
import { logger as rootLogger } from '../utils/logger';
import { Semaphore, KeyedSemaphore } from '../utils/semaphore';

const log = rootLogger.child({ mod: 'DuckDBConnector' });

// Bound concurrent DuckDB query execution inside the shared backend process.
// Global cap bounds total in-flight analytical work (blast-radius / OOM
// protection); per-tenant cap adds fairness so one tenant can't take every
// permit. Overridable via env for larger replicas.
const GLOBAL_QUERY_CONCURRENCY = Math.max(1, Number(process.env.DUCKDB_MAX_CONCURRENT_QUERIES) || 6);
const PER_TENANT_QUERY_CONCURRENCY = Math.max(1, Number(process.env.DUCKDB_MAX_CONCURRENT_QUERIES_PER_TENANT) || 2);
// Per-query wall-clock timeout. Frees the caller from a runaway query; note it
// does not interrupt the underlying DuckDB call (duckdb-async has no cancel),
// so the permit is held until the real query settles — true per-query kill is
// the child-process runner pool in a later phase. 0 disables the timeout.
const QUERY_TIMEOUT_MS = Number(process.env.DUCKDB_QUERY_TIMEOUT_MS ?? 45000);

const globalQuerySem = new Semaphore(GLOBAL_QUERY_CONCURRENCY);
const tenantQuerySem = new KeyedSemaphore(PER_TENANT_QUERY_CONCURRENCY);

/** Run a promise with a timeout. Rejects with a clear message if it takes too long. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}


/**
 * DuckDBConnector — reads from Delta Lake tables via DuckDB's delta_scan().
 *
 * Supports two storage modes:
 * - local: reads from filesystem (warehousePath is a local directory)
 * - azure: reads from Azure Blob Storage (warehousePath starts with "az://")
 *
 * When using Azure, the azure + delta extensions are loaded and an Azure secret
 * is created using the AZURE_STORAGE_CONNECTION_STRING env var.
 *
 * Connection lifecycle:
 * - Default (hot path): `connect()` fetches a shared, view-prepared DuckDB
 *   instance from `DuckDBPool`. `disconnect()` releases the reference without
 *   closing the underlying DB — the pool manages lifecycle (idle eviction +
 *   explicit `invalidateWarehouse()` after writes).
 * - Ephemeral: `DuckDBConnector.ephemeral(...)` returns a connector that
 *   owns its own throwaway instance. Used for introspection / schema profiling
 *   where we create temp views with per-table timeouts.
 */
export class DuckDBConnector extends BaseConnector {
  private readonly warehousePath: string;
  private readonly isAzure: boolean;
  private readonly tableNames: string[];
  /** Explicit table → directory path mapping (used for cross-product warehouse access) */
  private readonly tablePaths: Map<string, string>;
  /** Optional table → schema name mapping. When set, views are created as
   *  "<schema>"."<table>" and `search_path` is set so unqualified queries also
   *  resolve. Mirrors the notebook namespacing pattern. */
  private readonly tableSchemas: Map<string, string>;
  private db: Database | null = null;
  private viewsCreated = false;
  private ownsDb = false;
  /** Pool cache key for this connector (pooled mode only); lets executeQuery
   *  register in-flight queries so the pool won't evict a busy instance. */
  private poolKey: string | null = null;

  /**
   * @param warehousePath - Local path or az:// blob URI
   * @param tableNames - Optional list of known table names (from ingested_tables DB).
   *   Required for Azure mode since we can't scan blob directories.
   *   For local mode, falls back to filesystem scanning if not provided.
   * @param tablePaths - Optional explicit mapping of table_name → directory path.
   *   When provided, takes precedence over warehousePath-based path building.
   *   Used for product layer queries where tables span multiple warehouse directories.
   * @param tableSchemas - Optional mapping of table_name → schema name. When set,
   *   each view is created as "<schema>"."<table>" and a `search_path` covering
   *   all distinct schemas is set after view registration, so unqualified queries
   *   continue to resolve.
   */
  constructor(
    warehousePath: string,
    tableNames?: string[],
    tablePaths?: Map<string, string>,
    tableSchemas?: Map<string, string>,
  ) {
    super();
    const explicitHasAzure = !!tablePaths && [...tablePaths.values()].some(isAzurePath);
    this.isAzure = isAzurePath(warehousePath) || explicitHasAzure;
    this.warehousePath = isAzurePath(warehousePath) ? warehousePath : path.resolve(warehousePath);
    this.tableNames = tableNames ?? [];
    this.tablePaths = tablePaths ?? new Map();
    this.tableSchemas = tableSchemas ?? new Map();
  }

  /**
   * Opt-in ephemeral mode: this instance will create and close its own DuckDB,
   * bypassing the shared pool. Used by introspection paths that set up
   * per-table scratch views.
   */
  static ephemeral(
    warehousePath: string,
    tableNames?: string[],
    tablePaths?: Map<string, string>,
    tableSchemas?: Map<string, string>,
  ): DuckDBConnector {
    const c = new DuckDBConnector(warehousePath, tableNames, tablePaths, tableSchemas);
    c.ownsDb = true;
    return c;
  }

  /** Invalidate any pooled entries whose key begins with this warehouse path. */
  static async invalidateWarehouse(warehousePath: string): Promise<void> {
    const normalised = isAzurePath(warehousePath)
      ? warehousePath
      : path.resolve(warehousePath);
    await invalidateByPrefix(`duckdb:${normalised}`);
  }

  async connect(): Promise<void> {
    // Skip warehouse path check if we have explicit table paths (cross-product mode)
    if (!this.isAzure && this.tablePaths.size === 0 && !fs.existsSync(this.warehousePath)) {
      throw new Error(`Warehouse directory not found: ${this.warehousePath}`);
    }

    if (this.ownsDb) {
      this.db = await Database.create(':memory:');
      await this.loadExtensions(this.db);
      return;
    }

    // Pooled path — views are pre-registered during init, so executeQuery is immediate.
    const cacheKey = this.cacheKey();
    this.poolKey = cacheKey;
    this.db = await getOrInit(cacheKey, async (db) => {
      await this.loadExtensions(db);
      await this.createAllViews(db);
    });
    this.viewsCreated = true;
  }

  /** Build a stable cache key covering warehouse + every table path this connector exposes. */
  private cacheKey(): string {
    const mode = this.isAzure ? 'az' : 'local';
    const names = [...this.tableNames].sort().join(',');
    const explicit = [...this.tablePaths.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, p]) => `${n}=${p}`)
      .join(',');
    const schemas = [...this.tableSchemas.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, s]) => `${n}=${s}`)
      .join(',');
    return `duckdb:${this.warehousePath}|${mode}|n:${names}|x:${explicit}|s:${schemas}`;
  }

  private async loadExtensions(db: Database): Promise<void> {
    await setupDuckDBForWarehouse(db, this.isAzure);
  }

  private async createAllViews(db: Database): Promise<void> {
    const tableNames = this.getTableNames();
    const registeredSchemas = new Set<string>();
    let created = 0;
    let failed = 0;
    for (const tableName of tableNames) {
      const tPath = this.tablePath(tableName);
      const schema = this.tableSchemas.get(tableName);
      try {
        if (schema) {
          await db.exec(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '""')}";`);
          registeredSchemas.add(schema);
        }
        await this.createDeltaView(db, tableName, tPath, schema);
        created++;
      } catch (err) {
        failed++;
        log.warn(
          { err },
          `Failed to create view for ${tableName} (path: ${tPath})`,
        );
      }
    }

    // After views are registered, set search_path so unqualified queries resolve
    // against any of the schemas we just created. Mirrors the notebook pattern.
    if (registeredSchemas.size > 0) {
      // DuckDB SET takes a single scalar string value: comma-separated names inside one quoted string.
      const schemaList = [...registeredSchemas]
        .map((s) => s.replace(/'/g, "''"))
        .join(',');
      try {
        await db.exec(`SET search_path = '${schemaList}';`);
      } catch (err) {
        log.warn({ err }, 'Failed to set search_path');
      }
    }

    log.info(
      `${created}/${tableNames.length} views created${failed > 0 ? ` (${failed} failed)` : ''}${registeredSchemas.size > 0 ? ` across ${registeredSchemas.size} schema(s)` : ''} (pooled)`,
    );
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!this.isAzure && !fs.existsSync(this.warehousePath)) {
        return { ok: false, message: `Warehouse directory not found: ${this.warehousePath}` };
      }
      const db = await Database.create(':memory:');
      await db.exec('INSTALL delta; LOAD delta;');
      if (this.isAzure) {
        await db.exec('INSTALL azure; LOAD azure;');
        await db.exec("SET azure_transport_option_type = 'curl';");
      }
      await db.exec('SELECT 1');
      await db.close();
      return { ok: true, message: `DuckDB connection successful (${this.isAzure ? 'azure' : 'local'})` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message };
    }
  }

  async introspectSchema(): Promise<SchemaResult> {
    // Introspection mutates scratch views on the DB — always use a fresh
    // ephemeral instance so we never touch the pooled query DB.
    const db = await Database.create(':memory:');
    try {
      await this.loadExtensions(db);
      const tables: TableInfo[] = [];

      const tableNames = this.getTableNames();
      // Timeout per table: 60s for Azure (network I/O), 30s for local
      const perTableTimeout = this.isAzure ? 60_000 : 30_000;

      for (let ti = 0; ti < tableNames.length; ti++) {
        const tableName = tableNames[ti];
        const deltaPath = this.tablePath(tableName);

        try {
          log.info(`introspecting table ${ti + 1}/${tableNames.length}: ${tableName} (${deltaPath})`);
          const viewName = `__introspect_${tableName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          const viewStart = Date.now();
          await withTimeout(
            this.createDeltaView(db, viewName, deltaPath),
            perTableTimeout,
            `createDeltaView(${tableName})`,
          );
          log.info(`view created for ${tableName} in ${Date.now() - viewStart}ms`);

          const colRows = await db.all(`DESCRIBE "${viewName}"`) as Array<{
            column_name: string;
            column_type: string;
          }>;

          const columns: ColumnInfo[] = [];
          for (const col of colRows) {
            let sampleValues: unknown[] = [];
            try {
              const samples = await withTimeout(
                db.all(
                  `SELECT DISTINCT "${col.column_name}" AS val
                   FROM "${viewName}"
                   WHERE "${col.column_name}" IS NOT NULL
                   LIMIT 5`,
                ),
                perTableTimeout,
                `sample ${tableName}.${col.column_name}`,
              );
              sampleValues = samples.map((r: { val: unknown }) => {
                const v = (r as { val: unknown }).val;
                return typeof v === 'bigint' ? Number(v) : v;
              });
            } catch {
              // Sampling is best-effort
            }

            columns.push({
              name: col.column_name,
              type: col.column_type || 'VARCHAR',
              sampleValues,
            });
          }

          tables.push({ tableName, columns });
          await db.exec(`DROP VIEW IF EXISTS "${viewName}"`);
        } catch (err) {
          log.warn({ err }, `Failed to introspect table ${tableName}`);
        }
      }

      const { candidates: fkCandidates, classifications: tableClassifications } =
        await this.detectForeignKeys(tables);

      return { tables, fkCandidates, tableClassifications };
    } finally {
      try { await db.close(); } catch { /* ignore */ }
    }
  }

  /** Stable per-tenant key for concurrency fairness. In the v2 warehouse
   *  layout the warehouse path is tenant-prefixed (`.../tenant_<id>/...`), so we
   *  key on that prefix; otherwise fall back to the full warehouse path. */
  private tenantKey(): string {
    const m = /tenant[_-]\d+/i.exec(this.warehousePath);
    return m ? m[0].toLowerCase() : this.warehousePath;
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const db = this.requireDb();
    // For ephemeral instances, views are created lazily on first executeQuery.
    // Pooled instances already have all views pre-registered during init.
    if (this.ownsDb && !this.viewsCreated) {
      await this.createAllViews(db);
      this.viewsCreated = true;
    }

    // Bound concurrency before running the query. Acquire the PER-TENANT
    // permit FIRST, then the global one: a caller queued on its own per-tenant
    // limit must not hold a global permit while it waits, or one busy tenant
    // could occupy every global permit and starve the others (priority
    // inversion). This way a tenant only consumes a global permit once it has
    // cleared its own gate.
    const releaseTenant = await tenantQuerySem.acquire(this.tenantKey());
    let releaseGlobal: () => void;
    try {
      releaseGlobal = await globalQuerySem.acquire();
    } catch (err) {
      releaseTenant();
      throw err;
    }

    // Register this query with the pool so a busy shared instance is never
    // evicted / closed mid-flight (no-op for ephemeral instances).
    const poolEntry = this.poolKey ? beginQuery(this.poolKey) : null;

    // Kick off the query, guarding against a synchronous throw (e.g. from
    // capResultRows) leaking the permits we just took.
    let queryPromise: Promise<Record<string, unknown>[]>;
    try {
      queryPromise = db.all(capResultRows(sql)) as Promise<Record<string, unknown>[]>;
    } catch (err) {
      endQuery(poolEntry);
      releaseGlobal();
      releaseTenant();
      throw err;
    }
    // Release permits + the pool ref when the query TRULY settles (not when the
    // wall-clock timeout below fires), so concurrency accounting stays honest
    // even if the caller has already given up on the result.
    queryPromise.then(
      () => { endQuery(poolEntry); releaseGlobal(); releaseTenant(); },
      () => { endQuery(poolEntry); releaseGlobal(); releaseTenant(); },
    );

    const rawRows = QUERY_TIMEOUT_MS > 0
      ? await withTimeout(queryPromise, QUERY_TIMEOUT_MS, 'DuckDB query')
      : await queryPromise;

    const rows = rawRows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === 'bigint' ? Number(v) : v;
      }
      return out;
    });
    return { rows, rowCount: rows.length };
  }

  disconnect(): void {
    if (this.ownsDb && this.db) {
      this.db.close().catch(() => {});
    }
    // Pooled mode: just release our reference; the pool owns the DB.
    this.db = null;
    this.viewsCreated = false;
    this.poolKey = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('DuckDBConnector: call connect() before using the connector');
    }
    return this.db;
  }

  /** Build the full path/URI for a table within this warehouse. */
  private tablePath(tableName: string): string {
    // If explicit path mapping exists, use it (cross-product warehouse access)
    const explicit = this.tablePaths.get(tableName);
    if (explicit) {
      if (isAzurePath(explicit)) return explicit;
      return path.resolve(explicit).replace(/\\/g, '/');
    }

    if (this.isAzure) {
      // az://warehouse/tenant_1/conn_4/orders
      return `${this.warehousePath}/${tableName}`;
    }
    return path.join(this.warehousePath, tableName).replace(/\\/g, '/');
  }

  /** Get list of table names — from explicit paths, constructor arg, or filesystem scan. */
  private getTableNames(): string[] {
    // Merge explicit table paths with provided table names (dedup)
    const names = new Set<string>(this.tableNames);
    for (const key of this.tablePaths.keys()) {
      names.add(key);
    }
    if (names.size > 0) {
      return [...names];
    }

    // Fallback: scan local filesystem (only works in local mode)
    if (this.isAzure) {
      log.warn('Azure mode requires tableNames in constructor');
      return [];
    }

    if (!fs.existsSync(this.warehousePath)) return [];

    return fs.readdirSync(this.warehousePath, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (fs.existsSync(path.join(this.warehousePath, e.name, '_delta_log'))) return true;
        const files = fs.readdirSync(path.join(this.warehousePath, e.name));
        return files.some((f) => f.endsWith('.parquet'));
      })
      .map((e) => e.name);
  }

  /**
   * Create a DuckDB view for a Delta or Parquet table — delegates to the
   * shared warehouse `createScanView` so every surface in the codebase
   * registers views the same way.
   */
  private async createDeltaView(
    db: Database,
    viewName: string,
    tablePath: string,
    schema?: string,
  ): Promise<void> {
    await createScanView(db, viewName, tablePath, schema ? { schema } : undefined);
  }

}
