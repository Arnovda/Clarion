import mysql, { Pool, PoolOptions } from 'mysql2/promise';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo, FkCandidate } from './BaseConnector';

export interface MysqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

export class MysqlConnector extends BaseConnector {
  private readonly config: MysqlConnectionConfig;
  private pool: Pool | null = null;

  constructor(config: MysqlConnectionConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    const opts: PoolOptions = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 10_000,
    };

    if (this.config.ssl === true) {
      opts.ssl = { rejectUnauthorized: false };
    } else if (typeof this.config.ssl === 'object') {
      opts.ssl = this.config.ssl;
    }

    this.pool = mysql.createPool(opts);
    // Verify the connection works
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    let pool: Pool | null = null;
    try {
      const opts: PoolOptions = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        waitForConnections: true,
        connectionLimit: 1,
        connectTimeout: 10_000,
      };

      if (this.config.ssl === true) {
        opts.ssl = { rejectUnauthorized: false };
      } else if (typeof this.config.ssl === 'object') {
        opts.ssl = this.config.ssl;
      }

      pool = mysql.createPool(opts);
      const conn = await pool.getConnection();
      await conn.query('SELECT 1');
      conn.release();
      return { ok: true, message: 'Connection successful' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, message };
    } finally {
      if (pool) await pool.end();
    }
  }

  async introspectSchema(): Promise<SchemaResult> {
    const pool = this.requirePool();

    const [tableRows] = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [this.config.database],
    );

    const tables: TableInfo[] = [];

    for (const row of tableRows as Array<{ table_name: string }>) {
      const tableName = row.table_name;

      const [colRows] = await pool.query(
        `SELECT column_name, data_type, column_type
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [this.config.database, tableName],
      );

      const columns: ColumnInfo[] = [];

      for (const col of colRows as Array<{ column_name: string; data_type: string; column_type: string }>) {
        let sampleValues: unknown[] = [];
        try {
          const [samples] = await pool.query(
            `SELECT DISTINCT \`${col.column_name}\` AS val
             FROM \`${tableName}\`
             WHERE \`${col.column_name}\` IS NOT NULL
             LIMIT 5`,
          );
          sampleValues = (samples as Array<{ val: unknown }>).map((r) => r.val);
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
   * Read declared foreign keys from information_schema.
   */
  async introspectDeclaredFks(tables: TableInfo[]): Promise<FkCandidate[]> {
    const pool = this.requirePool();
    const tableNames = tables.map((t) => t.tableName);
    const placeholders = tableNames.map(() => '?').join(',');

    const [rows] = await pool.query(
      `SELECT
         kcu.TABLE_NAME AS from_table,
         kcu.COLUMN_NAME AS from_column,
         kcu.REFERENCED_TABLE_NAME AS to_table,
         kcu.REFERENCED_COLUMN_NAME AS to_column
       FROM information_schema.KEY_COLUMN_USAGE kcu
       WHERE kcu.TABLE_SCHEMA = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         AND kcu.TABLE_NAME IN (${placeholders})`,
      [this.config.database, ...tableNames],
    );

    return (rows as Array<{ from_table: string; from_column: string; to_table: string; to_column: string }>).map((r) => ({
      fromTable: r.from_table,
      fromColumn: r.from_column,
      toTable: r.to_table,
      toColumn: r.to_column,
      source: 'declared' as const,
      confidence: 1.0,
    }));
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const pool = this.requirePool();
    const [rows] = await pool.query(sql);
    const resultRows = rows as Record<string, unknown>[];
    return { rows: resultRows, rowCount: resultRows.length };
  }

  disconnect(): void {
    if (this.pool) {
      this.pool.end().catch(() => {});
      this.pool = null;
    }
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('MysqlConnector: call connect() before using the connector');
    }
    return this.pool;
  }
}
