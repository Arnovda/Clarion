/**
 * SQL connector — end-to-end sync, against a fake dialect but the REAL
 * everything else: the shared sync engine, the chunked writer, real Parquet on
 * disk, read back with DuckDB.
 *
 * The fake replaces only the database driver. Query STRING building is covered
 * exhaustively in `pagination.test.ts`, so here the dialect returns a
 * structured plan and an in-memory table applies it faithfully — which means
 * this file tests the parts a string assertion cannot: that the paging loop
 * advances its keyset correctly and terminates, that the cursor tracks the
 * right column, that a merge keeps rows the delta did not carry, that a
 * stopped run leaves a valid resume point, and that a deleted row is
 * tombstoned rather than lingering.
 *
 * Covers the six scenarios docs/SOURCE_ONBOARDING.md Phase G requires of every
 * connector: first full sync, incremental with merge, an empty entity, a
 * connection failure, a per-entity failure that does not lose the others, and
 * cancellation.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Database } from 'duckdb-async';
import { LocalFileWarehouseWriter } from '../ParquetWriter';
import { createCancellationToken } from '../BaseSourceConnector';
import { createNoopLogger } from '../logging';
import { CancellationError, type SyncContext, type SyncOptions } from '../types';
import { SqlSourceConnector } from './SqlSourceConnector';
import { buildKeyPageQuery, buildPageQuery } from './pagination';
import { baseDuckDbType } from './typeMap';
import type {
  KeyPageQueryArgs, PageQueryArgs, RawColumn, RawForeignKey, RawPrimaryKey, RawTable,
  SqlConnection, SqlDialect, SqlQuery,
} from './types';

// ─── A fake database ──────────────────────────────────────────────────────
interface FakeDb {
  tables: RawTable[];
  columns: RawColumn[];
  pks: RawPrimaryKey[];
  fks: RawForeignKey[];
  rows: Record<string, Record<string, unknown>[]>;
  /** Tables whose reads should throw, to exercise per-entity isolation. */
  failing?: Set<string>;
  connectError?: string;
  queries: string[];
}

const SYNTAX = { quoteIdent: (n: string) => `"${n}"`, placeholder: (i: number) => `$${i}`, limitStyle: 'limit' as const };

/**
 * The fake dialect. Its catalog queries return markers the fake connection
 * recognises; its page queries carry the real `PagePlan`, which the fake
 * applies exactly as a database would — so the connector's paging loop is
 * genuinely under test.
 */
function fakeDialect(db: FakeDb): SqlDialect {
  return {
    id: 'fake',
    displayName: 'Fake SQL',
    defaultPort: 1234,
    defaultSchema: () => 'public',
    quoteIdent: SYNTAX.quoteIdent,
    async connect(): Promise<SqlConnection> {
      if (db.connectError) throw new Error(db.connectError);
      return {
        async query<T>(sql: string): Promise<T[]> {
          db.queries.push(sql);
          if (sql === 'TABLES') return db.tables as unknown as T[];
          if (sql === 'COLUMNS') return db.columns as unknown as T[];
          if (sql === 'PKS') return db.pks as unknown as T[];
          if (sql === 'FKS') return db.fks as unknown as T[];
          if (sql.startsWith('PAGE:')) return applyPage(db, JSON.parse(sql.slice(5)) as PageQueryArgs) as T[];
          if (sql.startsWith('KEYS:')) return applyKeys(db, JSON.parse(sql.slice(5)) as KeyPageQueryArgs) as T[];
          throw new Error(`fake dialect got unexpected SQL: ${sql}`);
        },
        async close() { /* nothing to release */ },
      };
    },
    tablesQuery: (): SqlQuery => ({ sql: 'TABLES', params: [] }),
    columnsQuery: (): SqlQuery => ({ sql: 'COLUMNS', params: [] }),
    primaryKeysQuery: (): SqlQuery => ({ sql: 'PKS', params: [] }),
    foreignKeysQuery: (): SqlQuery => ({ sql: 'FKS', params: [] }),
    countQuery: (): SqlQuery => ({ sql: 'COUNT', params: [] }),
    toDuckDbType: (c: RawColumn) => baseDuckDbType(c),
    // Build the real SQL too, so a malformed plan would still be caught.
    pageQuery: (a: PageQueryArgs): SqlQuery => {
      buildPageQuery(SYNTAX, a);
      return { sql: `PAGE:${JSON.stringify(a)}`, params: [] };
    },
    keyPageQuery: (a: KeyPageQueryArgs): SqlQuery => {
      buildKeyPageQuery(SYNTAX, a);
      return { sql: `KEYS:${JSON.stringify(a)}`, params: [] };
    },
  };
}

