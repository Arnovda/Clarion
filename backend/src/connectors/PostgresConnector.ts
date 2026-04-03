import { Pool, PoolConfig } from 'pg';
import { BaseConnector, SchemaResult, QueryResult, TableInfo, ColumnInfo, FkCandidate } from './BaseConnector';

export interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  schema?: string; // defaults to 'public'
}

export class PostgresConnector extends BaseConnector {
  private readonly config: PostgresConnectionConfig;
  private pool: Pool | null = null;
  private readonly schemaName: string;

  constructor(config: PostgresConnectionConfig) {
    super();
    this.config = config;
    this.schemaName = config.schema ?? 'public';
  }

  async connect(): Promise<void> {
    const poolConfig: PoolConfig = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };

    if (this.config.ssl === true) {
      poolConfig.ssl = { rejectUnauthorized: false };
    } else if (typeof this.config.ssl === 'object') {
      poolConfig.ssl = this.config.ssl;
    }

    this.pool = new Pool(poolConfig);
    // Verify the connection works
    const client = await this.pool.connect();
    client.release();
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    let pool: Pool | null = null;
    try {
      const poolConfig: PoolConfig = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        max: 1,
        connectionTimeoutMillis: 10_000,
      };

      if (this.config.ssl === true) {
        poolConfig.ssl = { rejectUnauthorized: false };
      } else if (typeof this.config.ssl === 'object') {
        poolConfig.ssl = this.config.ssl;
      }

      pool = new Pool(poolConfig);
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
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

    // Get all user tables in the target schema
    const tablesResult = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [this.schemaName],
    );

    const tables: TableInfo[] = [];

    for (const row of tablesResult.rows) {
      const tableName: string = row.table_name;

      // Get column info
      const colsResult = await pool.query(
        `SELECT column_name, data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [this.schemaName, tableName],
      );

      const columns: ColumnInfo[] = [];

      for (const col of colsResult.rows) {
        let sampleValues: unknown[] = [];
        try {
          const samples = await pool.query(
            `SELECT DISTINCT "${col.column_name}" AS val
             FROM "${this.schemaName}"."${tableName}"
             WHERE "${col.column_name}" IS NOT NULL
             LIMIT 5`,
          );
          sampleValues = samples.rows.map((r: { val: unknown }) => r.val);
        } catch {
          // best-effort
        }

        columns.push({
          name: col.column_name,
          type: col.data_type === 'USER-DEFINED' ? col.udt_name : col.data_type,
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

    const result = await pool.query(
      `SELECT
         kcu.table_name AS from_table,
         kcu.column_name AS from_column,
         ccu.table_name AS to_table,
         ccu.column_name AS to_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         AND kcu.table_name = ANY($2)`,
      [this.schemaName, tableNames],
    );

    return result.rows.map((r: { from_table: string; from_column: string; to_table: string; to_column: string }) => ({
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
    // Set search_path to the configured schema
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${this.schemaName}"`);
      const result = await client.query(sql);
      return { rows: result.rows, rowCount: result.rows.length };
    } finally {
      client.release();
    }
  }

  disconnect(): void {
    if (this.pool) {
      this.pool.end().catch(() => {});
      this.pool = null;
    }
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('PostgresConnector: call connect() before using the connector');
    }
    return this.pool;
  }
}
