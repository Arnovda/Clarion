import { Database } from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo } from './BaseConnector';

/**
 * DuckDBConnector — reads from Delta Lake tables on disk via DuckDB's delta_scan().
 *
 * Each table lives at: {warehousePath}/{tableName}/ (a Delta Lake directory).
 * DuckDB is used as an in-process analytical engine — no server needed.
 */
export class DuckDBConnector extends BaseConnector {
  private readonly warehousePath: string;
  private db: Database | null = null;

  constructor(warehousePath: string) {
    super();
    this.warehousePath = path.resolve(warehousePath);
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.warehousePath)) {
      throw new Error(`Warehouse directory not found: ${this.warehousePath}`);
    }
    // In-memory DuckDB instance — no state file needed
    this.db = await Database.create(':memory:');
    // Load the Delta extension (bundled with duckdb-async)
    // DuckDB auto-installs extensions on first use, but we install explicitly for clarity
    await this.db.exec('INSTALL delta; LOAD delta;');
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!fs.existsSync(this.warehousePath)) {
        return { ok: false, message: `Warehouse directory not found: ${this.warehousePath}` };
      }
      const db = await Database.create(':memory:');
      await db.exec('INSTALL delta; LOAD delta;');
      await db.exec('SELECT 1');
      await db.close();
      return { ok: true, message: 'DuckDB connection successful' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message };
    }
  }

  async introspectSchema(): Promise<SchemaResult> {
    const db = this.requireDb();
    const tables: TableInfo[] = [];

    // List directories in the warehouse that have a _delta_log folder or .parquet files
    const entries = fs.readdirSync(this.warehousePath, { withFileTypes: true });
    const deltaTableDirs = entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        // Delta Lake table
        if (fs.existsSync(path.join(this.warehousePath, e.name, '_delta_log'))) return true;
        // Parquet table (product layer)
        const files = fs.readdirSync(path.join(this.warehousePath, e.name));
        return files.some((f) => f.endsWith('.parquet'));
      })
      .map((e) => e.name);

    for (const tableName of deltaTableDirs) {
      const deltaPath = path.join(this.warehousePath, tableName).replace(/\\/g, '/');

      try {
        // Create a view so we can query column info
        const viewName = `__introspect_${tableName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        const hasDeltaLog = fs.existsSync(path.join(this.warehousePath, tableName, '_delta_log'));
        if (hasDeltaLog) {
          await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM delta_scan('${deltaPath}')`);
        } else {
          await db.exec(`CREATE OR REPLACE VIEW "${viewName}" AS SELECT * FROM read_parquet('${deltaPath}/*.parquet')`);
        }

        // Get column info via DESCRIBE
        const colRows = await db.all(`DESCRIBE "${viewName}"`) as Array<{
          column_name: string;
          column_type: string;
        }>;

        const columns: ColumnInfo[] = [];
        for (const col of colRows) {
          // Sample up to 5 distinct non-null values
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

        // Clean up the temporary view
        await db.exec(`DROP VIEW IF EXISTS "${viewName}"`);
      } catch (err) {
        console.warn(`[DuckDBConnector] Failed to introspect table ${tableName}:`, err);
      }
    }

    // Run FK detection from BaseConnector (heuristic layers)
    const { candidates: fkCandidates, classifications: tableClassifications } =
      await this.detectForeignKeys(tables);

    return { tables, fkCandidates, tableClassifications };
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const db = this.requireDb();

    // Replace bare table names with delta_scan() calls.
    // This is needed because DuckDB doesn't know about our Delta tables as native tables.
    // We create temp views for all known Delta tables first.
    await this.ensureDeltaViews(db);

    const rawRows = await db.all(sql) as Record<string, unknown>[];
    // DuckDB returns BigInt for integer columns — convert to Number for JS compatibility
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
      // duckdb-async close() is async but disconnect() is sync in the interface.
      // We close in the background — DuckDB in-memory instances clean up fast.
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

  /**
   * Creates DuckDB views for every Delta or Parquet table in the warehouse,
   * so plain SQL queries like `SELECT * FROM orders` work transparently.
   *
   * Detection order:
   * 1. Directory with _delta_log → delta_scan()
   * 2. Directory with .parquet files → read_parquet(glob)
   * 3. Skip
   */
  private async ensureDeltaViews(db: Database): Promise<void> {
    const entries = fs.readdirSync(this.warehousePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = path.join(this.warehousePath, entry.name).replace(/\\/g, '/');
      const deltaLogPath = path.join(this.warehousePath, entry.name, '_delta_log');

      try {
        if (fs.existsSync(deltaLogPath)) {
          // Delta Lake table
          await db.exec(`CREATE OR REPLACE VIEW "${entry.name}" AS SELECT * FROM delta_scan('${dirPath}')`);
        } else {
          // Check for Parquet files (product layer tables)
          const files = fs.readdirSync(path.join(this.warehousePath, entry.name));
          const hasParquet = files.some((f) => f.endsWith('.parquet'));
          if (hasParquet) {
            await db.exec(`CREATE OR REPLACE VIEW "${entry.name}" AS SELECT * FROM read_parquet('${dirPath}/*.parquet')`);
          }
        }
      } catch (err) {
        console.warn(`[DuckDBConnector] Failed to create view for ${entry.name}:`, err);
      }
    }
  }
}
