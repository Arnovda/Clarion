import sql, { config as SqlConfig, ConnectionPool } from 'mssql';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo, FkCandidate } from './BaseConnector';

export interface MssqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Use Windows Authentication (trusted connection) — ignores user/password */
  windowsAuth?: boolean;
  /** Enable encrypted connection (required for Azure SQL) */
  encrypt?: boolean;
  /** Trust self-signed certificates */
  trustServerCertificate?: boolean;
  schema?: string; // defaults to 'dbo'
}

export class MssqlConnector extends BaseConnector {
  private readonly config: MssqlConnectionConfig;
  private pool: ConnectionPool | null = null;
  private readonly schemaName: string;

  constructor(config: MssqlConnectionConfig) {
    super();
    this.config = config;
    this.schemaName = config.schema ?? 'dbo';
  }

  private buildSqlConfig(): SqlConfig {
    const cfg: SqlConfig = {
      server: this.config.host,
      port: this.config.port,
      database: this.config.database,
      options: {
        encrypt: this.config.encrypt ?? true,
        trustServerCertificate: this.config.trustServerCertificate ?? false,
        connectTimeout: 15_000,
        requestTimeout: 30_000,
      },
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30_000,
      },
    };

    if (this.config.windowsAuth) {
      // Windows Authentication (Trusted Connection)
      // mssql uses NTLM when no user/password provided and domain is set
      cfg.domain = '';
      cfg.user = '';
      cfg.password = '';
      // The mssql driver picks up Windows auth when domain is set
      cfg.options!.trustedConnection = true;
    } else {
      cfg.user = this.config.user;
      cfg.password = this.config.password;
    }

    return cfg;
  }

  async connect(): Promise<void> {
    this.pool = new sql.ConnectionPool(this.buildSqlConfig());
    await this.pool.connect();
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    let pool: ConnectionPool | null = null;
    try {
      pool = new sql.ConnectionPool(this.buildSqlConfig());
      await pool.connect();
      await pool.request().query('SELECT 1 AS test');
      return { ok: true, message: 'Connection successful' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message };
    } finally {
      if (pool) await pool.close();
    }
  }

  async introspectSchema(): Promise<SchemaResult> {
    const pool = this.requirePool();

    const tablesResult = await pool.request()
      .input('schema', sql.NVarChar, this.schemaName)
      .query(
        `SELECT t.name AS table_name
         FROM sys.tables t
         INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
         WHERE s.name = @schema AND t.type = 'U'
         ORDER BY t.name`,
      );

    const tables: TableInfo[] = [];

    for (const row of tablesResult.recordset) {
      const tableName: string = row.table_name;

      const colsResult = await pool.request()
        .input('schema', sql.NVarChar, this.schemaName)
        .input('table', sql.NVarChar, tableName)
        .query(
          `SELECT c.name AS column_name, ty.name AS data_type
           FROM sys.columns c
           INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
           INNER JOIN sys.tables t ON c.object_id = t.object_id
           INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
           WHERE s.name = @schema AND t.name = @table
           ORDER BY c.column_id`,
        );

      const columns: ColumnInfo[] = [];

      for (const col of colsResult.recordset) {
        let sampleValues: unknown[] = [];
        try {
          const samples = await pool.request().query(
            `SELECT DISTINCT TOP 5 [${col.column_name}] AS val
             FROM [${this.schemaName}].[${tableName}]
             WHERE [${col.column_name}] IS NOT NULL`,
          );
          sampleValues = samples.recordset.map((r: { val: unknown }) => r.val);
        } catch {
          // best-effort
        }

        columns.push({
          name: col.column_name,
          type: col.data_type,
          sampleValues,
        });
      }

      tables.push({ tableName, columns });
    }

    const { candidates: fkCandidates, classifications: tableClassifications } =
      await this.detectForeignKeys(tables);

    return { tables, fkCandidates, tableClassifications };
  }

  /**
   * Read declared foreign keys from sys.foreign_key_columns.
   */
  async introspectDeclaredFks(tables: TableInfo[]): Promise<FkCandidate[]> {
    const pool = this.requirePool();
    const tableNames = tables.map((t) => t.tableName);

    // Build a TVP-like IN clause with dynamic SQL is risky; use a temp table instead
    const result = await pool.request()
      .input('schema', sql.NVarChar, this.schemaName)
      .query(
        `SELECT
           OBJECT_NAME(fkc.parent_object_id) AS from_table,
           pc.name AS from_column,
           OBJECT_NAME(fkc.referenced_object_id) AS to_table,
           rc.name AS to_column
         FROM sys.foreign_key_columns fkc
         INNER JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
         INNER JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
         INNER JOIN sys.tables t ON fkc.parent_object_id = t.object_id
         INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
         WHERE s.name = @schema`,
      );

    return result.recordset
      .filter((r: { from_table: string }) => tableNames.includes(r.from_table))
      .map((r: { from_table: string; from_column: string; to_table: string; to_column: string }) => ({
        fromTable: r.from_table,
        fromColumn: r.from_column,
        toTable: r.to_table,
        toColumn: r.to_column,
        source: 'declared' as const,
        confidence: 1.0,
      }));
  }

  async executeQuery(sqlQuery: string): Promise<QueryResult> {
    const pool = this.requirePool();
    const result = await pool.request().query(sqlQuery);
    return { rows: result.recordset, rowCount: result.recordset.length };
  }

  disconnect(): void {
    if (this.pool) {
      this.pool.close().catch(() => {});
      this.pool = null;
    }
  }

  private requirePool(): ConnectionPool {
    if (!this.pool) {
      throw new Error('MssqlConnector: call connect() before using the connector');
    }
    return this.pool;
  }
}
