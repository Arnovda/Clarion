import { Database } from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo } from './BaseConnector';

/**
 * DuckDBConnector — reads from Delta Lake tables via DuckDB's delta_scan().
 *
 * Supports two storage modes:
 * - local: reads from filesystem (warehousePath is a local directory)
 * - azure: reads from Azure Blob Storage (warehousePath starts with "az://")
 *
 * When using Azure, the azure + delta extensions are loaded and an Azure secret
 * is created using the AZURE_STORAGE_CONNECTION_STRING env var.
 */
export class DuckDBConnector extends BaseConnector {
  private readonly warehousePath: string;
  private readonly isAzure: boolean;
  private readonly tableNames: string[];
  private db: Database | null = null;

  /**
   * @param warehousePath - Local path or az:// blob URI
   * @param tableNames - Optional list of known table names (from ingested_tables DB).
   *   Required for Azure mode since we can't scan blob directories.
   *   For local mode, falls back to filesystem scanning if not provided.
   */
  constructor(warehousePath: string, tableNames?: string[]) {
    super();
    this.isAzure = warehousePath.startsWith('az://');
    this.warehousePath = this.isAzure ? warehousePath : path.resolve(warehousePath);
    this.tableNames = tableNames ?? [];
  }

  async connect(): Promise<void> {
    if (!this.isAzure && !fs.existsSync(this.warehousePath)) {
      throw new Error(`Warehouse directory not found: ${this.warehousePath}`);
    }

    this.db = await Database.create(':memory:');

    // Use LOAD (not INSTALL+LOAD) if extensions are pre-installed in Docker image.
    // Fall back to INSTALL+LOAD for local dev.
    try {
      await this.db.exec('LOAD delta;');
    } catch {
      await this.db.exec('INSTALL delta; LOAD delta;');
    }

    if (this.isAzure) {
      try {
        await this.db.exec('LOAD azure;');
      } catch {
        await this.db.exec('INSTALL azure; LOAD azure;');
      }
      const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
      if (connStr) {
        // Escape single quotes in connection string
        const escaped = connStr.replace(/'/g, "''");
        await this.db.exec(`
          CREATE SECRET azure_secret (
            TYPE AZURE,
            CONNECTION_STRING '${escaped}'
          );
        `);
      } else {
        console.warn('[DuckDBConnector] AZURE_STORAGE_CONNECTION_STRING not set — blob reads will fail');
      }
    }
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
    const db = this.requireDb();
    const tables: TableInfo[] = [];

    // Get table names: from constructor arg or filesystem scan
    const tableNames = this.getTableNames();

    for (const tableName of tableNames) {
      const deltaPath = this.tablePath(tableName);

      try {
        const viewName = `__introspect_${tableName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        await this.createDeltaView(db, viewName, deltaPath);

        const colRows = await db.all(`DESCRIBE "${viewName}"`) as Array<{
          column_name: string;
          column_type: string;
        }>;

        const columns: ColumnInfo[] = [];
        for (const col of colRows) {
          let sampleValues: unknown[] = [];
          try {
            const samples = await db.all(
              `SELECT DISTINCT "${col.column_name}" AS val
               FROM "${viewName}"
               WHERE "${col.column_name}" IS NOT NULL
               LIMIT 5`,
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
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const db = this.requireDb();
    await this.ensureDeltaViews(db);

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
    if (this.db) {
      this.db.close().catch(() => {});
      this.db = null;
    }
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
    if (this.isAzure) {
      // az://warehouse/tenant_1/conn_4/orders
      return `${this.warehousePath}/${tableName}`;
    }
    return path.join(this.warehousePath, tableName).replace(/\\/g, '/');
  }

  /** Get list of table names — from constructor or filesystem scan. */
  private getTableNames(): string[] {
    if (this.tableNames.length > 0) {
      return this.tableNames;
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

  /** Create a DuckDB view for a Delta or Parquet table. */
  private async createDeltaView(db: Database, viewName: string, tablePath: string): Promise<void> {
    if (this.isAzure) {
      // Azure: always use delta_scan (ETL writes Delta format)
      await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM delta_scan('${tablePath.replace(/'/g, "''")}');`);
      return;
    }

    // Local: detect Delta vs Parquet
    const localPath = tablePath.replace(/\\/g, '/');
    const deltaLogPath = tablePath.replace(/\//g, path.sep) + path.sep + '_delta_log';

    if (fs.existsSync(deltaLogPath)) {
      await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM delta_scan('${localPath}');`);
    } else {
      await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${localPath}/*.parquet');`);
    }
  }

  /**
   * Creates DuckDB views for every table in the warehouse,
   * so plain SQL queries like `SELECT * FROM orders` work transparently.
   */
  private async ensureDeltaViews(db: Database): Promise<void> {
    const tableNames = this.getTableNames();

    for (const tableName of tableNames) {
      const tPath = this.tablePath(tableName);
      try {
        await this.createDeltaView(db, tableName, tPath);
      } catch (err) {
        console.warn(`[DuckDBConnector] Failed to create view for ${tableName}:`, err);
      }
    }
  }
}
