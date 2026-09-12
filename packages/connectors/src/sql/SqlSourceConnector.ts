/**
 * The SQL source connector — one implementation, three dialects.
 *
 * Postgres, MySQL and SQL Server all subclass this with nothing but a
 * `SqlDialect` and a config schema. Everything a reviewer would need to check
 * for correctness — how rows are paged, how the cursor is filtered, what gets
 * merged versus overwritten, how a full re-sync tombstones, how reconcile
 * lists keys — exists here once, and is therefore identical for all three and
 * for whatever SQL source is added next.
 *
 * READ-ONLY BY CONSTRUCTION (playbook Phase B). This class builds every
 * statement it runs from identifiers it introspected out of the catalog and
 * then quoted; there is no path by which caller-supplied text becomes SQL, and
 * `SqlConnection` exposes nothing that could execute a statement this file did
 * not build. Dialects additionally ask the session for read-only mode where
 * the engine supports it. The structural guarantee is the one that matters:
 * the others are defence in depth.
 */

import { BaseSourceConnector } from '../BaseSourceConnector';
import {
  type ConnectorConfig,
  type EntityDescriptor,
  type EntityDocs,
  type ProbeContext,
  type SyncContext,
  type SyncOptions,
  type SyncResult,
  type TestResult,
  type ColumnDoc,
} from '../types';
import { resolveSyncEntities, runEntitySync, type EntitySyncSource, type EntityPullResult } from '../syncEngine';
import { buildCatalog, toEntityDescriptor, type BuiltCatalog } from './catalog';
import type {
  PagePlan, SqlConnection, SqlDialect, SqlEntity, SqlSourceConfig,
  RawColumn, RawForeignKey, RawPrimaryKey, RawTable,
} from './types';
import { normaliseValue } from './typeMap';

/** Rows per fetch. Tuned so one page is a few MB even on a wide table. */
const PAGE_SIZE = 5_000;
/** Rows per key page during a reconcile — keys are tiny, so fetch more. */
const KEY_PAGE_SIZE = 50_000;

export abstract class SqlSourceConnector extends BaseSourceConnector {
  protected abstract readonly dialect: SqlDialect;

  /**
   * No HTTP is involved: a database driver opens a TCP socket, it does not go
   * through `HttpClient`. An empty list is the honest declaration for that and
   * is what `validateConnectorMetadata` expects — it means "this connector
   * makes no HTTP calls", not "no policy". Reaching the customer's database
   * host is a network-policy question, not an egress-allow-list one.
   */
  readonly egressAllowList: readonly string[] = [];

