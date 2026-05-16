/**
 * Parquet writers — sandboxed warehouse writers connectors use to land data.
 *
 * Two production implementations behind one `WarehouseWriter` interface:
 *
 *   • LocalFileWarehouseWriter — writes to a local filesystem path. Used in
 *     local dev and tests. Same on-disk layout as production so Clarion's
 *     existing DuckDBConnector reads it without modification.
 *
 *   • BlobSasWarehouseWriter (Day 6) — writes to Azure Blob via a
 *     SAS-scoped client. Same interface; just swaps the storage backend.
 *
 * Why DuckDB as the writer:
 *   • Already a dependency of Clarion — no new native binding to ship.
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
import type { TableWriteResult, WarehouseWriter, WriteTableOptions } from './types';

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
    opts?: WriteTableOptions,
  ): Promise<TableWriteResult> {
    if (!isSafeTableName(tableName)) {
      throw new Error(`Unsafe table name: ${tableName}`);
    }
    if (opts?.mergeKey && !isSafeColumnName(opts.mergeKey)) {
      throw new Error(`Unsafe mergeKey: ${opts.mergeKey}`);
    }

    const outDir = path.join(this.warehouseRoot, tableName);
    const outFile = path.join(outDir, 'data.parquet');
    await fs.mkdir(outDir, { recursive: true });

    const stagingPath = path.join(
      os.tmpdir(),
      `clarion-stage-${randomUUID()}.ndjson`,
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

    // Merge mode: if a mergeKey is provided AND an existing Parquet
    // exists for this table, build the new file as
    //   existing UPSERT delta on mergeKey
    // i.e. existing rows stay unless overwritten by a delta row with the
    // same key. New keys in the delta are appended. Existing rows whose
    // key is absent from the delta are KEPT (no delete detection — that
    // is an explicit non-goal of incremental sync v1).
    const existingPath = await fileExists(outFile) ? outFile : null;
    const useMerge = !!opts?.mergeKey && existingPath !== null;

    if (rowsWritten === 0 && !useMerge) {
      // Empty entity, no existing file to preserve. When the connector
      // supplied an explicit schema (typically because it knows the
      // entity's column shape via an out-of-band mechanism like OData
      // $metadata), we write a parquet WITH that schema so the catalog
      // can show the columns. Otherwise fall back to the legacy
      // single-_placeholder shape — keeps downstream profilers from
      // crashing on missing files but isn't useful for understanding
      // what an empty table would contain.
      if (opts?.emptySchema && opts.emptySchema.length > 0) {
        await writeEmptyParquetWithSchema(outFile, opts.emptySchema);
      } else {
        await writeEmptyParquet(outFile);
      }
      await fs.unlink(stagingPath).catch(() => undefined);
    } else if (useMerge) {
      // Merge existing + delta on mergeKey. DuckDB does the heavy lifting
      // in SQL — no per-row JavaScript memory cost.
      await mergeNdjsonIntoExistingParquet(stagingPath, existingPath!, outFile, opts!.mergeKey!);
      await fs.unlink(stagingPath).catch(() => undefined);
    } else {
      // Standard overwrite path.
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

/**
 * Merge an NDJSON delta into an existing Parquet file, writing the
 * result back to `outPath`. Upserts on `mergeKey`: when a key exists in
 * both, the DELTA wins (the row from NDJSON replaces the existing row).
 * Keys present only in existing are kept; keys present only in delta
 * are appended.
 *
 * Implementation strategy:
 *   1. Read existing Parquet via DuckDB
 *   2. UNION delta NDJSON via read_json — DuckDB widens types reasonably
 *   3. ROW_NUMBER() partitioned by mergeKey ordered to put delta last,
 *      keep the last row per key (so delta overwrites existing)
 *   4. COPY to a tmpdir-staged Parquet, then move into place.
 *
 * Staging in os.tmpdir (NOT next to outPath) is intentional — on Windows
 * DuckDB holds a directory-level lock on the existing-Parquet's folder
 * even after `db.close()`, which prevents an in-place rename. Staging
 * far away then doing a final move sidesteps the issue completely.
 */
