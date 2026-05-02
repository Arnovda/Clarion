/**
 * Parquet writers — sandboxed warehouse writers connectors use to land data.
 *
 * Two production implementations behind one `WarehouseWriter` interface:
 *
 *   • LocalFileWarehouseWriter — writes to a local filesystem path. Used in
 *     local dev and tests. Same on-disk layout as production so DataBridge's
 *     existing DuckDBConnector reads it without modification.
 *
 *   • BlobSasWarehouseWriter (Day 6) — writes to Azure Blob via a
 *     SAS-scoped client. Same interface; just swaps the storage backend.
 *
 * Why DuckDB as the writer:
 *   • Already a dependency of DataBridge — no new native binding to ship.
 *   • DuckDB's `COPY (...) TO '<path>' (FORMAT 'parquet', COMPRESSION 'snappy')`
 *     is faster and more correct than any pure-JS Parquet writer.
 *   • Schema inference from JSON is built in — connectors can write
 *     heterogeneous row shapes and DuckDB widens types reasonably.
 *
 * Streaming model: writeTable(...) accepts an AsyncIterable of rows. We
 * batch rows in-memory up to BATCH_ROWS, then write a Parquet file
 * containing all batches via a temp JSON staging file → DuckDB COPY.
 *
 * Why staged JSON instead of streaming directly into DuckDB: DuckDB's Node
 * binding doesn't have a streaming append API for Parquet. Staging through
 * NDJSON is fast (DuckDB reads NDJSON natively at GB/s) and lets us deal
 * with sparse / heterogeneous row shapes without manually constructing an
 * Arrow schema. For SMB-scale entities (≤ a few million rows / table)
 * the temp file overhead is negligible.
 */

import { Database } from 'duckdb-async';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { TableWriteResult, WarehouseWriter } from './types';

const BATCH_ROWS = 5_000;

// ─── Local filesystem writer ──────────────────────────────────────────────
export class LocalFileWarehouseWriter implements WarehouseWriter {
  /**
   * @param warehouseRoot Absolute path to the warehouse root.
   *                       Final layout: <warehouseRoot>/<tableName>/data.parquet
   */
  constructor(private readonly warehouseRoot: string) {
    if (!path.isAbsolute(warehouseRoot)) {
      throw new Error(`warehouseRoot must be absolute, got: ${warehouseRoot}`);
    }
  }

  async writeTable(
    tableName: string,
    rows: AsyncIterable<Record<string, unknown>>,
  ): Promise<TableWriteResult> {
    if (!isSafeTableName(tableName)) {
      throw new Error(`Unsafe table name: ${tableName}`);
    }

    const outDir = path.join(this.warehouseRoot, tableName);
    const outFile = path.join(outDir, 'data.parquet');
    await fs.mkdir(outDir, { recursive: true });

    const stagingPath = path.join(
      os.tmpdir(),
      `databridge-stage-${randomUUID()}.ndjson`,
    );

    let rowsWritten = 0;
    const fh = await fs.open(stagingPath, 'w');
    try {
      let batch: string[] = [];
      for await (const row of rows) {
        batch.push(jsonLine(row));
        rowsWritten += 1;
        if (batch.length >= BATCH_ROWS) {
          await fh.write(batch.join(''));
          batch = [];
        }
      }
      if (batch.length > 0) {
        await fh.write(batch.join(''));
      }
    } finally {
      await fh.close();
    }

    if (rowsWritten === 0) {
      // Empty entity — write an empty Parquet so downstream profilers don't
      // crash on missing files. Use a dummy schema with one nullable column.
      await writeEmptyParquet(outFile);
      await fs.unlink(stagingPath).catch(() => undefined);
    } else {
      await convertNdjsonToParquet(stagingPath, outFile);
      await fs.unlink(stagingPath).catch(() => undefined);
    }

    const stat = await fs.stat(outFile);
    return {
      rowsWritten,
      bytesWritten: stat.size,
      warehousePath: path.relative(this.warehouseRoot, outFile),
    };
  }
}

// ─── DuckDB-backed conversion ─────────────────────────────────────────────
async function convertNdjsonToParquet(ndjsonPath: string, parquetPath: string): Promise<void> {
  // In-memory DuckDB instance per write. Cheap (~10ms cold start) and avoids
  // sharing state between concurrent connector runs.
  const db = await Database.create(':memory:');
  try {
    // read_json with format=newline_delimited handles NDJSON natively.
    // auto_detect=true lets DuckDB infer the schema from a sample.
    // SAFE escaping of paths: DuckDB doesn't support parameterised paths in COPY,
    // so we apply a strict allow-list above (`isSafeTableName`) and use absolute
    // paths only. Single-quotes inside the path are escaped here as a defensive
    // measure even though our paths shouldn't contain them.
    const escNd = ndjsonPath.replace(/'/g, "''");
    const escPq = parquetPath.replace(/'/g, "''");
    await db.all(`
      COPY (
        SELECT * FROM read_json('${escNd}', format='newline_delimited', auto_detect=true)
      )
      TO '${escPq}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

async function writeEmptyParquet(parquetPath: string): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    const esc = parquetPath.replace(/'/g, "''");
    await db.all(`
      COPY (SELECT NULL::VARCHAR AS _placeholder WHERE FALSE)
      TO '${esc}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
/**
 * Defence-in-depth check on table names. Even though connectors come from
 * vetted code, we never trust strings to be safe path components. Forces
 * names to a safe ASCII subset and rejects path-traversal characters.
 */
function isSafeTableName(name: string): boolean {
  return /^[A-Za-z0-9_\-]+$/.test(name) && name.length <= 128 && !name.startsWith('-');
}

/**
 * Stringify a row as NDJSON. Drops undefined values, leaves nulls.
 * Wraps non-finite numbers (NaN, ±Infinity) as null — Parquet doesn't
 * have a representation and DuckDB treats them as errors.
 */
function jsonLine(row: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) {
      cleaned[k] = null;
    } else {
      cleaned[k] = v;
    }
  }
  return `${JSON.stringify(cleaned)}\n`;
}
