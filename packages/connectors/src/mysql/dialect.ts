/**
 * MySQL / MariaDB dialect.
 *
 * Three MySQL-specific traps are handled here rather than left to surface as
 * corrupt data, and each is a genuine difference from the other dialects:
 *
 *   1. **`tinyint(1)` is how MySQL spells a boolean.** The type name alone
 *      (`tinyint`) cannot tell it apart from a small integer, so the dialect
 *      reads `COLUMN_TYPE`, which carries the display width.
 *   2. **`BIT` arrives as a Buffer.** Left alone it would be dropped as binary
 *      — so a `bit(1)` flag column, which is a perfectly ordinary boolean,
 *      would silently vanish. A `typeCast` converts it at the driver.
 *   3. **BIGINT loses precision as a JS number.** `supportBigNumbers` +
 *      `bigNumberStrings` keep large ids exact as strings, which DuckDB then
 *      casts to BIGINT without passing through a float.
 */

import mysql from 'mysql2/promise';
import type { Logger } from '../types';
import { buildKeyPageQuery, buildPageQuery, qualify, type SqlSyntax } from '../sql/pagination';
import { baseDuckDbType, normaliseTypeName } from '../sql/typeMap';
import type {
  KeyPageQueryArgs, PageQueryArgs, RawColumn, SqlConnection, SqlDialect, SqlQuery, SqlSourceConfig,
} from '../sql/types';

const SYNTAX: SqlSyntax = {
  quoteIdent: (name) => `\`${name.replace(/`/g, '``')}\``,
  placeholder: () => '?',
  limitStyle: 'limit',
};

const STATEMENT_TIMEOUT_MS = 10 * 60_000;

export const mysqlDialect: SqlDialect = {
  id: 'mysql',
  displayName: 'MySQL',
  defaultPort: 3306,
  // MySQL has no schema layer above the database: the database IS the schema.
  defaultSchema: (config) => config.database,
  quoteIdent: SYNTAX.quoteIdent,

  async connect(config: SqlSourceConfig, log: Logger): Promise<SqlConnection> {
    const conn = await mysql.createConnection({
      host: config.host,
      port: config.port ?? 3306,
      database: config.database,
      user: config.user,
      password: config.password,
      connectTimeout: 15_000,
      // Keep large integers exact — see the header.
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: false,
      ...(config.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      typeCast(field, next) {
        // BIT(1) is MySQL's other boolean. Without this it arrives as a
        // Buffer and is discarded as binary data.
        if (field.type === 'BIT') {
          const buf = field.buffer();
          if (!buf || buf.length === 0) return null;
          if (buf.length === 1) return buf[0] === 1;
          return Array.from(buf).map((b) => b.toString(2).padStart(8, '0')).join('');
        }
        return next();
      },
    });

    // Read-only + a statement ceiling, both best-effort: MariaDB spells the
    // timeout differently and very old servers have neither. A server that
    // refuses them is not a reason to refuse the sync — the real read-only
    // guarantee is that this connector cannot build a write statement.
    for (const stmt of [
      'SET SESSION TRANSACTION READ ONLY',
      `SET SESSION MAX_EXECUTION_TIME=${STATEMENT_TIMEOUT_MS}`,
    ]) {
      try {
        await conn.query(stmt);
      } catch (err) {
        log.debug('mysql session setting not applied', { stmt, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        const [rows] = await conn.query(sql, params as unknown[]);
        return rows as T[];
      },
      async close(): Promise<void> {
        await conn.end();
      },
    };
  },

  // ─── Catalog ───────────────────────────────────────────────────────────
  tablesQuery(schema: string, includeViews: boolean): SqlQuery {
    const types = includeViews ? `('BASE TABLE','VIEW')` : `('BASE TABLE')`;
    return {
      sql: `
        SELECT TABLE_NAME AS table_name,
               CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS table_type,
               NULLIF(TABLE_COMMENT, '') AS table_comment,
               TABLE_ROWS AS estimated_rows
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ${types}
        ORDER BY TABLE_NAME`,
      params: [schema],
    };
  },

  columnsQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT TABLE_NAME AS table_name,
               COLUMN_NAME AS column_name,
               DATA_TYPE AS data_type,
               COLUMN_TYPE AS column_type,
               ORDINAL_POSITION AS ordinal_position,
               (IS_NULLABLE = 'YES') AS is_nullable,
               NUMERIC_PRECISION AS numeric_precision,
               NUMERIC_SCALE AS numeric_scale,
               NULLIF(COLUMN_COMMENT, '') AS column_comment
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      params: [schema],
    };
  },

  primaryKeysQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT TABLE_NAME AS table_name,
               COLUMN_NAME AS column_name,
               ORDINAL_POSITION AS ordinal
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      params: [schema],
    };
  },

  foreignKeysQuery(schema: string): SqlQuery {
    // Same-schema references only: the catalog drops endpoints it does not
    // hold anyway, and a cross-database FK cannot be synced as one source.
    return {
      sql: `
        SELECT TABLE_NAME AS from_table,
               COLUMN_NAME AS from_column,
               REFERENCED_TABLE_NAME AS to_table,
               REFERENCED_COLUMN_NAME AS to_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
          AND REFERENCED_TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      params: [schema, schema],
    };
  },

  countQuery(schema: string, table: string): SqlQuery {
    return { sql: `SELECT count(*) AS c FROM ${qualify(SYNTAX, schema, table)}`, params: [] };
  },

  // ─── Types ─────────────────────────────────────────────────────────────
  toDuckDbType(col: RawColumn): string {
    const full = (col.column_type ?? col.data_type ?? '').toLowerCase();
    const base = normaliseTypeName(col.data_type);

    // `tinyint(1)` is MySQL's boolean. Anything wider is a real small integer.
    if (base === 'tinyint' && /^tinyint\(1\)/.test(full)) return 'BOOLEAN';
    if (base === 'bit') return /^bit\(1\)/.test(full) ? 'BOOLEAN' : 'VARCHAR';

    // UNSIGNED doubles the positive range, so the signed type one size down
    // would overflow. Widening keeps every value representable.
    //
    // `bigint unsigned` is the one that cannot widen — DuckDB has nothing
    // above BIGINT. It stays BIGINT deliberately: a value above 2^63 then
    // FAILS the cast loudly instead of being silently rounded, which is what
    // mapping it to DOUBLE would do. A wrong number is worse than a stopped
    // sync, and ids that large do not occur in practice.
    if (/\bunsigned\b/.test(full)) {
      switch (base) {
        case 'tinyint': return 'SMALLINT';
        case 'smallint': return 'INTEGER';
        case 'mediumint': return 'INTEGER';
        case 'int': case 'integer': return 'BIGINT';
        default: break;
      }
    }
    return baseDuckDbType(col);
  },

  // ─── Paging ────────────────────────────────────────────────────────────
  pageQuery: (args: PageQueryArgs) => buildPageQuery(SYNTAX, args),
  keyPageQuery: (args: KeyPageQueryArgs) => buildKeyPageQuery(SYNTAX, args),
};
