/**
 * The SQL source kit — shared contract.
 *
 * Postgres, MySQL and SQL Server are three dialects of one source SHAPE: a
 * relational database the customer owns, which describes itself through
 * standard catalog views. Everything that matters to Clarion — how the catalog
 * is built, how rows are paged, how a cursor is chosen, how types are mapped,
 * how the sync runs — is identical across all three. Only the driver, the
 * quoting characters, the parameter placeholders and the exact catalog SQL
 * differ.
 *
 * So the kit owns the behaviour and a `SqlDialect` supplies the differences.
 * Adding a fourth SQL source (SQLite, Snowflake, Redshift, …) is a dialect
 * file, not a connector: no sync loop to re-implement, no pagination to get
 * subtly wrong, no chance of one database quietly behaving differently from
 * its siblings.
 *
 * METADATA TIER (docs/SOURCE_ONBOARDING.md §0) — mixed, and unusually good:
 *   • relationships  Tier 1. Declared FOREIGN KEY constraints are not an
 *                    inference; they are the database's own enforced
 *                    guarantee. No heuristic name-matching, no AI, no
 *                    value-overlap verification needed.
 *   • types          Tier 1. `information_schema.columns` is exact.
 *   • business keys  Tier 1. PRIMARY KEY constraints are declared.
 *   • descriptions   Tier 1 WHERE COMMENTS EXIST, Tier 3 otherwise. Most
 *                    customer databases carry no column comments, so this is
 *                    the one kind that usually falls through to the AI pass —
 *                    exactly as the playbook's fallback ladder prescribes.
 *   • entity catalog Tier 3-shaped: the schema is bespoke per customer, so the
 *                    catalog is INTROSPECTED, never curated. This is the
 *                    documented deviation from Phase A's "curate 15-25
 *                    entities" rule, which is written for vendor APIs where
 *                    every customer sees the same surface. See the connector
 *                    READMEs.
 */

import type { EntityCursorSpec, Logger } from '../types';
import type { SyncEntity } from '../syncEngine';

// ─── Connection ───────────────────────────────────────────────────────────
/**
 * A live connection to the customer's database.
 *
 * Deliberately tiny: the kit only ever runs parameterised SELECTs that it
 * built itself from introspected identifiers. There is no method here that
 * could execute caller-supplied text, which is what makes "read-only" a
 * property of the SHAPE rather than a promise someone has to keep.
 */
export interface SqlConnection {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Same, but yields rows as they arrive so a big table never lands in memory. */
  close(): Promise<void>;
}

/** Config fields every SQL dialect shares. Dialects may add their own. */
export interface SqlSourceConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  /** Schema (Postgres/SQL Server) or database (MySQL) to read. Dialect default when absent. */
  schema?: string;
  ssl?: boolean;
  /** Include views alongside base tables. Off by default — a view can be expensive to scan. */
  includeViews?: boolean;
  /**
   * Whether to auto-detect an incremental cursor column (`updated_at` and
   * friends). 'off' makes every table a full sync — the honest setting for a
   * schema whose modified-timestamps are not maintained by the application.
   */
  incrementalDetection?: 'auto' | 'off';
}

// ─── Normalised introspection rows ────────────────────────────────────────
// Each dialect's catalog SQL returns these exact shapes, so everything
// downstream is dialect-free.

export interface RawTable {
  table_name: string;
  /** 'table' | 'view' — normalised by the dialect. */
  table_type: 'table' | 'view';
  table_comment?: string | null;
  estimated_rows?: number | null;
}

export interface RawColumn {
  table_name: string;
  column_name: string;
  /** The database's own type name, verbatim (`int4`, `varchar`, `datetime2`). */
  data_type: string;
  ordinal_position: number;
  is_nullable: boolean;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  column_comment?: string | null;
  /**
   * The fuller type spelling where a dialect has one (MySQL's `COLUMN_TYPE`:
   * `tinyint(1)`, `int unsigned`). Only that dialect reads it; `data_type`
   * stays the clean name so `source_data_type` is comparable across sources.
   */
  column_type?: string | null;
}

export interface RawPrimaryKey {
  table_name: string;
  column_name: string;
  ordinal: number;
}

export interface RawForeignKey {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
}

/** A query the kit will run: fully-formed SQL plus its bound parameters. */
export interface SqlQuery {
  sql: string;
  params: readonly unknown[];
}

// ─── Dialect ──────────────────────────────────────────────────────────────
export interface SqlDialect {
  /** Registry key and `connections.connector_type` value. Lower-snake-case. */
  readonly id: string;
  readonly displayName: string;
  readonly defaultPort: number;
  /** Schema used when the config does not name one ('public', 'dbo', the database itself). */
  defaultSchema(config: SqlSourceConfig): string;

  /** Quote an identifier for this dialect (`"x"`, `` `x` ``, `[x]`). */
  quoteIdent(name: string): string;

  /** Open a connection. Must apply the dialect's read-only session settings. */
  connect(config: SqlSourceConfig, log: Logger): Promise<SqlConnection>;

