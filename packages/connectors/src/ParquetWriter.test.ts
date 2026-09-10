/**
 * Smoke tests for `LocalFileWarehouseWriter`.
 *
 * Verifies the connector → Parquet path end to end on a real DuckDB instance.
 * The DuckDB binding is the highest-risk dependency in this package — if
 * these pass, all subsequent connector work is on solid ground.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Database } from 'duckdb-async';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { LocalFileWarehouseWriter } from './ParquetWriter';

async function* fromArray<T>(rows: T[]): AsyncIterable<T> {
  for (const r of rows) yield r;
}

const tmpRoots: string[] = [];
async function makeTmpRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `dbtest-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('LocalFileWarehouseWriter', () => {
  it('writes rows as Parquet and they round-trip through DuckDB', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    const rows = [
      { id: 1, name: 'Acme NV',  active: true,  amount: 12.5 },
      { id: 2, name: 'Globex',   active: false, amount: -3.0 },
      { id: 3, name: 'Initech',  active: true,  amount: 0 },
    ];

    const result = await writer.writeTable('Accounts', fromArray(rows));

    expect(result.rowsWritten).toBe(3);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.warehousePath.replace(/\\/g, '/')).toBe('Accounts/data.parquet');

    // Read back through a fresh DuckDB instance to verify the file.
    const db = await Database.create(':memory:');
    try {
      const parquetPath = path.join(root, 'Accounts', 'data.parquet').replace(/'/g, "''");
      const out = await db.all(`SELECT id, name, active, amount FROM read_parquet('${parquetPath}') ORDER BY id`);
      expect(out).toHaveLength(3);
      // DuckDB returns INT64 as BigInt to preserve precision — matches what
      // Clarion's existing DuckDBConnector sees on every other warehouse path.
      expect(Number(out[0].id)).toBe(1);
      expect(out[0].name).toBe('Acme NV');
      expect(out[0].active).toBe(true);
      expect(Number(out[2].id)).toBe(3);
      expect(out[2].name).toBe('Initech');
      expect(Number(out[2].amount)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('handles empty entities by writing an empty Parquet (no error downstream)', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);

    const result = await writer.writeTable('NoData', fromArray([]));

    expect(result.rowsWritten).toBe(0);
    const exists = await fs.stat(path.join(root, 'NoData', 'data.parquet'));
    expect(exists.isFile()).toBe(true);

    // The empty file should still be readable by DuckDB and return zero rows.
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'NoData', 'data.parquet').replace(/'/g, "''");
      const out = await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${p}')`);
      expect(Number(out[0].n)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rejects unsafe table names', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    await expect(writer.writeTable('../escape', fromArray([{ a: 1 }]))).rejects.toThrow(/unsafe table name/i);
    await expect(writer.writeTable('foo/bar', fromArray([{ a: 1 }]))).rejects.toThrow(/unsafe table name/i);
    await expect(writer.writeTable('', fromArray([{ a: 1 }]))).rejects.toThrow(/unsafe table name/i);
  });

  it('streams large iterables without buffering the whole dataset', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);

    async function* manyRows(): AsyncIterable<Record<string, unknown>> {
      for (let i = 0; i < 12_000; i++) yield { id: i, label: `row-${i}` };
    }

    const result = await writer.writeTable('Big', manyRows());
    expect(result.rowsWritten).toBe(12_000);

    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'Big', 'data.parquet').replace(/'/g, "''");
      const out = await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${p}')`);
      expect(Number(out[0].n)).toBe(12_000);
    } finally {
      await db.close();
    }
  });

  it('merge mode upserts by key: delta wins on conflict, existing-only rows kept', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);

    // First write — initial full sync.
    await writer.writeTable('Items', fromArray([
      { ID: 1, Name: 'Alpha',   Price: 10 },
      { ID: 2, Name: 'Bravo',   Price: 20 },
      { ID: 3, Name: 'Charlie', Price: 30 },
    ]));

    // Second write — incremental delta: row 2 updated (price changed),
    // row 4 added. Row 1 + Row 3 are NOT in the delta and must survive.
    const result = await writer.writeTable(
      'Items',
      fromArray([
        { ID: 2, Name: 'Bravo',  Price: 25 },   // update
        { ID: 4, Name: 'Delta',  Price: 40 },   // insert
      ]),
      { mergeKey: 'ID' },
    );
    expect(result.rowsWritten).toBe(2);

    // Verify the merge: 4 distinct rows, with row 2's price = 25.
    // DuckDB returns ints from Parquet as `bigint`; we cast to plain
    // Numbers for ergonomic comparison.
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'Items', 'data.parquet').replace(/'/g, "''");
      const rows = await db.all(`SELECT * FROM read_parquet('${p}') ORDER BY ID`) as Array<{ ID: bigint; Name: string; Price: bigint }>;
      const norm = rows.map((r) => ({ ID: Number(r.ID), Name: r.Name, Price: Number(r.Price) }));
      expect(norm).toEqual([
        { ID: 1, Name: 'Alpha',   Price: 10 },
        { ID: 2, Name: 'Bravo',   Price: 25 },  // delta won
        { ID: 3, Name: 'Charlie', Price: 30 },
        { ID: 4, Name: 'Delta',   Price: 40 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('merge with explicit columns converges legacy mistyped columns to the declared schema', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);

    // 1. Legacy write via auto-detect: `note` is NULL in every row, which
    //    auto-detect types as JSON (the CreatorFullName production bug).
    await writer.writeTable('Accounts', fromArray([
      { ID: 'a1', note: null, amount: 1 },
      { ID: 'a2', note: null, amount: 2 },
    ]), { mergeKey: 'ID' });

    const parquetPath = path.join(root, 'Accounts', 'data.parquet').replace(/'/g, "''");
    const db1 = await Database.create(':memory:');
    try {
      const desc = await db1.all(`DESCRIBE SELECT * FROM read_parquet('${parquetPath}')`) as Array<{ column_name: string; column_type: string }>;
      expect(desc.find((d) => d.column_name === 'note')?.column_type).toBe('JSON'); // legacy state
    } finally {
      await db1.close();
    }

    // 2. Incremental merge WITH the vendor-declared schema. The existing
    //    side must be cast to the declared types, so the merged file's
    //    `note` column comes out VARCHAR — not stuck on JSON forever.
    const declared = [
      { name: 'ID', sqlType: 'VARCHAR' },
      { name: 'note', sqlType: 'VARCHAR' },
      { name: 'amount', sqlType: 'DOUBLE' },
    ];
    await writer.writeTable('Accounts', fromArray([
      { ID: 'a3', note: 'hello', amount: 3 },
    ]), { mergeKey: 'ID', columns: declared });

    const db2 = await Database.create(':memory:');
    try {
      const desc = await db2.all(`DESCRIBE SELECT * FROM read_parquet('${parquetPath}')`) as Array<{ column_name: string; column_type: string }>;
      const typeOf = new Map(desc.map((d) => [d.column_name, d.column_type]));
      expect(typeOf.get('note')).toBe('VARCHAR');
      expect(typeOf.get('amount')).toBe('DOUBLE');
      const rows = await db2.all(`SELECT * FROM read_parquet('${parquetPath}') ORDER BY ID`);
      expect(rows).toHaveLength(3);
      expect(rows[0].note).toBeNull();          // legacy NULLs survive the cast
      expect(rows[2].note).toBe('hello');
    } finally {
      await db2.close();
    }
  });

  it('merge mode on first write (no existing file) just writes the delta', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    const result = await writer.writeTable(
      'NewTable',
      fromArray([{ ID: 1, X: 'a' }, { ID: 2, X: 'b' }]),
      { mergeKey: 'ID' },
    );
    expect(result.rowsWritten).toBe(2);

    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'NewTable', 'data.parquet').replace(/'/g, "''");
      const rows = await db.all(`SELECT * FROM read_parquet('${p}') ORDER BY ID`);
      expect(rows).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it('merge mode rejects unsafe merge keys', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    await expect(
      writer.writeTable('Items', fromArray([{ ID: 1 }]), { mergeKey: 'x; DROP TABLE' }),
    ).rejects.toThrow(/unsafe mergeKey/i);
    await expect(
      writer.writeTable('Items', fromArray([{ ID: 1 }]), { mergeKey: '../escape' }),
    ).rejects.toThrow(/unsafe mergeKey/i);
  });
});

// ─── P0-6: the sync tells the truth ──────────────────────────────────────
// A transient empty response used to WIPE a table on the overwrite path (no
// mergeKey) and the run still said succeeded; and no write path could ever
// remove a row deleted at the source. These pin the two writer rules.
describe('LocalFileWarehouseWriter — empty batches and full replace (P0-6)', () => {
  async function countRows(root: string, table: string): Promise<number> {
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, table, 'data.parquet').replace(/'/g, "''");
      const out = await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${p}')`);
      return Number(out[0].n);
    } finally {
      await db.close();
    }
  }

  it('an EMPTY batch on the overwrite path keeps the existing table and says so', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    await writer.writeTable('Accounts', fromArray([{ ID: 1 }, { ID: 2 }, { ID: 3 }]));

    const result = await writer.writeTable('Accounts', fromArray([]));

    expect(result.rowsWritten).toBe(0);
    expect(result.preservedExisting).toBe(true);
    expect(await countRows(root, 'Accounts')).toBe(3);
  });

  it('an empty batch with `replace` really does empty the table (a full re-sync of an emptied source)', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    await writer.writeTable('Accounts', fromArray([{ ID: 1 }, { ID: 2 }]));

    const result = await writer.writeTable('Accounts', fromArray([]), { replace: true, columns: [{ name: 'ID', sqlType: 'BIGINT' }] });

    expect(result.preservedExisting).toBeUndefined();
    expect(await countRows(root, 'Accounts')).toBe(0);
  });

  it('`replace` with a mergeKey overwrites instead of merging: rows absent from the batch are GONE', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    await writer.writeTable('Items', fromArray([{ ID: 1, Name: 'Alpha' }, { ID: 2, Name: 'Bravo' }, { ID: 3, Name: 'Charlie' }]));

    // Row 2 was deleted at the source; a merge would keep it forever.
    await writer.writeTable('Items', fromArray([{ ID: 1, Name: 'Alpha' }, { ID: 3, Name: 'Charlie' }]), { mergeKey: 'ID', replace: true });

    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'Items', 'data.parquet').replace(/'/g, "''");
      const rows = await db.all(`SELECT ID FROM read_parquet('${p}') ORDER BY ID`) as Array<{ ID: bigint }>;
      expect(rows.map((r) => Number(r.ID))).toEqual([1, 3]);
    } finally {
      await db.close();
    }
  });
});

describe('LocalFileWarehouseWriter — soft delete + row counts (phase 2, B2/B6)', () => {
  async function query<T = Record<string, unknown>>(root: string, table: string, sql: string): Promise<T[]> {
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, table, 'data.parquet').replace(/'/g, "''");
      return await db.all(sql.replace('$T', `read_parquet('${p}')`)) as T[];
    } finally {
      await db.close();
    }
  }
  const aliveIds = async (root: string, table: string) =>
    (await query<{ ID: bigint }>(root, table, `SELECT ID FROM $T WHERE NOT COALESCE(_clarion_deleted, false) ORDER BY ID`)).map((r) => Number(r.ID));
  const deletedIds = async (root: string, table: string) =>
    (await query<{ ID: bigint }>(root, table, `SELECT ID FROM $T WHERE COALESCE(_clarion_deleted, false) ORDER BY ID`)).map((r) => Number(r.ID));

  it('every write carries the two technical columns and reports the alive row count', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    const before = Date.now();
    const r = await writer.writeTable('Items', fromArray([{ ID: 1, Name: 'Alpha' }, { ID: 2, Name: 'Bravo' }]));
    expect(r.rowsTotal).toBe(2);
    const rows = await query<{ ID: bigint; _clarion_synced_at: Date; _clarion_deleted: boolean }>(root, 'Items', `SELECT * FROM $T ORDER BY ID`);
    expect(rows.map((x) => x._clarion_deleted)).toEqual([false, false]);
    for (const x of rows) expect(new Date(x._clarion_synced_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a merge keeps a deleted row deleted unless the delta brings it back, and a legacy file gains the columns', async () => {
    const root = await makeTmpRoot();
    // A file written BEFORE the columns existed: plain parquet, no stamps.
    await fs.mkdir(path.join(root, 'Legacy'), { recursive: true });
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'Legacy', 'data.parquet').replace(/'/g, "''");
      await db.all(`COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) t(ID, Name)) TO '${p}' (FORMAT parquet)`);
    } finally { await db.close(); }
    const writer = new LocalFileWarehouseWriter(root);

    // Merge a delta: legacy rows read as alive with no stamp; the delta row is stamped.
    const r1 = await writer.writeTable('Legacy', fromArray([{ ID: 2, Name: 'B2' }]), { mergeKey: 'ID' });
    expect(r1.rowsTotal).toBe(3);
    expect(await aliveIds(root, 'Legacy')).toEqual([1, 2, 3]);
    const stamps = await query<{ ID: bigint; s: Date | null }>(root, 'Legacy', `SELECT ID, _clarion_synced_at AS s FROM $T ORDER BY ID`);
    expect(stamps.map((x) => x.s === null)).toEqual([true, false, true]);

    // A full re-sync that saw only rows 1 and 2 → 3 is marked deleted, not removed.
    const syncStartedAt = new Date(Date.now() - 60_000).toISOString();
    await writer.writeTable('Legacy', fromArray([{ ID: 1, Name: 'a' }, { ID: 2, Name: 'b' }]), { mergeKey: 'ID' });
    const fin = await writer.finalizeFullSync('Legacy', { syncStartedAt });
    expect(fin).toEqual({ tombstoned: 1, rowsTotal: 2 });
    expect(await deletedIds(root, 'Legacy')).toEqual([3]);
    expect((await query(root, 'Legacy', `SELECT count(*) AS n FROM $T`))[0]).toMatchObject({ n: 3n });

    // The row reappears in a later delta → alive again; the others untouched.
    const r2 = await writer.writeTable('Legacy', fromArray([{ ID: 3, Name: 'c-again' }]), { mergeKey: 'ID' });
    expect(r2.rowsTotal).toBe(3);
    expect(await deletedIds(root, 'Legacy')).toEqual([]);
  });

  it('finalizeFullSync on a file that never had the columns marks everything (nothing in it was seen)', async () => {
    const root = await makeTmpRoot();
    await fs.mkdir(path.join(root, 'Old'), { recursive: true });
    const db = await Database.create(':memory:');
    try {
      const p = path.join(root, 'Old', 'data.parquet').replace(/'/g, "''");
      await db.all(`COPY (SELECT * FROM (VALUES (1), (2)) t(ID)) TO '${p}' (FORMAT parquet)`);
    } finally { await db.close(); }
    const writer = new LocalFileWarehouseWriter(root);
    const fin = await writer.finalizeFullSync('Old', { syncStartedAt: new Date().toISOString() });
    expect(fin).toEqual({ tombstoned: 2, rowsTotal: 0 });
    expect(await writer.finalizeFullSync('Missing', { syncStartedAt: new Date().toISOString() })).toEqual({ tombstoned: 0, rowsTotal: 0 });
  });

  it('reconcileKeys marks absent keys deleted, revives present ones, and refuses an empty key list', async () => {
    const root = await makeTmpRoot();
    const writer = new LocalFileWarehouseWriter(root);
    await writer.writeTable('Accounts', fromArray([{ ID: 'a', N: 1 }, { ID: 'b', N: 2 }, { ID: 'c', N: 3 }]), { mergeKey: 'ID' });

    const r1 = await writer.reconcileKeys('Accounts', 'ID', fromArray(['a', 'c']));
    expect(r1).toEqual({ tombstoned: 1, revived: 0, rowsTotal: 2 });
    expect((await query<{ ID: string }>(root, 'Accounts', `SELECT ID FROM $T WHERE _clarion_deleted ORDER BY ID`)).map((x) => x.ID)).toEqual(['b']);

    // b is back at the source, a is gone.
    const r2 = await writer.reconcileKeys('Accounts', 'ID', fromArray(['b', 'c']));
    expect(r2).toEqual({ tombstoned: 1, revived: 1, rowsTotal: 2 });
    expect((await query<{ ID: string }>(root, 'Accounts', `SELECT ID FROM $T WHERE _clarion_deleted ORDER BY ID`)).map((x) => x.ID)).toEqual(['a']);

    // An empty key list over a non-empty table is refused — a throttled
    // endpoint must not tombstone a whole table.
    const r3 = await writer.reconcileKeys('Accounts', 'ID', fromArray([]));
    expect(r3.refusedEmpty).toBe(true);
    expect(r3.rowsTotal).toBe(2);
    expect((await query<{ ID: string }>(root, 'Accounts', `SELECT ID FROM $T WHERE _clarion_deleted ORDER BY ID`)).map((x) => x.ID)).toEqual(['a']);

    await expect(writer.reconcileKeys('Accounts', 'ID; DROP', fromArray(['a']))).rejects.toThrow(/Unsafe key column/);
  });

  it('a merge under a bounded memory limit stays proportional to the delta, not the table', async () => {
    // 300k existing rows, a 1k delta, 96MB ceiling: the window-function merge
    // this replaced needed the whole table in memory (OOM at 1.1 GiB on 3M
    // rows in the PoC); the anti-join builds its hash table from the delta.
    process.env.DUCKDB_MEMORY_LIMIT = '96MB';
    try {
      const root = await makeTmpRoot();
      await fs.mkdir(path.join(root, 'Big'), { recursive: true });
      const db = await Database.create(':memory:');
      try {
        const p = path.join(root, 'Big', 'data.parquet').replace(/'/g, "''");
        await db.all(`COPY (SELECT i AS ID, md5(i::varchar) AS Payload, i * 1.5 AS Amount FROM range(300000) t(i)) TO '${p}' (FORMAT parquet)`);
      } finally { await db.close(); }
      const writer = new LocalFileWarehouseWriter(root);
      async function* delta() {
        for (let i = 0; i < 1000; i++) yield { ID: i * 100, Payload: 'updated', Amount: 0 };
      }
      const r = await writer.writeTable('Big', delta(), { mergeKey: 'ID' });
      expect(r.rowsWritten).toBe(1000);
      expect(r.rowsTotal).toBe(300000);
      const upd = await query<{ n: bigint }>(root, 'Big', `SELECT count(*) AS n FROM $T WHERE Payload = 'updated'`);
      expect(Number(upd[0].n)).toBe(1000);
    } finally {
      delete process.env.DUCKDB_MEMORY_LIMIT;
    }
  });
});
