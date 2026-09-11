/**
 * PostgreSQL dialect.
 *
 * Everything about how a sync BEHAVES lives in `../sql`; this file is the
 * three things that are genuinely Postgres: how to connect, how to quote, and
 * what its catalog views are called.
 *
 * The catalog queries read `pg_catalog` rather than `information_schema` where
 * Postgres exposes more there — `obj_description` / `col_description` for
 * comments (the documentation channel), `reltuples` for a row estimate that
 * costs nothing, and `pg_constraint.conkey` for key columns in their declared
 * ORDER, which `information_schema` makes needlessly hard to reconstruct.
 */

import { Client } from 'pg';
import type { Logger } from '../types';
import { buildKeyPageQuery, buildPageQuery, qualify, type SqlSyntax } from '../sql/pagination';
import { baseDuckDbType, normaliseTypeName } from '../sql/typeMap';
import type {
  KeyPageQueryArgs, PageQueryArgs, RawColumn, SqlConnection, SqlDialect, SqlQuery, SqlSourceConfig,
} from '../sql/types';

const SYNTAX: SqlSyntax = {
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  placeholder: (i) => `$${i}`,
  limitStyle: 'limit',
};

/** How long a single statement may run before Postgres cancels it. */
const STATEMENT_TIMEOUT_MS = 10 * 60_000;

export const postgresDialect: SqlDialect = {
  id: 'postgres',
  displayName: 'PostgreSQL',
  defaultPort: 5432,
  defaultSchema: () => 'public',
  quoteIdent: SYNTAX.quoteIdent,

  async connect(config: SqlSourceConfig, log: Logger): Promise<SqlConnection> {
    const client = new Client({
      host: config.host,
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: 15_000,
      application_name: 'clarion-sync',
      // Managed Postgres (Azure, RDS, Neon) presents a chain the container
      // does not carry a root for. Matching the behaviour the platform has
      // shipped since the legacy connector: encrypt in transit, do not verify
      // the chain. Verification needs a CA bundle per provider — tracked, not
      // silently skipped.
      ...(config.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    await client.connect();

    // Read-only session. Belt and braces: this connector cannot construct a
    // write statement in the first place, but a role that was granted more
    // than it needed should still be unable to be used for one through us.
    // `statement_timeout` stops a pathological scan from holding the worker
    // past its own ceiling.
    await client.query(`SET default_transaction_read_only = on`);
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET idle_in_transaction_session_timeout = 60000`);
    log.debug('postgres session ready', { database: config.database });

    return {
      async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        const res = await client.query(sql, params as unknown[]);
        return res.rows as T[];
      },
      async close(): Promise<void> {
        await client.end();
      },
    };
  },

  // ─── Catalog ───────────────────────────────────────────────────────────
  tablesQuery(schema: string, includeViews: boolean): SqlQuery {
    // 'r' ordinary table, 'p' partitioned table, 'v' view, 'm' materialised view.
    // Partitioned parents are included and their children excluded
    // (`relispartition = false`), so a partitioned table syncs once as a
    // whole rather than once per partition.
    const kinds = includeViews ? `'r','p','v','m'` : `'r','p'`;
    return {
      sql: `
        SELECT c.relname::text AS table_name,
               CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS table_type,
               obj_description(c.oid, 'pg_class') AS table_comment,
               CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN (${kinds})
          AND c.relispartition = false
        ORDER BY c.relname`,
      params: [schema],
    };
  },

  columnsQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT c.relname::text AS table_name,
               a.attname::text AS column_name,
               CASE
                 WHEN t.typtype = 'e' THEN 'enum'
                 WHEN t.typcategory = 'A' THEN 'array'
                 ELSE format_type(a.atttypid, NULL)
               END AS data_type,
               a.attnum AS ordinal_position,
               NOT a.attnotnull AS is_nullable,
               information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS numeric_precision,
               information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) AS numeric_scale,
               col_description(c.oid, a.attnum) AS column_comment
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname = $1
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND c.relkind IN ('r','p','v','m')
        ORDER BY c.relname, a.attnum`,
      params: [schema],
    };
  },

  primaryKeysQuery(schema: string): SqlQuery {
    return {
      sql: `
        SELECT c.relname::text AS table_name,
               a.attname::text AS column_name,
               k.ord::int AS ordinal
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE con.contype = 'p' AND n.nspname = $1
        ORDER BY c.relname, k.ord`,
      params: [schema],
    };
  },

  foreignKeysQuery(schema: string): SqlQuery {
    // `k.ord = fk.ord` pairs the two column lists position by position, so a
    // composite foreign key produces its real column pairs rather than the
    // cross product of both sides.
    return {
      sql: `
        SELECT c.relname::text  AS from_table,
               a.attname::text  AS from_column,
               rc.relname::text AS to_table,
               ra.attname::text AS to_column
        FROM pg_constraint con
        JOIN pg_class c  ON c.oid = con.conrelid
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace n  ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)
        CROSS JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord)
        JOIN pg_attribute a  ON a.attrelid = c.oid  AND a.attnum = k.attnum
        JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = fk.attnum
        WHERE con.contype = 'f' AND n.nspname = $1 AND k.ord = fk.ord
        ORDER BY c.relname, k.ord`,
      params: [schema],
    };
  },

  countQuery(schema: string, table: string): SqlQuery {
    return { sql: `SELECT count(*)::bigint AS c FROM ${qualify(SYNTAX, schema, table)}`, params: [] };
  },

  // ─── Types ─────────────────────────────────────────────────────────────
  toDuckDbType(col: RawColumn): string {
    switch (normaliseTypeName(col.data_type)) {
      // Postgres `money` comes back from the driver LOCALISED — '$1,234.56' —
      // so casting it to a number fails and would take the whole table's read
      // with it. Kept as text; the amount is still readable and a cast in a
      // transformation can handle the format deliberately.
      case 'money':
        return 'VARCHAR';
      // A Postgres `bit` is a BIT STRING ('1011'), not a boolean. The shared
      // mapper reads `bit` as boolean because that is what MySQL and SQL
      // Server mean by it — one of the few places the dialects genuinely
      // disagree about a type name.
      case 'bit': case 'bit varying': case 'varbit':
        return 'VARCHAR';
      default:
        return baseDuckDbType(col);
    }
  },

  // ─── Paging ────────────────────────────────────────────────────────────
  pageQuery: (args: PageQueryArgs) => buildPageQuery(SYNTAX, args),
  keyPageQuery: (args: KeyPageQueryArgs) => buildKeyPageQuery(SYNTAX, args),
};