/**
 * Compare two cell values the way a database would. A JS `Date` has to be
 * normalised first: `String(date)` is "Thu Jan 01 2026 …", which sorts above
 * every ISO-8601 string and would make an incremental filter silently match
 * the whole table.
 */
const cell = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
const cmp = (a: unknown, b: unknown): number => {
  const x = cell(a); const y = cell(b);
  return x === y ? 0 : (x as never) < (y as never) ? -1 : 1;
};

/** Apply a `PagePlan` to the in-memory rows exactly as a database would. */
function applyPage(db: FakeDb, args: PageQueryArgs): Record<string, unknown>[] {
  if (db.failing?.has(args.table)) throw new Error(`relation "${args.table}" is unavailable`);
  let rows = [...(db.rows[args.table] ?? [])];
  const p = args.plan;
  if (p.mode === 'keyset-cursor') {
    if (p.lowerBound !== undefined) {
      // `JSON.stringify` already turned a Date bound into ISO text.
      const lb = p.lowerBound instanceof Date ? p.lowerBound.toISOString() : String(p.lowerBound);
      rows = rows.filter((r) => String(cell(r[p.cursorColumn])) >= lb);   // inclusive: the boundary rule
    }
    if (p.after) {
      rows = rows.filter((r) => {
        const c = cmp(r[p.cursorColumn], p.after!.cursor);
        return c > 0 || (c === 0 && cmp(r[p.keyColumn], p.after!.key) > 0);
      });
    }
    rows.sort((a, b) => cmp(a[p.cursorColumn], b[p.cursorColumn]) || cmp(a[p.keyColumn], b[p.keyColumn]));
  } else if (p.mode === 'keyset-key') {
    if (p.after !== undefined) rows = rows.filter((r) => cmp(r[p.keyColumn], p.after) > 0);
    rows.sort((a, b) => cmp(a[p.keyColumn], b[p.keyColumn]));
  } else {
    for (const c of [...p.orderBy].reverse()) rows.sort((a, b) => cmp(a[c], b[c]));
    rows = rows.slice(p.offset);
  }
  return rows.slice(0, args.limit).map((r) => Object.fromEntries(args.columns.map((c) => [c, r[c]])));
}

function applyKeys(db: FakeDb, args: KeyPageQueryArgs): Record<string, unknown>[] {
  let rows = [...(db.rows[args.table] ?? [])];
  if (args.after !== undefined) rows = rows.filter((r) => cmp(r[args.keyColumn], args.after) > 0);
  rows.sort((a, b) => cmp(a[args.keyColumn], b[args.keyColumn]));
  return rows.slice(0, args.limit).map((r) => ({ [args.keyColumn]: r[args.keyColumn] }));
}

class FakeSqlConnector extends SqlSourceConnector {
  readonly type = 'fake';
  readonly displayName = 'Fake SQL';
  readonly configSchema = {
    type: 'object' as const,
    required: ['host', 'database', 'user', 'password'],
    additionalProperties: false,
    properties: {
      host: { type: 'string' as const }, database: { type: 'string' as const },
      user: { type: 'string' as const }, password: { type: 'string' as const },
      port: { type: 'integer' as const }, schema: { type: 'string' as const },
      ssl: { type: 'boolean' as const }, includeViews: { type: 'boolean' as const },
      incrementalDetection: { type: 'string' as const, enum: ['auto', 'off'] },
    },
  };
  protected readonly dialect: SqlDialect;
  constructor(db: FakeDb) { super(); this.dialect = fakeDialect(db); }
}

// ─── Fixture ──────────────────────────────────────────────────────────────
const CONFIG = { host: 'h', database: 'd', user: 'u', password: 'p' };

