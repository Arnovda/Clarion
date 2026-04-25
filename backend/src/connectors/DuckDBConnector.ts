import { Database } from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo } from './BaseConnector';
import { getOrInit, invalidateByPrefix } from './DuckDBPool';

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
    const isAzureUri = (p: string) => p.startsWith('az://') || p.startsWith('abfss://');
    const explicitHasAzure = !!tablePaths && [...tablePaths.values()].some(isAzureUri);
    this.isAzure = isAzureUri(warehousePath) || explicitHasAzure;
    this.warehousePath = isAzureUri(warehousePath) ? warehousePath : path.resolve(warehousePath);
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
    const normalised = warehousePath.startsWith('az://')
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
    // Use LOAD (not INSTALL+LOAD) if extensions are pre-installed in Docker image.
    // Fall back to INSTALL+LOAD for local dev.
    try {
      await db.exec('LOAD delta;');
    } catch {
      await db.exec('INSTALL delta; LOAD delta;');
    }

    if (this.isAzure) {
      try {
        await db.exec('LOAD azure;');
      } catch {
        await db.exec('INSTALL azure; LOAD azure;');
      }

      // Use curl transport — avoids SSL CA cert path issues in Docker containers
      // where DuckDB's default transport expects RHEL cert paths
      await db.exec("SET azure_transport_option_type = 'curl';");

      const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
      if (connStr) {
        // Escape single quotes in connection string
        const escaped = connStr.replace(/'/g, "''");
        await db.exec(`
          CREATE OR REPLACE SECRET azure_secret (
            TYPE AZURE,
            CONNECTION_STRING '${escaped}'
          );
        `);
      } else {
        console.warn('[DuckDBConnector] AZURE_STORAGE_CONNECTION_STRING not set — blob reads will fail');
      }
    }
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
        console.warn(
          `[DuckDBConnector] Failed to create view for ${tableName} (path: ${tPath}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // After views are registered, set search_path so unqualified queries resolve
    // against any of the schemas we just created. Mirrors the notebook pattern.
    if (registeredSchemas.size > 0) {
      const schemaList = [...registeredSchemas]
        .map((s) => `'${s.replace(/'/g, "''")}'`)
        .join(',');
      try {
        await db.exec(`SET search_path = ${schemaList};`);
      } catch (err) {
        console.warn('[DuckDBConnector] Failed to set search_path:', err instanceof Error ? err.message : err);
      }
    }

    console.log(
      `[DuckDBConnector] ${created}/${tableNames.length} views created${failed > 0 ? ` (${failed} failed)` : ''}${registeredSchemas.size > 0 ? ` across ${registeredSchemas.size} schema(s)` : ''} (pooled)`,
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
          console.log(`[DuckDBConnector] introspecting table ${ti + 1}/${tableNames.length}: ${tableName} (${deltaPath})`);
          const viewName = `__introspect_${tableName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
          const viewStart = Date.now();
          await withTimeout(
            this.createDeltaView(db, viewName, deltaPath),
            perTableTimeout,
            `createDeltaView(${tableName})`,
          );
          console.log(`[DuckDBConnector] view created for ${tableName} in ${Date.now() - viewStart}ms`);

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
          console.warn(`[DuckDBConnector] Failed to introspect table ${tableName}:`, err);
        }
      }

      const { candidates: fkCandidates, classifications: tableClassifications } =
        await this.detectForeignKeys(tables);

      return { tables, fkCandidates, tableClassifications };
    } finally {
      try { await db.close(); } catch { /* ignore */ }
    }
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const db = this.requireDb();
    // For ephemeral instances, views are created lazily on first executeQuery.
    // Pooled instances already have all views pre-registered during init.
    if (this.ownsDb && !this.viewsCreated) {
      await this.createAllViews(db);
      this.viewsCreated = true;
    }

    const rawRows = await db.all(sql) as Record<string, unknown>[];
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
      if (explicit.startsWith('az://') || explicit.startsWith('abfss://')) return explicit;
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
      console.warn('[DuckDBConnector] Azure mode requires tableNames in constructor');
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

  /** Create a DuckDB view for a Delta or Parquet table. If `schema` is provided
   *  the view is qualified as "schema"."view"; otherwise it lands in the
   *  default catalog (backward-compatible for callers that pass no schema). */
  private async createDeltaView(
    db: Database,
    viewName: string,
    tablePath: string,
    schema?: string,
  ): Promise<void> {
    const safeView = viewName.replace(/"/g, '""');
    const qualified = schema
      ? `"${schema.replace(/"/g, '""')}"."${safeView}"`
      : `"${safeView}"`;

    if (this.isAzure) {
      // Azure: ETL ingestion writes Delta; product transformations write Parquet
      // (<dir>/data.parquet). Try delta_scan first, fall back to read_parquet.
      const escaped = tablePath.replace(/'/g, "''");
      try {
        await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM delta_scan('${escaped}');`);
        return;
      } catch { /* not a delta table — try parquet */ }
      try {
        await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}/data.parquet');`);
        return;
      } catch { /* fall through */ }
      await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${escaped}/*.parquet');`);
      return;
    }

    // Local: detect Delta vs Parquet
    const localPath = tablePath.replace(/\\/g, '/');
    const deltaLogPath = tablePath.replace(/\//g, path.sep) + path.sep + '_delta_log';

    if (fs.existsSync(deltaLogPath)) {
      await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM delta_scan('${localPath}');`);
    } else {
      await db.exec(`CREATE OR REPLACE VIEW ${qualified} AS SELECT * FROM read_parquet('${localPath}/*.parquet');`);
    }
  }

}