async function mergeNdjsonIntoExistingParquet(
  ndjsonPath: string,
  existingParquetPath: string,
  outPath: string,
  mergeKey: string,
): Promise<void> {
  // Copy the existing parquet to tmpdir first so DuckDB's read lock sits
  // on the copy, not on outPath. Without this, on Windows the lock
  // lingers past db.close() and the subsequent rename into outPath fails
  // with EPERM. Linux/Mac don't need this; cheap insurance everywhere.
  const existingCopy = path.join(os.tmpdir(), `clarion-existing-${randomUUID()}.parquet`);
  await fs.copyFile(existingParquetPath, existingCopy);

  // Stage the merged output in os.tmpdir too — see same Windows note.
  const tmpOut = path.join(os.tmpdir(), `clarion-merge-${randomUUID()}.parquet`);
  const db = await Database.create(':memory:');
  try {
    const escNd = ndjsonPath.replace(/'/g, "''");
    const escEx = existingCopy.replace(/'/g, "''");
    const escOut = tmpOut.replace(/'/g, "''");
    const escKey = mergeKey.replace(/"/g, '""');

    // Guard: merge-by-key with NULL values in the key column silently
    // produces duplicates. PARTITION BY treats every NULL as its own
    // partition, so two delta rows with NULL keys both survive the
    // ROW_NUMBER filter, and the next sync's existing+delta pair will
    // do the same — accumulating one duplicate per sync. Better to
    // fail loudly here than to silently corrupt the table.
    const nullCheck = await db.all(
      `SELECT COUNT(*) AS n FROM read_json('${escNd}', format='newline_delimited', auto_detect=true) WHERE "${escKey}" IS NULL`,
    ) as Array<{ n: number | bigint }>;
    const nullCount = Number(nullCheck[0]?.n ?? 0);
    if (nullCount > 0) {
      throw new Error(
        `Merge refused: ${nullCount} delta row(s) have NULL in business-key column '${mergeKey}'. ` +
        `Merging with NULL keys would silently produce duplicates on every sync. ` +
        `Either fix the source so the key is always populated, or remove businessKey from the entity ` +
        `descriptor to opt into full-table overwrite semantics.`,
      );
    }

    // The CTE pattern below:
    //   - `merged`        : existing rows tagged origin=0, delta rows origin=1
    //   - ROW_NUMBER PARTITION BY <key> ORDER BY origin DESC
    //                       (delta wins because higher origin)
    //   - Keep rn=1 from each partition
    //
    // DuckDB resolves the schema by aligning the two SELECTs. If existing
    // has columns the delta doesn't (or vice versa), the missing values
    // become NULL — same behaviour as pandas concat. This handles
    // schema evolution gracefully across syncs.
    await db.all(`
      COPY (
        WITH delta AS (
          SELECT * FROM read_json('${escNd}', format='newline_delimited', auto_detect=true)
        ),
        existing AS (
          SELECT * FROM read_parquet('${escEx}')
        ),
        merged AS (
          SELECT *, 0 AS _origin FROM existing
          UNION ALL BY NAME
          SELECT *, 1 AS _origin FROM delta
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY "${escKey}"
            ORDER BY _origin DESC
          ) AS _rn
          FROM merged
        )
        SELECT * EXCLUDE (_origin, _rn) FROM ranked WHERE _rn = 1
      )
      TO '${escOut}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
    await fs.unlink(existingCopy).catch(() => undefined);
  }
  // Replace the existing parquet with the merged result. Delete-then-
  // rename rather than overwrite-rename — Windows EPERM otherwise.
  // Worst case if the rename below fails: the table is briefly absent.
  // The next sync re-pulls everything (full sync from no cursor) and
  // rewrites it. Correct, just slower.
  await fs.unlink(outPath).catch(() => undefined);
  await fs.rename(tmpOut, outPath);
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

/**
 * Write an empty Parquet with the caller-supplied schema. Each column is
 * created with the requested SQL type via `NULL::<type>`, and the
 * `WHERE FALSE` keeps the result rowless — so the file is an empty
 * table with the right schema, ready for the catalog to introspect.
 *
 * Column names + types are validated against an ASCII allow-list before
 * being interpolated into SQL. Anything outside the allow-list falls
 * back to VARCHAR + a safe column alias — defence-in-depth even though
 * the metadata fetcher already controls the input.
 */
async function writeEmptyParquetWithSchema(
  parquetPath: string,
  schema: ReadonlyArray<{ name: string; sqlType: string }>,
): Promise<void> {
  const db = await Database.create(':memory:');
  try {
    const esc = parquetPath.replace(/'/g, "''");
    const projections = schema.map((col, i) => {
      const safeName = isSafeColumnName(col.name) ? col.name : `col_${i}`;
      const safeType = isSafeSqlType(col.sqlType) ? col.sqlType : 'VARCHAR';
      // Double-quote the column name so PascalCase + reserved-word
      // columns work. SQL type stays bare (it's allow-listed above).
      return `NULL::${safeType} AS "${safeName.replace(/"/g, '""')}"`;
    }).join(', ');
    await db.all(`
      COPY (SELECT ${projections} WHERE FALSE)
      TO '${esc}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

function isSafeSqlType(t: string): boolean {
  // DuckDB primitive type names we expect to receive from the connector
  // (mapped from OData EDM types). Anything outside this list falls
  // back to VARCHAR rather than getting interpolated.
  return /^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|DOUBLE|REAL|DECIMAL\(\d+,\d+\)|BOOLEAN|DATE|TIMESTAMP|TIMESTAMPTZ|UUID|BLOB)$/.test(t);
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
 * Allow-list for column identifiers we inject into SQL. The merge query
 * builds `PARTITION BY "<mergeKey>"` so we need a tight bound on what's
 * accepted. Connectors should always pass canonical column names here.
 */
function isSafeColumnName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 128;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
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