function makeDb(): FakeDb {
  const c = (t: string, n: string, ty: string, o: number, nullable = false): RawColumn => ({
    table_name: t, column_name: n, data_type: ty, ordinal_position: o, is_nullable: nullable,
  });
  return {
    tables: [
      { table_name: 'customers', table_type: 'table', table_comment: null },
      { table_name: 'audit', table_type: 'table', table_comment: null },
    ],
    columns: [
      c('customers', 'id', 'bigint', 1),
      c('customers', 'name', 'varchar', 2, true),
      c('customers', 'active', 'boolean', 3, true),
      c('customers', 'balance', 'numeric', 4, true),
      c('customers', 'updated_at', 'timestamp', 5),
      c('customers', 'photo', 'bytea', 6, true),
      // No primary key at all — the keyless path.
      c('audit', 'message', 'text', 1, true),
    ],
    pks: [{ table_name: 'customers', column_name: 'id', ordinal: 1 }],
    fks: [],
    rows: {
      customers: [
        { id: 1, name: 'Acme', active: true, balance: '10.50', updated_at: new Date('2026-01-01T00:00:00Z'), photo: Buffer.from('x') },
        { id: 2, name: 'Beta', active: false, balance: '20.25', updated_at: new Date('2026-01-02T00:00:00Z'), photo: null },
        { id: 3, name: 'Gamma', active: true, balance: '30.00', updated_at: new Date('2026-01-03T00:00:00Z'), photo: null },
      ],
      audit: [{ message: 'hello' }],
    },
    queries: [],
  };
}

