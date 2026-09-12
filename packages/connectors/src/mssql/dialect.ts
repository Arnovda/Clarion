/**
 * Microsoft SQL Server dialect.
 *
 * Two things differ more than cosmetically from the other two dialects, and
 * both are stated rather than papered over:
 *
 *   1. **There is no read-only session setting.** Postgres has
 *      `default_transaction_read_only` and MySQL has `SET SESSION TRANSACTION
 *      READ ONLY`; SQL Server's equivalent (`ApplicationIntent=ReadOnly`) only
 *      does anything against an Availability Group replica. So here the
 *      structural guarantee carries the whole weight: this connector builds
 *      every statement from introspected identifiers and `SqlConnection`
 *      exposes no way to run anything else. The config help therefore asks
 *      for a `db_datareader` login, which is the real control.
 *
 *   2. **Paging must use OFFSET/FETCH, which requires an ORDER BY.** The
 *      shared builder emits `ORDER BY (SELECT NULL)` when a table has nothing
 *      stable to sort by, so a keyless table is still readable.
 */

import sql from 'mssql';
import type { Logger } from '../types';
import { buildKeyPageQuery, buildPageQuery, qualify, type SqlSyntax } from '../sql/pagination';
import { baseDuckDbType, normaliseTypeName } from '../sql/typeMap';
import type {
  KeyPageQueryArgs, PageQueryArgs, RawColumn, SqlConnection, SqlDialect, SqlQuery, SqlSourceConfig,
} from '../sql/types';

const SYNTAX: SqlSyntax = {
  quoteIdent: (name) => `[${name.replace(/]/g, ']]')}]`,
  placeholder: (i) => `@p${i}`,
  limitStyle: 'fetch',
};

const REQUEST_TIMEOUT_MS = 10 * 60_000;

export const mssqlDialect: SqlDialect = {
  id: 'mssql',
  displayName: 'SQL Server',
  defaultPort: 1433,
  defaultSchema: () => 'dbo',
  quoteIdent: SYNTAX.quoteIdent,

  async connect(config: SqlSourceConfig, log: Logger): Promise<SqlConnection> {
    const pool = new sql.ConnectionPool({
      server: config.host,
      port: config.port ?? 1433,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeout: 15_000,
      requestTimeout: REQUEST_TIMEOUT_MS,
      pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: config.ssl === true,
        // Azure SQL and most on-prem instances present a certificate the
        // container has no root for. Same trade as the other two dialects:
        // encrypt in transit, do not verify the chain. Verification needs a
        // per-provider CA bundle — tracked, not silently skipped.
        trustServerCertificate: true,
        appName: 'clarion-sync',
      },
    });
    await pool.connect();
    log.debug('sql server session ready', { database: config.database });

    return {
      async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
        const request = pool.request();
        // `@p1`-style named parameters, matching SYNTAX.placeholder.
        params.forEach((v, i) => { request.input(`p${i + 1}`, v); });
        const res = await request.query(text);
        return res.recordset as unknown as T[];
      },
      async close(): Promise<void> {
        await pool.close();
      },
    };
  },

  // ─── Catalog ───────────────────────────────────────────────────────────
  tablesQuery(schema: string, includeViews: boolean): SqlQuery {
    // Row estimate from sys.partitions (index_id 0 = heap, 1 = clustered) —
    // free, unlike COUNT(*) on a large table.
    const views = includeViews
      ? `
        UNION ALL
        SELECT v.name, 'view', CAST(ep.value AS nvarchar(max)), NULL
        FROM sys.views v
        JOIN sys.schemas s ON s.schema_id = v.schema_id
        LEFT JOIN sys.extended_properties ep
          ON ep.major_id = v.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
        WHERE s.name = @p1`
      : '';
    return {
      sql: `
        SELECT table_name, table_type, table_comment, estimated_rows FROM (
          SELECT t.name AS table_name, 'table' AS table_type,
                 CAST(ep.value AS nvarchar(max)) AS table_comment,
                 p.total_rows AS estimated_rows
          FROM sys.tables t
          JOIN sys.schemas s ON s.schema_id = t.schema_id
          LEFT JOIN sys.extended_properties ep
            ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
          LEFT JOIN (
            SELECT object_id, SUM(rows) AS total_rows
            FROM sys.partitions WHERE index_id IN (0, 1) GROUP BY object_id
          ) p ON p.object_id = t.object_id
          WHERE s.name = @p1${views}
        ) x
        ORDER BY table_name`,
      params: [schema],
    };
  },

  columnsQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT o.name AS table_name,
               c.name AS column_name,
               ty.name AS data_type,
               c.column_id AS ordinal_position,
               c.is_nullable AS is_nullable,
               c.precision AS numeric_precision,
               c.scale AS numeric_scale,
               CAST(ep.value AS nvarchar(max)) AS column_comment
        FROM sys.columns c
        JOIN sys.objects o ON o.object_id = c.object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN sys.extended_properties ep
          ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
        WHERE s.name = @p1 AND o.type IN ('U', 'V')
        ORDER BY o.name, c.column_id`,
      params: [schema],
    };
  },

  primaryKeysQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT t.name AS table_name,
               c.name AS column_name,
               ic.key_ordinal AS ordinal
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1 AND s.name = @p1
        ORDER BY t.name, ic.key_ordinal`,
      params: [schema],
    };
  },

  foreignKeysQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT pt.name AS from_table,
               pc.name AS from_column,
               rt.name AS to_table,
               rc.name AS to_column
        FROM sys.foreign_key_columns fkc
        JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
        JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
        JOIN sys.schemas s ON s.schema_id = pt.schema_id
        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE s.name = @p1
        ORDER BY pt.name, fkc.constraint_column_id`,
      params: [schema],
    };
  },

  countQuery(schema: string, table: string): SqlQuery {
    return { sql: `SELECT count_big(*) AS c FROM ${qualify(SYNTAX, schema, table)}`, params: [] };
  },

  // ─── Types ─────────────────────────────────────────────────────────────
  toDuckDbType(col: RawColumn): string {
    switch (normaliseTypeName(col.data_type)) {
      // `money` / `smallmoney` arrive as JS numbers here (unlike Postgres,
      // where the driver returns a localised string), so they can be exact
      // decimals. SQL Server fixes the scale at 4.
      case 'money': return 'DECIMAL(19,4)';
      case 'smallmoney': return 'DECIMAL(10,4)';
      // `sys.types` reports these with a precision that is not a numeric one;
      // the shared mapper would read it as a decimal width.
      case 'datetime': case 'datetime2': case 'smalldatetime': return 'TIMESTAMP';
      case 'datetimeoffset': return 'TIMESTAMPTZ';
      case 'date': return 'DATE';
      case 'float': return 'DOUBLE';
      case 'real': return 'REAL';
      case 'xml': case 'sql_variant': case 'hierarchyid': return 'VARCHAR';
      default: return baseDuckDbType(col);
    }
  },

  // ─── Paging ────────────────────────────────────────────────────────────
  pageQuery: (args: PageQueryArgs) => buildPageQuery(SYNTAX, args),
  keyPageQuery: (args: KeyPageQueryArgs) => buildKeyPageQuery(SYNTAX, args),
};
