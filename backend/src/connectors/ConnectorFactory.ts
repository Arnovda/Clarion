import { BaseConnector } from './BaseConnector';
import { SqliteConnector } from './SqliteConnector';
import { DuckDBConnector } from './DuckDBConnector';
import { PostgresConnector, PostgresConnectionConfig } from './PostgresConnector';
import { MysqlConnector, MysqlConnectionConfig } from './MysqlConnector';
import { MssqlConnector, MssqlConnectionConfig } from './MssqlConnector';
import { decryptCredentials, isEncrypted } from '../utils/crypto';
import { assertSafeDbHost } from '../utils/netGuard';
import { semanticDb } from '../db/knex';
import { rollupViewName } from '../services/warehouse';
import type { QueryScope } from '../services/queryScope';
import { planRegistration } from '../services/warehouseRegistration';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'ConnectorFactory' });

interface ConnectionRow {
  id: number;
  type: string;
  config: string | Record<string, unknown>;
  query_engine?: string;       // 'source' | 'duckdb'
  warehouse_path?: string | null;
  ingestion_status?: string | null;
  /** Source-connector connections store table names here, not in `ingested_tables`. */
  selected_entities?: string[] | null;
  connector_type?: string | null;
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
      assertSafeDbHost(config.host as string | undefined);
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
      assertSafeDbHost(config.host as string | undefined);
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
      assertSafeDbHost(config.host as string | undefined);
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
 * Fetch ingested table names for a connection from the DB.
 * Used by DuckDBConnector in Azure mode (can't scan blob directories).
 */
async function getIngestedTableNames(connectionId: number): Promise<string[]> {
  const rows = await semanticDb('ingested_tables')
    .where({ connection_id: connectionId, status: 'done' })
    .select('table_name');
  return rows.map((r: { table_name: string }) => r.table_name);
}

/**
 * Creates the appropriate connector for a connection.
 *
 * - If the connection has been ingested (query_engine='duckdb' + warehouse_path set),
 *   returns a DuckDBConnector that reads from the Delta Lake warehouse.
 * - Otherwise, returns the original source connector.
 */
export async function createConnector(conn: ConnectionRow): Promise<BaseConnector> {
  const config = parseConfig(conn.config);

  // Use DuckDB if ingestion is complete
  if (conn.query_engine === 'duckdb' && conn.warehouse_path) {
    // Two sources of table names, in priority order:
    //   1. `ingested_tables` table — populated by the legacy ETL flow.
    //   2. `selected_entities` on the connection row — populated by the
    //      source-connector wizard (Day 5+ flow). These connections never
    //      touch `ingested_tables`.
    let tableNames = await getIngestedTableNames(conn.id);
    if (tableNames.length === 0 && Array.isArray(conn.selected_entities) && conn.selected_entities.length > 0) {
      tableNames = conn.selected_entities;
    }
    return new DuckDBConnector(conn.warehouse_path, tableNames);
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
 *
 * Gathers ALL successfully materialized product tables across ALL data products
 * for this connection. This is critical because shared/conformed dimensions
 * (e.g. dim_customer) may live in a different product's warehouse directory
 * (e.g. Catalogue) than the fact tables being queried (e.g. Operations).
 *
 * Path + metadata resolution goes through `tableCatalog` so this surface
 * uses the same source-of-truth as /catalog, /quality, and the runner.
 */
export async function createProductConnector(
  productWarehousePath: string,
  scope: QueryScope,
): Promise<BaseConnector> {
  const { listProductTablesForScope, listManagedGridTables } = await import('../services/tableCatalog');
  const productTables = await listProductTablesForScope(scope);

  // Naming — including the rule that stops two sources' `dim_customer` from
  // silently resolving to whichever registered first — lives in
  // `warehouseRegistration` so it is pure and directly unit-testable. In a
  // single-source scope it returns exactly what the inline loop here used to:
  // bare names, schema = data product name.
  const crossSource = scope.connectionIds.length > 1;
  const plan = planRegistration(
    productTables.map((t) => ({
      tableName: t.tableName,
      uri: t.uri,
      productName: t.productName,
      connectionId: t.connectionId ?? 0,
      connectionName: t.connectionName,
      rollupUri: t.rollupUri,
    })),
    { crossSource, rollupName: rollupViewName },
  );

  const { tableNames, tablePaths, tableSchemas } = plan;

  // Managed grids — the in-Clarion editable tables (budgets, mappings, lists).
  // Tenant-level, deliberately registered in EVERY product-layer session:
  // their whole value is joining against whichever connection holds the
  // actuals. Registration and advertisement (`productContext`'s "your tables"
  // section) are a fix-both-or-neither pair. No schema entry on purpose —
  // grids live in the default namespace so `grid_budget_2026` resolves
  // unqualified, and that is the same in a cross-source session.
  const grids = await listManagedGridTables(scope.tenantId);
  for (const g of grids) {
    if (tablePaths.has(g.viewName)) continue; // never shadow a product table
    tablePaths.set(g.viewName, g.uri);
    tableNames.push(g.viewName);
  }

  const productCount = new Set(productTables.map((t) => t.productName)).size;
  log.info(
    `createProductConnector: ${crossSource ? `${scope.connectionIds.length} connections` : `connection ${scope.connectionIds[0]}`}: `
    + `${tableNames.length} tables from ${productCount} product(s)`
    + (plan.ambiguous.length > 0
      ? `; ${plan.ambiguous.length} name(s) ambiguous across sources, bare name withheld: `
        + plan.ambiguous.map((a) => a.bareName).join(', ')
      : ''),
  );

  return new DuckDBConnector(productWarehousePath, tableNames, tablePaths, tableSchemas);
}

/**
 * Test a connection without saving it. Used by the /test endpoint.
 */
export async function testConnector(
  type: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  // Construction can throw for bad user config (disallowed SQLite path,
  // metadata-endpoint host). That's a failed connection test, not a server
  // error — surface it as { ok: false } so the UI shows it inline.
  let connector: BaseConnector;
  try {
    connector = buildSourceConnector(type, config);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid connection configuration' };
  }
  return connector.testConnection();
}