  // Catalog queries. Each returns rows in the normalised shapes above.
  tablesQuery(schema: string, includeViews: boolean): SqlQuery;
  columnsQuery(schema: string): SqlQuery;
  primaryKeysQuery(schema: string): SqlQuery;
  foreignKeysQuery(schema: string): SqlQuery;

  /**
   * Map a source column to one of the DuckDB types the warehouse writer
   * accepts. Returning an unlisted type would make the writer DROP the column
   * silently, so a dialect must always land on the allow-list — `VARCHAR` is
   * the correct answer for anything it does not recognise.
   */
  toDuckDbType(col: RawColumn): string;

  /**
   * A page of rows. `keyset` pages by a strictly-increasing column (resumable,
   * stable under concurrent writes); `offset` is the fallback for tables with
   * no single-column key.
   */
  pageQuery(args: PageQueryArgs): SqlQuery;

  /** `SELECT <key> FROM <table>` for reconcile, paged the same way. */
  keyPageQuery(args: KeyPageQueryArgs): SqlQuery;

  /** Cheap existence/row-count probe for the wizard. */
  countQuery(schema: string, table: string): SqlQuery;
}

/**
 * How one page of a table is fetched. A discriminated plan rather than a bag
 * of optional fields, because the three modes have genuinely different
 * correctness properties and the type should not let them be mixed.
 */
export type PagePlan =
  /**
   * Ordered by `(cursor, key)` — the good case. Rows arrive in cursor order,
   * so a partial pull has a valid resume point and the engine may checkpoint.
   * Used whenever the table has a detected modified-timestamp column, INCLUDING
   * the first full load: that is the load most likely to hit the worker's
   * 30-minute ceiling, and the one that benefits most from resuming rather
   * than starting over.
   */
  | {
      mode: 'keyset-cursor';
      cursorColumn: string;
      keyColumn: string;
      /**
       * Incremental lower bound, applied as `>=` (see the boundary rule).
       * Bound as a driver-native value (a `Date` for timestamp columns) rather
       * than a string: MySQL will not reliably parse an ISO-8601 string with a
       * `T` separator and a `Z` suffix against a DATETIME column, and a
       * comparison that silently matches nothing is the worst possible
       * outcome for an incremental filter.
       */
      lowerBound?: unknown;
      /**
       * Last (cursor, key) pair written, for the next page. These are the RAW
       * values the driver returned, not the normalised ones we wrote — a
       * driver round-trips its own values exactly.
       */
      after?: { cursor: unknown; key: unknown };
    }
  /** Ordered by the single-column primary key. Stable, but not cursor-ordered. */
  | { mode: 'keyset-key'; keyColumn: string; after?: unknown }
  /**
   * Offset paging — the fallback for a table with no single-column key (a
   * composite key, or a view). Ordered by whatever stable columns exist so
   * pages do not shift; with nothing to order by, a row changing mid-sync can
   * be seen twice or missed, which is why the connector warns about it.
   */
  | { mode: 'offset'; orderBy: readonly string[]; offset: number };

export interface PageQueryArgs {
  schema: string;
  table: string;
  /** Source column names to SELECT, in order. */
  columns: readonly string[];
  limit: number;
  plan: PagePlan;
}

export interface KeyPageQueryArgs {
  schema: string;
  table: string;
  keyColumn: string;
  limit: number;
  after?: unknown;
}

// ─── Catalog ──────────────────────────────────────────────────────────────
/** One column of a synced table, with both names kept. */
export interface SqlColumnInfo {
  /** Warehouse-safe name — what lands in the Parquet header. */
  name: string;
  /** The column's real name in the customer's database. */
  sourceName: string;
  /** DuckDB type for the warehouse write. */
  sqlType: string;
  /** The database's own type name, verbatim. Stored as `source_data_type`. */
  sourceType: string;
  nullable: boolean;
  /** `COMMENT ON COLUMN` / `COLUMN_COMMENT` / MS_Description, when present. */
  comment?: string;
}

/**
 * One introspected table, ready to sync. Extends the engine's `SyncEntity`, so
 * the shared loop drives it exactly as it drives an Exact Online entity.
 */
export interface SqlEntity extends SyncEntity {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  supportsIncremental: boolean;
  readonly incrementalCursor?: EntityCursorSpec;
  businessKey?: string;

  /** Real identifiers in the customer's database. */
  sourceSchema: string;
  sourceTable: string;
  columns: SqlColumnInfo[];
  /** Source name of the single-column primary key, when there is one. */
  sourceKeyColumn?: string;
  /** Source names of every primary-key column (composite keys included). */
  pkColumns: string[];
  /** Source name of the detected modified-timestamp column. */
  sourceCursorColumn?: string;
  /** Columns left out of the sync (binary blobs, geometry) and why. */
  excludedColumns: { name: string; reason: string }[];
  estimatedRowCount?: number;
  isView: boolean;
}