  // ─── testConnection ────────────────────────────────────────────────────
  /**
   * Connect, read the catalog, and REPORT WHAT WE FOUND.
   *
   * The details matter more here than for an API connector. Everything about
   * this source is inferred from the customer's own schema — which tables are
   * visible, which have a usable key, which have a modified-timestamp we will
   * sync incrementally — and the wizard is the only place a person can catch a
   * wrong reading before data lands. So the test reports the reading, not just
   * "connected".
   */
  async testConnection(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<TestResult> {
    this.validateConfig(rawConfig);
    const config = rawConfig as unknown as SqlSourceConfig;
    let conn: SqlConnection | undefined;
    try {
      conn = await this.dialect.connect(config, ctx.log);
      const catalog = await this.readCatalog(conn, config);
      const incremental = catalog.entities.filter((e) => e.supportsIncremental).length;
      const keyed = catalog.entities.filter((e) => e.businessKey).length;
      return {
        ok: true,
        details: {
          schema: this.schemaOf(config),
          tables: String(catalog.entities.length),
          'with a primary key': `${keyed} of ${catalog.entities.length}`,
          'synced incrementally': `${incremental} of ${catalog.entities.length}`,
          relationships: String(catalog.relationships.length),
        },
      };
    } catch (err) {
      return { ok: false, error: userFacing(err) };
    } finally {
      await conn?.close().catch(() => {});
    }
  }

  // ─── listEntities ──────────────────────────────────────────────────────
  async listEntities(rawConfig: ConnectorConfig, ctx: ProbeContext): Promise<EntityDescriptor[]> {
    this.validateConfig(rawConfig);
    const config = rawConfig as unknown as SqlSourceConfig;
    const conn = await this.dialect.connect(config, ctx.log);
    try {
      const { entities, skipped } = await this.readCatalog(conn, config);
      for (const s of skipped) ctx.log.warn(`table '${s.table}' skipped`, { reason: s.reason });
      return entities.map(toEntityDescriptor);
    } finally {
      await conn.close().catch(() => {});
    }
  }

  // ─── sync ──────────────────────────────────────────────────────────────
  async sync(rawConfig: ConnectorConfig, opts: SyncOptions, ctx: SyncContext): Promise<SyncResult> {
    this.validateConfig(rawConfig);
    const config = rawConfig as unknown as SqlSourceConfig;

    if (opts.entities.length === 0) {
      return { rowCounts: {}, warnings: ['No entities selected — nothing to sync.'] };
    }

    const conn = await this.dialect.connect(config, ctx.log);
    try {
      // The catalog is re-read at the start of every sync, on purpose: the
      // customer owns this schema and may have added a column, a key or an
      // index since the last run. A stale catalog would sync yesterday's
      // shape and quietly drop a new column.
      const catalog = await this.readCatalog(conn, config);
      const byName = new Map(catalog.entities.map((e) => [e.name, e]));
      const { entities, warnings } = resolveSyncEntities(opts.entities, (n) => byName.get(n));
      if (entities.length === 0) return { rowCounts: {}, warnings };

      for (const s of catalog.skipped) {
        warnings.push(`Table '${s.table}' was skipped: ${s.reason}.`);
      }

      ctx.log.info('SQL sync starting', {
        dialect: this.dialect.id,
        schema: this.schemaOf(config),
        entities: entities.length,
      });

      return await runEntitySync<SqlEntity>({
        source: this.syncSource(conn),
        entities,
        opts,
        ctx,
        seedWarnings: warnings,
      });
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /**
   * The source-specific hooks the shared engine calls.
   *
   * `canCheckpoint` is true exactly when the table has a detected cursor,
   * because that is when the pull orders by `(cursor, key)` and rows therefore
   * arrive in cursor order. A table without one is paged by key or offset, so
   * "everything up to X is written" cannot be said part-way and the entity is
   * re-read next run instead.
   */
  private syncSource(conn: SqlConnection): EntitySyncSource<SqlEntity> {
    return {
      logFields: (entity) => ({
        table: `${entity.sourceSchema}.${entity.sourceTable}`,
        cursorColumn: entity.sourceCursorColumn,
        key: entity.sourceKeyColumn,
      }),
      canCheckpoint: (entity) => !!entity.incrementalCursor,
      pull: (args) => this.pullEntity(conn, args),
      listKeys: ({ entity, ctx }) => this.listEntityKeys(conn, entity, ctx),
    };
  }

  // ─── The pull ──────────────────────────────────────────────────────────
  private async pullEntity(
    conn: SqlConnection,
    args: { entity: SqlEntity; ctx: SyncContext; priorCursor?: { type: string; value: string }; fullResync: boolean },
  ): Promise<EntityPullResult> {
    const { entity, ctx, priorCursor, fullResync } = args;
    const warnings: string[] = [];

    // A binary column dropped from the sync is stated once per run, never
    // silently: the customer can see the column in their database and would
    // otherwise wonder where it went.
    if (entity.excludedColumns.length > 0) {
      warnings.push(
        `Table '${entity.sourceTable}': ${entity.excludedColumns.length} column(s) were not synced — ` +
        entity.excludedColumns.map((c) => `${c.name} (${c.reason})`).join('; ') + '.',
      );
    }
    if (!entity.businessKey && !entity.isView) {
      warnings.push(
        `Table '${entity.sourceTable}' has no single-column primary key, so every sync reads it in full ` +
        `and replaces the stored copy. Rows changing during the read can be seen twice or missed.`,
      );
    }

    const sourceCols = entity.columns.map((c) => c.sourceName);
    let maxCursorSeen: string | undefined;
    let pages = 0;
    let rows = 0;

    const dialect = this.dialect;
    const self = this;
    const rowStream = async function* (): AsyncIterable<Record<string, unknown>> {
      let after: { cursor: unknown; key: unknown } | undefined;
      let afterKey: unknown;
      let offset = 0;

      for (;;) {
        ctx.cancellationToken.throwIfCancelled();
        const plan = self.planPage(entity, { priorCursor, fullResync, after, afterKey, offset });
        const q = dialect.pageQuery({
          schema: entity.sourceSchema,
          table: entity.sourceTable,
          columns: sourceCols,
          limit: PAGE_SIZE,
          plan,
        });
        const batch = await conn.query(q.sql, q.params);
        if (batch.length === 0) break;

        for (const raw of batch) {
          const mapped = self.mapRow(entity, raw);
          if (entity.incrementalCursor) {
            const v = mapped[entity.incrementalCursor.field];
            if (typeof v === 'string' && (!maxCursorSeen || v > maxCursorSeen)) maxCursorSeen = v;
          }
          yield mapped;
        }

        const last = batch[batch.length - 1]!;
        if (plan.mode === 'keyset-cursor') {
          after = { cursor: last[plan.cursorColumn], key: last[plan.keyColumn] };
        } else if (plan.mode === 'keyset-key') {
          afterKey = last[plan.keyColumn];
        } else {
          offset += batch.length;
        }

        pages += 1;
        rows += batch.length;
        ctx.progress({
          message: `Syncing ${entity.displayName ?? entity.name} (page ${pages}, ${rows} rows)`,
          perEntity: { [entity.name]: { pagesFetched: pages, rowsFetched: rows } },
        });
        if (batch.length < PAGE_SIZE) break;
      }
    };

    // A keyed table MERGES (so a delta never drops the rows it does not
    // carry); a keyless one has nothing to merge on and is replaced. A full
    // re-sync of a keyed table still merges and then tombstones what it did
    // not see — `finalizeFullSync` — because that is the only way a row
    // deleted at the source disappears without dropping the table first.
    const mergeKey = entity.businessKey;
    const result = await BaseSourceConnector['writeEntityInChunks']<Record<string, unknown>>({
      entity: entity.name,
      rows: rowStream(),
      ctx,
      writeOpts: {
        ...(mergeKey ? { mergeKey } : {}),
        ...(fullResync && !mergeKey ? { replace: true } : {}),
        columns: entity.columns.map((c) => ({ name: c.name, sqlType: c.sqlType })),
      },
      ...(entity.incrementalCursor
        ? {
            checkpoint: {
              type: 'timestamp' as const,
              cursorOf: (row: Record<string, unknown>) => {
                const v = row[entity.incrementalCursor!.field];
                return typeof v === 'string' ? v : undefined;
              },
            },
          }
        : {}),
    });

    let rowsTotal = result.rowsTotal;
    if (fullResync && mergeKey && !result.stoppedForBudget && ctx.syncStartedAt && ctx.warehouseWriter.finalizeFullSync) {
      const fin = await ctx.warehouseWriter.finalizeFullSync(entity.name, { syncStartedAt: ctx.syncStartedAt });
      rowsTotal = fin.rowsTotal;
      if (fin.tombstoned > 0) {
        warnings.push(`Table '${entity.sourceTable}': ${fin.tombstoned} row(s) no longer at the source were hidden.`);
      }
      ctx.log.info(`${entity.name} full re-sync finalised`, { tombstoned: fin.tombstoned, rowsTotal: fin.rowsTotal });
    }

    ctx.log.info(`${entity.name} sync ${result.stoppedForBudget ? 'stopped at the time budget' : 'complete'}`, {
      pages, rows, bytes: result.bytesWritten, newCursor: maxCursorSeen,
    });

    return {
      rowsWritten: result.rowsWritten,
      bytesWritten: result.bytesWritten,
      rowsTotal,
      maxCursorSeen,
      preservedExisting: result.preservedExisting,
      stoppedForBudget: result.stoppedForBudget,
      warnings,
    };
  }

  /** Choose how to page THIS request. See `PagePlan` for why each mode exists. */
  private planPage(
    entity: SqlEntity,
    state: {
      priorCursor?: { type: string; value: string };
      fullResync: boolean;
      after?: { cursor: unknown; key: unknown };
      afterKey?: unknown;
      offset: number;
    },
  ): PagePlan {
    const cursorCol = entity.sourceCursorColumn;
    const keyCol = entity.sourceKeyColumn;

    if (cursorCol && keyCol) {
      // Ordered by (cursor, key) even with no lower bound, so the FIRST full
      // load is resumable too — the load most likely to meet the worker's
      // ceiling.
      const bound = state.fullResync ? undefined : state.priorCursor?.value;
      return {
        mode: 'keyset-cursor',
        cursorColumn: cursorCol,
        keyColumn: keyCol,
        ...(bound !== undefined ? { lowerBound: toBoundValue(bound) } : {}),
        ...(state.after ? { after: state.after } : {}),
      };
    }
    if (keyCol) {
      return { mode: 'keyset-key', keyColumn: keyCol, ...(state.afterKey !== undefined ? { after: state.afterKey } : {}) };
    }
    // No single-column key: order by the composite key when there is one so
    // offset paging at least sees a stable sequence.
    return { mode: 'offset', orderBy: entity.pkColumns, offset: state.offset };
  }

  /** Source row → warehouse row: safe names, serialisable values. */
  private mapRow(entity: SqlEntity, raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const col of entity.columns) {
      out[col.name] = normaliseValue(raw[col.sourceName], col.sqlType);
    }
    return out;
  }

  // ─── Reconcile ─────────────────────────────────────────────────────────
  /** `SELECT <key>` keyset-paged — cheap enough to schedule. */
  private async *listEntityKeys(
    conn: SqlConnection,
    entity: SqlEntity,
    ctx: SyncContext,
  ): AsyncIterable<string | number> {
    const keyCol = entity.sourceKeyColumn;
    if (!keyCol) return;
    let after: unknown;
    let pages = 0;
    for (;;) {
      ctx.cancellationToken.throwIfCancelled();
      const q = this.dialect.keyPageQuery({
        schema: entity.sourceSchema,
        table: entity.sourceTable,
        keyColumn: keyCol,
        limit: KEY_PAGE_SIZE,
        ...(after !== undefined ? { after } : {}),
      });
      const batch = await conn.query(q.sql, q.params);
      if (batch.length === 0) break;
      for (const row of batch) {
        const v = row[keyCol];
        if (typeof v === 'string' || typeof v === 'number') yield v;
        else if (typeof v === 'bigint') yield v.toString();
        else if (v instanceof Date) yield v.toISOString();
      }
      after = batch[batch.length - 1]![keyCol];
      pages += 1;
      ctx.progress({ message: `Reconciling ${entity.displayName ?? entity.name} (page ${pages})` });
      if (batch.length < KEY_PAGE_SIZE) break;
    }
  }

  // ─── describeEntities (the documentation channel) ──────────────────────
  /**
   * The source's OWN metadata, at the `declared` rung.
   *
   * A relational database is the best-documented source Clarion has: primary
   * keys, foreign keys and column types are not somebody's description of the
   * data, they are constraints the engine enforces. Descriptions are the one
   * part that is usually absent — most schemas carry no `COMMENT ON COLUMN` —
   * and that is exactly the gap the AI pass is for. We return a comment when
   * there is one and stay silent when there is not, rather than inventing
   * documentation at the trusted rung where nothing downstream questions it.
   */
  async describeEntities(
    rawConfig: ConnectorConfig,
    selectedEntities: readonly string[],
    ctx: ProbeContext,
  ): Promise<EntityDocs[]> {
    this.validateConfig(rawConfig);
    const config = rawConfig as unknown as SqlSourceConfig;
    const conn = await this.dialect.connect(config, ctx.log);
    try {
      const catalog = await this.readCatalog(conn, config);
      const selected = new Set(selectedEntities);
      const inScope = (n: string): boolean => selected.size === 0 || selected.has(n);

      const relsByTable = new Map<string, typeof catalog.relationships>();
      for (const r of catalog.relationships) {
        if (!inScope(r.fromTable) || !inScope(r.toTable)) continue;
        const list = relsByTable.get(r.fromTable);
        if (list) list.push(r);
        else relsByTable.set(r.fromTable, [r]);
      }

      return catalog.entities.filter((e) => inScope(e.name)).map((e): EntityDocs => ({
        entityName: e.name,
        displayName: e.sourceTable,
        ...(e.description ? { description: e.description } : {}),
        columns: e.columns.map((c): ColumnDoc => ({
          name: c.name,
          // The database's own type, verbatim. Stored as `source_data_type`,
          // which is what lets the platform refuse a UUID→code relationship
          // later; both land as VARCHAR in the warehouse and look alike there.
          dataType: c.sourceType,
          ...(c.comment ? { description: c.comment } : {}),
          ...(c.sourceName !== c.name ? { displayName: c.sourceName } : {}),
        })),
        ...(relsByTable.has(e.name) ? { relationships: relsByTable.get(e.name) } : {}),
        // The PRIMARY KEY, declared. A dynamically-introspected source cannot
        // answer the synchronous `getBusinessKeys()` accessor (it has neither
        // config nor a connection), so the key travels on this channel — which
        // already exists for exactly this purpose and is already async.
        ...(e.businessKey ? { businessKey: e.businessKey } : {}),
        provenance: 'declared',
      }));
    } finally {
      await conn.close().catch(() => {});
    }
  }

  /**
   * No star-schema template. A customer's own database has no universal
   * fact/dimension design — unlike Exact Online or Odoo, where every tenant
   * sees the same vendor schema — so the AI designer is the right path here,
   * and returning null is what selects it.
   */
  getStarSchemaTemplate(): null {
    return null;
  }

  // ─── Catalog reading ───────────────────────────────────────────────────
  protected schemaOf(config: SqlSourceConfig): string {
    return config.schema?.trim() || this.dialect.defaultSchema(config);
  }

  protected async readCatalog(conn: SqlConnection, config: SqlSourceConfig): Promise<BuiltCatalog> {
    const schema = this.schemaOf(config);
    const d = this.dialect;
    const t = d.tablesQuery(schema, config.includeViews === true);
    const c = d.columnsQuery(schema);
    const p = d.primaryKeysQuery(schema);
    const f = d.foreignKeysQuery(schema);
    const [tables, columns, primaryKeys, foreignKeys] = await Promise.all([
      conn.query<RawTable>(t.sql, t.params),
      conn.query<RawColumn>(c.sql, c.params),
      conn.query<RawPrimaryKey>(p.sql, p.params),
      conn.query<RawForeignKey>(f.sql, f.params),
    ]);
    return buildCatalog({
      schema,
      tables,
      columns,
      primaryKeys,
      foreignKeys,
      dialect: d,
      ...(config.incrementalDetection ? { incrementalDetection: config.incrementalDetection } : {}),
    });
  }
}

/**
 * Bind a stored cursor as a value the driver will compare correctly.
 *
 * Cursors are persisted as text (`entity_sync_cursors.cursor_value`), but a
 * DATETIME comparison against the ISO-8601 string we stored is not portable —
 * MySQL in particular will not reliably parse the `T` separator and `Z`
 * suffix, and a filter that matches nothing looks exactly like a table with no
 * changes. Handing the driver a `Date` lets it serialise for its own dialect.
 */
function toBoundValue(stored: string): unknown {
  const d = new Date(stored);
  return Number.isNaN(d.getTime()) ? stored : d;
}

/** Never leak a connection string, a host or a stack trace to the UI. */
function userFacing(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 300);
}
