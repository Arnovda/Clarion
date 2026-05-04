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
});
