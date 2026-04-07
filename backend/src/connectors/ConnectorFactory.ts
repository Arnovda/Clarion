import { BaseConnector } from './BaseConnector';
import { SqliteConnector } from './SqliteConnector';
import { DuckDBConnector } from './DuckDBConnector';
import { PostgresConnector, PostgresConnectionConfig } from './PostgresConnector';
import { MysqlConnector, MysqlConnectionConfig } from './MysqlConnector';
import { MssqlConnector, MssqlConnectionConfig } from './MssqlConnector';
import { decryptCredentials, isEncrypted } from '../utils/crypto';

interface ConnectionRow {
  id: number;
  type: string;
  config: string | Record<string, unknown>;
  query_engine?: string;       // 'source' | 'duckdb'
  warehouse_path?: string | null;
  ingestion_status?: string | null;
}

/**
 * Parse and optionally decrypt the config JSON stored in the connections table.
 */
function parseConfig(raw: string | Record<string, unknown>): Record<string, unknown> {
  // JSONB columns return a parsed object
  if (typeof raw === 'object') {
    // Check if it's a wrapped encrypted config: { encrypted: "enc:..." }
    if (raw.encrypted && typeof raw.encrypted === 'string' && isEncrypted(raw.encrypted)) {
      return JSON.parse(decryptCredentials(raw.encrypted));
    }
    return raw;
  }
  // String config — check if encrypted
  if (isEncrypted(raw)) {
    return JSON.parse(decryptCredentials(raw));
  }
  return JSON.parse(raw);
}

/**
 * Creates the appropriate source connector based on connection type.
 */
function buildSourceConnector(type: string, config: Record<string, unknown>): BaseConnector {
  switch (type) {
    case 'sqlite':
      return new SqliteConnector(config.filepath as string);

    case 'postgres':
    case 'postgresql': {
      const pgConfig: PostgresConnectionConfig = {
        host: (config.host as string) ?? 'localhost',
        port: Number(config.port) || 5432,
        database: config.database as string,
        user: config.user as string,
        password: config.password as string,
        ssl: config.ssl as boolean | undefined,
        schema: (config.schema as string) ?? 'public',
      };
      return new PostgresConnector(pgConfig);
    }

    case 'mysql': {
      const myConfig: MysqlConnectionConfig = {
        host: (config.host as string) ?? 'localhost',
        port: Number(config.port) || 3306,
        database: config.database as string,
        user: config.user as string,
        password: config.password as string,
        ssl: config.ssl as boolean | undefined,
      };
      return new MysqlConnector(myConfig);
    }

    case 'sqlserver': {
      const msConfig: MssqlConnectionConfig = {
        host: (config.host as string) ?? 'localhost',
        port: Number(config.port) || 1433,
        database: config.database as string,
        user: config.user as string,
        password: config.password as string,
        windowsAuth: config.windowsAuth as boolean | undefined,
        encrypt: config.encrypt as boolean | undefined,
        trustServerCertificate: config.trustServerCertificate as boolean | undefined,
        schema: (config.schema as string) ?? 'dbo',
      };
      return new MssqlConnector(msConfig);
    }

    default:
      throw new Error(`Unsupported connection type: ${type}`);
  }
}

/** List of connector types the system supports. */
export const SUPPORTED_TYPES = ['sqlite', 'postgres', 'mysql', 'sqlserver'] as const;
export type ConnectorType = (typeof SUPPORTED_TYPES)[number];

/**
 * Creates the appropriate connector for a connection.
 *
 * - If the connection has been ingested (query_engine='duckdb' + warehouse_path set),
 *   returns a DuckDBConnector that reads from the Delta Lake warehouse.
 * - Otherwise, returns the original source connector.
 */
export function createConnector(conn: ConnectionRow): BaseConnector {
  const config = parseConfig(conn.config);

  // Use DuckDB if ingestion is complete
  if (conn.query_engine === 'duckdb' && conn.warehouse_path) {
    return new DuckDBConnector(conn.warehouse_path);
  }

  return buildSourceConnector(conn.type, config);
}

/**
 * Always returns the source connector (for ingestion/discovery operations
 * that must read from the original source, not the warehouse).
 */
export function createSourceConnector(conn: ConnectionRow): BaseConnector {
  const config = parseConfig(conn.config);
  return buildSourceConnector(conn.type, config);
}

/**
 * Creates a DuckDB connector pointing at the product layer warehouse.
 */
export function createProductConnector(productWarehousePath: string): BaseConnector {
  return new DuckDBConnector(productWarehousePath);
}

/**
 * Test a connection without saving it. Used by the /test endpoint.
 */
export async function testConnector(
  type: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const connector = buildSourceConnector(type, config);
  return connector.testConnection();
}