function harness(): { root: string; ctx: SyncContext; budget: { stopAfter: number; calls: number } } {
  const root = path.join(os.tmpdir(), `sqlkit-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const budget = { stopAfter: Number.POSITIVE_INFINITY, calls: 0 };
  const ctx: SyncContext = {
    tenantId: 't1',
    connectionId: 'c1',
    warehouseWriter: new LocalFileWarehouseWriter(root),
    log: createNoopLogger(),
    progress: () => {},
    cancellationToken: createCancellationToken(),
    syncStartedAt: new Date().toISOString(),
    timeBudget: {
      shouldStop: () => { budget.calls += 1; return budget.calls > budget.stopAfter; },
      remainingMs: () => 60_000,
    },
  };
  return { root, ctx, budget };
}

async function readTable(root: string, table: string): Promise<Record<string, unknown>[]> {
  const db = await Database.create(':memory:');
  try {
    const p = path.join(root, table, 'data.parquet').replace(/'/g, "''");
    return (await db.all(`SELECT * FROM read_parquet('${p}') ORDER BY 1`)) as Record<string, unknown>[];
  } finally {
    await db.close();
  }
}

const sync = (db: FakeDb, ctx: SyncContext, opts: Partial<SyncOptions> = {}) =>
  new FakeSqlConnector(db).sync(CONFIG, { entities: ['customers'], ...opts }, ctx);

// ─── Tests ────────────────────────────────────────────────────────────────
describe('first full sync', () => {
  it('writes typed rows, drops the binary column, and advances the cursor', async () => {
    const db = makeDb();
    const { root, ctx } = harness();
    const res = await sync(db, ctx);

    expect(res.rowCounts.customers).toBe(3);
    expect(res.failedEntities).toEqual({});
    // The cursor is the highest value SEEN, so the next run resumes there.
    expect(res.cursors?.customers).toEqual({ type: 'timestamp', value: '2026-01-03T00:00:00.000Z' });
    // The binary column is reported, not silently dropped.
    expect(res.warnings.join(' ')).toContain('photo');

    const rows = await readTable(root, 'customers');
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!)).toEqual(
      ['id', 'name', 'active', 'balance', 'updated_at', '_clarion_synced_at', '_clarion_deleted'],
    );
    // Explicit types, not sampled: a BIGINT id and a real boolean.
    expect(rows[0]!.id).toBe(1n);
    expect(rows[0]!.active).toBe(true);
    expect(rows[1]!.active).toBe(false);
    expect(String(rows[0]!.balance)).toBe('10.5');
  });

  it('pages until the source is exhausted without looping', async () => {
    // 12 rows with a page size far smaller than the table proves the keyset
    // advances; a keyset that failed to advance would loop forever.
    const db = makeDb();
    db.rows.customers = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, name: `c${i}`, active: true, balance: '1.00',
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), photo: null,
    }));
    const { root, ctx } = harness();
    const res = await sync(db, ctx);
    expect(res.rowCounts.customers).toBe(12);
    expect(await readTable(root, 'customers')).toHaveLength(12);
  });
});

describe('incremental sync', () => {
  it('merges the delta into history and keeps the rows it did not carry', async () => {
    const db = makeDb();
    const { root, ctx } = harness();
    await sync(db, ctx);

    // One row edited, one added.
    db.rows.customers[1]!.name = 'Beta Renamed';
    db.rows.customers[1]!.updated_at = new Date('2026-01-04T00:00:00Z');
    db.rows.customers.push({ id: 4, name: 'Delta', active: true, balance: '40.00', updated_at: new Date('2026-01-05T00:00:00Z'), photo: null });

    const res = await sync(db, ctx, { cursors: { customers: { type: 'timestamp', value: '2026-01-03T00:00:00.000Z' } } });

    const rows = await readTable(root, 'customers');
    expect(rows).toHaveLength(4);                       // history kept
    expect(rows.find((r) => r.id === 2n)!.name).toBe('Beta Renamed');   // delta won
    expect(rows.find((r) => r.id === 1n)!.name).toBe('Acme');           // untouched row survived
    expect(res.cursors?.customers?.value).toBe('2026-01-05T00:00:00.000Z');
  });

  it('re-reads the boundary row rather than risking a skip', async () => {
    // The filter is `>=`, so the row exactly at the prior cursor comes back.
    // That is deliberate: two rows can share a second, and re-reading is free
    // under merge-by-key while skipping is silent data loss.
    const db = makeDb();
    const { ctx } = harness();
    const res = await sync(db, ctx, { cursors: { customers: { type: 'timestamp', value: '2026-01-03T00:00:00.000Z' } } });
    expect(res.rowCounts.customers).toBe(1);
  });

  it('does not move the cursor backwards when nothing newer arrived', async () => {
    const db = makeDb();
    const { ctx } = harness();
    const res = await sync(db, ctx, { cursors: { customers: { type: 'timestamp', value: '2026-06-01T00:00:00.000Z' } } });
    expect(res.rowCounts.customers).toBe(0);
    expect(res.cursors?.customers).toBeUndefined();
  });
});

describe('the empty and the broken', () => {
  it('leaves a keyed table untouched when the source returns nothing', async () => {
    // A throttled source and a genuinely emptied table look identical from
    // here, and only one of those should cost the customer their rows. On the
    // MERGE path an empty delta simply changes nothing.
    const db = makeDb();
    const { root, ctx } = harness();
    await sync(db, ctx);
    db.rows.customers = [];
    const res = await sync(db, ctx);
    expect(res.warnings.join(' ')).toContain("Entity 'customers' returned no rows");
    expect(await readTable(root, 'customers')).toHaveLength(3);
  });

  it('refuses to blank a keyless table on an empty response', async () => {
    // The overwrite path is the one that CAN destroy, so it is the one that
    // has to refuse. Only an explicit full re-sync empties a table.
    const db = makeDb();
    const { root, ctx } = harness();
    await sync(db, ctx, { entities: ['audit'] });
    db.rows.audit = [];
    const res = await sync(db, ctx, { entities: ['audit'] });
    expect(res.warnings.join(' ')).toContain('the previous table was kept');
    expect(await readTable(root, 'audit')).toHaveLength(1);
  });

  it('reports a connection failure without writing anything', async () => {
    const db = makeDb();
    db.connectError = 'password authentication failed';
    const { ctx } = harness();
    await expect(sync(db, ctx)).rejects.toThrow('password authentication failed');
  });

  it('keeps syncing the other tables when one fails', async () => {
    const db = makeDb();
    db.failing = new Set(['customers']);
    const { root, ctx } = harness();
    const res = await sync(db, ctx, { entities: ['customers', 'audit'] });
    expect(res.failedEntities?.customers).toContain('unavailable');
    expect(res.rowCounts.audit).toBe(1);
    expect(await readTable(root, 'audit')).toHaveLength(1);
  });

  it('stops the whole run on cancellation', async () => {
    const db = makeDb();
    const { ctx } = harness();
    const token = { isCancelled: true, throwIfCancelled(): void { throw new CancellationError(); } };
    await expect(sync(db, { ...ctx, cancellationToken: token })).rejects.toBeInstanceOf(CancellationError);
  });
});

describe('resumable loads', () => {
  it('stops at the time budget and leaves a checkpoint to resume from', async () => {
    const db = makeDb();
    const { ctx, budget } = harness();
    budget.stopAfter = 2;   // stop part-way through the first entity

    const res = await sync(db, ctx);
    const incomplete = res.incompleteEntities?.customers;
    expect(incomplete?.reason).toBe('time_budget');
    // A cursor-ordered pull HAS a valid resume point, so the checkpoint is
    // carried — unlike an offset-paged source, which must re-read.
    expect(incomplete?.cursor?.value).toBeTruthy();
    // An unfinished entity must not also be reported as completed.
    expect(res.cursors?.customers).toBeUndefined();
  });
});

describe('deletes', () => {
  it('tombstones a row the source no longer has, on reconcile', async () => {
    const db = makeDb();
    const { root, ctx } = harness();
    await sync(db, ctx);

    db.rows.customers = db.rows.customers.filter((r) => r.id !== 2);
    const res = await sync(db, ctx, { reconcile: true });

    expect(res.warnings.join(' ')).toContain('no longer at the source');
    const rows = await readTable(root, 'customers');
    expect(rows).toHaveLength(3);                                        // nothing removed from disk
    expect(rows.find((r) => r.id === 2n)!._clarion_deleted).toBe(true);  // hidden by the read views
    expect(rows.find((r) => r.id === 1n)!._clarion_deleted).toBe(false);
  });

  it('tombstones on a full re-sync too', async () => {
    const db = makeDb();
    const { root, ctx } = harness();
    await sync(db, ctx);
    db.rows.customers = db.rows.customers.filter((r) => r.id !== 3);
    // A new run gets a new start stamp — that is what `finalizeFullSync`
    // compares each row's last-seen stamp against.
    await sync(db, { ...ctx, syncStartedAt: new Date(Date.now() + 1000).toISOString() }, { fullResync: true });
    const rows = await readTable(root, 'customers');
    expect(rows.find((r) => r.id === 3n)!._clarion_deleted).toBe(true);
  });
});

describe('the keyless table', () => {
  it('replaces rather than merging, since there is nothing to merge on', async () => {
    const db = makeDb();
    const { root, ctx } = harness();
    const res = await sync(db, ctx, { entities: ['audit'] });
    expect(res.warnings.join(' ')).toContain('no single-column primary key');
    expect(await readTable(root, 'audit')).toHaveLength(1);
  });
});

describe('testConnection', () => {
  it('reports the reading, not just success', async () => {
    // Everything about a SQL source is inferred from the customer's schema,
    // and the wizard is the last place a wrong reading can be caught.
    const r = await new FakeSqlConnector(makeDb()).testConnection(CONFIG, { log: createNoopLogger() });
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ tables: '2', 'with a primary key': '1 of 2', 'synced incrementally': '1 of 2' });
  });

  it('returns a reason instead of throwing when the server refuses', async () => {
    const db = makeDb();
    db.connectError = 'ECONNREFUSED 10.0.0.1:5432';
    const r = await new FakeSqlConnector(db).testConnection(CONFIG, { log: createNoopLogger() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('describeEntities', () => {
  it('carries the declared key, the real types and the enforced foreign keys', async () => {
    const db = makeDb();
    db.tables.push({ table_name: 'orders', table_type: 'table', table_comment: 'Sales orders' });
    db.columns.push(
      { table_name: 'orders', column_name: 'id', data_type: 'integer', ordinal_position: 1, is_nullable: false },
      { table_name: 'orders', column_name: 'customer_id', data_type: 'bigint', ordinal_position: 2, is_nullable: false, column_comment: 'Who ordered' },
    );
    db.pks.push({ table_name: 'orders', column_name: 'id', ordinal: 1 });
    db.fks.push({ from_table: 'orders', from_column: 'customer_id', to_table: 'customers', to_column: 'id' });

    const docs = await new FakeSqlConnector(db).describeEntities(CONFIG, [], { log: createNoopLogger() });
    const orders = docs.find((d) => d.entityName === 'orders')!;

    expect(orders.provenance).toBe('declared');
    expect(orders.description).toBe('Sales orders');
    expect(orders.businessKey).toBe('id');
    expect(orders.relationships).toContainEqual(expect.objectContaining({
      fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id',
    }));
    // The database's own type name travels for the relationship type check.
    expect(orders.columns.find((c) => c.name === 'customer_id')!.dataType).toBe('bigint');
    expect(orders.columns.find((c) => c.name === 'customer_id')!.description).toBe('Who ordered');
    // No comment means no description — the AI pass fills that gap rather
    // than the connector inventing documentation at the trusted rung.
    expect(orders.columns.find((c) => c.name === 'id')!.description).toBeUndefined();
  });
});
