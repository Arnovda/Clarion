/**
 * The parquet operations both warehouse writers run — ONE copy, not two.
 *
 * Until phase 2 the local writer and the Azure writer each carried their own
 * merge SQL ("library-isolated copy"), and the two had already drifted in
 * their comments. Everything DuckDB-shaped now lives here; the writers keep
 * only what differs between them — where the bytes come from and go to
 * (a directory on disk vs a download/upload round trip through a SAS URL).
 *
 * Two rules every operation here obeys:
 *
 *  1. THE MERGE IS AN ANTI-JOIN, NOT A WINDOW. The original merge ranked
 *     existing ∪ delta with `ROW_NUMBER() OVER (PARTITION BY key)`, whose
 *     memory is proportional to the TABLE. Measured 2026-09-10 on a
 *     3M-row / 208 MB TransactionLines-shaped table with a 10k delta, one
 *     thread: out of memory at a 1.1 GiB ceiling, 1.3 GB peak with the
 *     ceiling lifted. `existing WHERE NOT EXISTS (delta) UNION ALL delta`
 *     builds its hash table from the DELTA — same result, 4.5 s, +150 MB.
 *     It is still O(table) in I/O (the file is rewritten); the table format
 *     that makes it O(delta) is phase 2's B1 and is measured in the same
 *     PoC. But this is the difference between a merge that fits a 1-vCPU /
 *     1-GiB job and one that does not.
 *
 *  2. EVERY TABLE CARRIES TWO TECHNICAL COLUMNS (phase 2, B2), behind the
 *     platform's underscore firewall so no prompt, profile or UI ever shows
 *     them: `_clarion_synced_at` (when a sync last wrote the row) and
 *     `_clarion_deleted`. Rows are never removed by a merge; a full re-sync
 *     marks what it did not see (`finalizeFullSync`) and a reconcile marks
 *     what the source no longer lists (`reconcileKeys`). The read side hides
 *     deleted rows by default (backend `createScanView`). A legacy file
 *     without the columns gains them on its next write; its rows read as
 *     alive with an unknown stamp — exactly what is known about them.
 */

import { createGuardedDuckDb } from './duckdbGuardrails';
import type { Database } from 'duckdb-async';

export const SYNCED_AT_COL = '_clarion_synced_at';
export const DELETED_COL = '_clarion_deleted';
export const TECHNICAL_COLUMNS = [SYNCED_AT_COL, DELETED_COL] as const;

export type ColumnSchema = ReadonlyArray<{ name: string; sqlType: string }>;

// ─── Identifier allow-lists ───────────────────────────────────────────────
/** Defence-in-depth on table names: a safe ASCII subset, no path traversal. */
export function isSafeTableName(name: string): boolean {
  return /^[A-Za-z0-9_\-]+$/.test(name) && name.length <= 128 && !name.startsWith('-');
}

/** Column identifiers that may be interpolated (quoted) into SQL. */
export function isSafeColumnName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 128;
}

/** DuckDB primitive types a connector may declare; anything else → VARCHAR. */
export function isSafeSqlType(t: string): boolean {
  return /^(VARCHAR|BIGINT|INTEGER|SMALLINT|TINYINT|DOUBLE|REAL|DECIMAL\(\d+,\d+\)|BOOLEAN|DATE|TIMESTAMP|TIMESTAMPTZ|UUID|BLOB)$/.test(t);
}

const esc = (p: string) => p.replace(/'/g, "''");
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

// ─── Reading the delta ────────────────────────────────────────────────────
/**
 * `read_json(...)` over an NDJSON staging file. With `columns` DuckDB uses
 * the declared schema (stable types, NULL-fills missing keys, ignores
 * extras) instead of sampling via `auto_detect`.
 */
export function readJsonExpr(escNdPath: string, columns?: ColumnSchema): string {
  if (columns && columns.length > 0) {
    const struct = columns
      .filter((c) => isSafeColumnName(c.name) && isSafeSqlType(c.sqlType))
      .map((c) => `'${c.name}': '${c.sqlType}'`)
      .join(', ');
    if (struct.length > 0) {
      return `read_json('${escNdPath}', format='newline_delimited', columns={${struct}})`;
    }
  }
  return `read_json('${escNdPath}', format='newline_delimited', auto_detect=true)`;
}

/** The delta with this sync's stamp: every row it carries is alive as of now. */
function stampedDelta(deltaExpr: string): string {
  return `SELECT d.*, now()::TIMESTAMPTZ AS ${q(SYNCED_AT_COL)}, false AS ${q(DELETED_COL)} FROM (SELECT * FROM ${deltaExpr}) d`;
}

async function describeColumns(db: Database, escParquet: string): Promise<Array<{ column_name: string; column_type: string }>> {
  return await db.all(`DESCRIBE SELECT * FROM read_parquet('${escParquet}')`) as Array<{ column_name: string; column_type: string }>;
}

// ─── Overwrite ────────────────────────────────────────────────────────────
export async function convertNdjsonToParquet(ndjsonPath: string, parquetPath: string, columns?: ColumnSchema): Promise<void> {
  const db = await createGuardedDuckDb();
  try {
    await db.all(`
      COPY (${stampedDelta(readJsonExpr(esc(ndjsonPath), columns))})
      TO '${esc(parquetPath)}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

// ─── Merge ────────────────────────────────────────────────────────────────
/**
 * Upsert the NDJSON delta into `existingParquetPath` (a LOCAL, exclusively
 * owned file), writing the result to `outPath`. Delta wins on a key; keys
 * only in existing are kept (and keep their deleted flag); keys only in the
 * delta are appended. A key that reappears in the delta after being marked
 * deleted comes back alive — the delta is the source's word.
 */
export async function mergeNdjsonIntoExistingParquet(
  ndjsonPath: string,
  existingParquetPath: string,
  outPath: string,
  mergeKey: string,
  columns?: ColumnSchema,
): Promise<void> {
  const db = await createGuardedDuckDb();
  try {
    const escNd = esc(ndjsonPath);
    const escEx = esc(existingParquetPath);
    const key = q(mergeKey);
    const deltaExpr = readJsonExpr(escNd, columns);

    // Merge-by-key with NULL keys would silently accumulate one duplicate
    // per sync (every NULL is its own partition / never matches the
    // anti-join). Fail loudly instead.
    const nullCheck = await db.all(`SELECT COUNT(*) AS n FROM ${deltaExpr} WHERE ${key} IS NULL`) as Array<{ n: number | bigint }>;
    const nullCount = Number(nullCheck[0]?.n ?? 0);
    if (nullCount > 0) {
      throw new Error(
        `Merge refused: ${nullCount} delta row(s) have NULL in business-key column '${mergeKey}'. ` +
        `Merging with NULL keys would silently produce duplicates on every sync. ` +
        `Either fix the source so the key is always populated, or remove businessKey from the entity ` +
        `descriptor to opt into full-table overwrite semantics.`,
      );
    }

    // With an explicit schema, CAST the existing side to the declared types
    // so a column mistyped by auto-detect in the past converges instead of
    // winning the UNION-BY-NAME coercion forever. CAST, not TRY_CAST: an
    // unconvertible legacy value should fail this entity loudly.
    let existingExpr = `SELECT * FROM read_parquet('${escEx}')`;
    if (columns && columns.length > 0) {
      const typeByName = new Map(
        columns.filter((c) => isSafeColumnName(c.name) && isSafeSqlType(c.sqlType)).map((c) => [c.name, c.sqlType] as const),
      );
      const selectList = (await describeColumns(db, escEx))
        .filter((c) => isSafeColumnName(c.column_name))
        .map((c) => {
          const target = typeByName.get(c.column_name);
          return target && target !== c.column_type ? `CAST(${q(c.column_name)} AS ${target}) AS ${q(c.column_name)}` : q(c.column_name);
        })
        .join(', ');
      if (selectList.length > 0) existingExpr = `SELECT ${selectList} FROM read_parquet('${escEx}')`;
    }

    // `delta` keeps the LAST occurrence of a key within the batch (a row
    // updated twice between two pages) — the window runs over the delta
    // only, which is small. `existing` rows are then anti-joined against
    // it: the hash table is built from the delta, memory is O(delta).
    await db.all(`
      COPY (
        WITH delta_raw AS (
          SELECT *, row_number() OVER () AS _clarion_ord FROM (${stampedDelta(deltaExpr)})
        ),
        delta AS (
          SELECT * EXCLUDE (_clarion_ord) FROM delta_raw
          QUALIFY row_number() OVER (PARTITION BY ${key} ORDER BY _clarion_ord DESC) = 1
        ),
        existing AS (
          ${existingExpr}
        ),
        merged AS (
          SELECT * FROM existing e WHERE NOT EXISTS (SELECT 1 FROM delta d WHERE d.${key} = e.${key})
          UNION ALL BY NAME
          SELECT * FROM delta
        )
        SELECT * REPLACE (COALESCE(${q(DELETED_COL)}, false) AS ${q(DELETED_COL)}) FROM merged
      )
      TO '${esc(outPath)}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

// ─── Soft delete: full re-sync ────────────────────────────────────────────
/**
 * Mark every row whose `_clarion_synced_at` is older than `syncStartedAt`,
 * or absent, as deleted. A full re-sync merged everything the source holds
 * with a fresh stamp first, so an unstamped row is precisely one the source
 * no longer has. Returns the rows newly marked and the alive rows left.
 */
export async function finalizeFullSyncFile(
  existingParquetPath: string,
  outPath: string,
  syncStartedAt: string,
): Promise<{ tombstoned: number; rowsTotal: number }> {
  if (Number.isNaN(Date.parse(syncStartedAt))) throw new Error(`finalizeFullSync: syncStartedAt is not a timestamp: ${syncStartedAt}`);
  const db = await createGuardedDuckDb();
  try {
    const escEx = esc(existingParquetPath);
    const cols = new Set((await describeColumns(db, escEx)).map((c) => c.column_name));
    const hasTech = cols.has(SYNCED_AT_COL) && cols.has(DELETED_COL);
    const ts = `TIMESTAMPTZ '${esc(new Date(syncStartedAt).toISOString())}'`;
    const before = hasTech
      ? Number((await db.all(`SELECT COUNT(*) FILTER (WHERE COALESCE(${q(DELETED_COL)}, false)) AS n FROM read_parquet('${escEx}')`) as Array<{ n: number | bigint }>)[0].n)
      : 0;
    const select = hasTech
      ? `SELECT * REPLACE (
           CASE WHEN ${q(SYNCED_AT_COL)} IS NULL OR ${q(SYNCED_AT_COL)} < ${ts} THEN true
                ELSE COALESCE(${q(DELETED_COL)}, false) END AS ${q(DELETED_COL)})
         FROM read_parquet('${escEx}')`
      // A file that never carried the columns: nothing in it was written by
      // this run, so everything it holds is what the source no longer has.
      : `SELECT *, NULL::TIMESTAMPTZ AS ${q(SYNCED_AT_COL)}, true AS ${q(DELETED_COL)} FROM read_parquet('${escEx}')`;
    await db.all(`COPY (${select}) TO '${esc(outPath)}' (FORMAT 'parquet', COMPRESSION 'snappy')`);
    const after = await db.all(
      `SELECT COUNT(*) FILTER (WHERE COALESCE(${q(DELETED_COL)}, false)) AS del, COUNT(*) FILTER (WHERE NOT COALESCE(${q(DELETED_COL)}, false)) AS alive FROM read_parquet('${esc(outPath)}')`,
    ) as Array<{ del: number | bigint; alive: number | bigint }>;
    return { tombstoned: Number(after[0].del) - before, rowsTotal: Number(after[0].alive) };
  } finally {
    await db.close();
  }
}

// ─── Soft delete: reconcile against the source's key list ─────────────────
/**
 * Given an NDJSON file of `{"k": <key>}` lines — the keys the source lists
 * today — mark absent keys deleted and revive present ones. Content and
 * stamps are untouched. REFUSES an empty key list over a non-empty table:
 * a throttled endpoint that answers nothing must not tombstone a whole
 * table (the same rule the empty-batch write follows).
 */
export async function reconcileKeysFile(
  existingParquetPath: string,
  outPath: string,
  keyColumn: string,
  keysNdjsonPath: string,
): Promise<{ tombstoned: number; revived: number; rowsTotal: number; refusedEmpty?: boolean }> {
  const db = await createGuardedDuckDb();
  try {
    const escEx = esc(existingParquetPath);
    const escKeys = esc(keysNdjsonPath);
    const key = q(keyColumn);
    const described = await describeColumns(db, escEx);
    const keyType = described.find((c) => c.column_name === keyColumn)?.column_type;
    if (!keyType) throw new Error(`reconcileKeys: column '${keyColumn}' is not on the table`);
    const hasTech = described.some((c) => c.column_name === DELETED_COL) && described.some((c) => c.column_name === SYNCED_AT_COL);
    const safeType = isSafeSqlType(keyType) ? keyType : 'VARCHAR';
    const keysExpr = `(SELECT DISTINCT CAST(k AS ${safeType}) AS k FROM read_json('${escKeys}', format='newline_delimited', columns={'k': 'VARCHAR'}) WHERE k IS NOT NULL)`;

    const keyCount = Number((await db.all(`SELECT COUNT(*) AS n FROM ${keysExpr}`) as Array<{ n: number | bigint }>)[0].n);
    const rowCount = Number((await db.all(`SELECT COUNT(*) AS n FROM read_parquet('${escEx}')`) as Array<{ n: number | bigint }>)[0].n);
    if (keyCount === 0 && rowCount > 0) {
      const alive = hasTech
        ? Number((await db.all(`SELECT COUNT(*) FILTER (WHERE NOT COALESCE(${q(DELETED_COL)}, false)) AS n FROM read_parquet('${escEx}')`) as Array<{ n: number | bigint }>)[0].n)
        : rowCount;
      return { tombstoned: 0, revived: 0, rowsTotal: alive, refusedEmpty: true };
    }

    const deletedExpr = hasTech ? `COALESCE(e.${q(DELETED_COL)}, false)` : 'false';
    const counts = await db.all(`
      SELECT
        COUNT(*) FILTER (WHERE NOT ${deletedExpr} AND k.k IS NULL)     AS tomb,
        COUNT(*) FILTER (WHERE ${deletedExpr} AND k.k IS NOT NULL)     AS revived,
        COUNT(*) FILTER (WHERE k.k IS NOT NULL)                        AS alive
      FROM read_parquet('${escEx}') e LEFT JOIN ${keysExpr} k ON k.k = e.${key}
    `) as Array<{ tomb: number | bigint; revived: number | bigint; alive: number | bigint }>;

    const projection = hasTech
      ? `e.* REPLACE ((k.k IS NULL) AS ${q(DELETED_COL)})`
      : `e.*, NULL::TIMESTAMPTZ AS ${q(SYNCED_AT_COL)}, (k.k IS NULL) AS ${q(DELETED_COL)}`;
    await db.all(`
      COPY (SELECT ${projection} FROM read_parquet('${escEx}') e LEFT JOIN ${keysExpr} k ON k.k = e.${key})
      TO '${esc(outPath)}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
    return { tombstoned: Number(counts[0].tomb), revived: Number(counts[0].revived), rowsTotal: Number(counts[0].alive) };
  } finally {
    await db.close();
  }
}

// ─── Counting ─────────────────────────────────────────────────────────────
/** Rows the file holds that are not soft-deleted (the catalog's row count). */
export async function countAliveRows(parquetPath: string): Promise<number> {
  const db = await createGuardedDuckDb();
  try {
    const escEx = esc(parquetPath);
    const cols = new Set((await describeColumns(db, escEx)).map((c) => c.column_name));
    if (cols.has('_placeholder') && cols.size === 1) return 0;
    const sql = cols.has(DELETED_COL)
      ? `SELECT COUNT(*) FILTER (WHERE NOT COALESCE(${q(DELETED_COL)}, false)) AS n FROM read_parquet('${escEx}')`
      : `SELECT COUNT(*) AS n FROM read_parquet('${escEx}')`;
    return Number((await db.all(sql) as Array<{ n: number | bigint }>)[0].n);
  } finally {
    await db.close();
  }
}

// ─── Empty tables ─────────────────────────────────────────────────────────
export async function writeEmptyParquet(parquetPath: string): Promise<void> {
  const db = await createGuardedDuckDb();
  try {
    await db.all(`
      COPY (SELECT NULL::VARCHAR AS _placeholder WHERE FALSE)
      TO '${esc(parquetPath)}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

/**
 * An empty parquet with the caller-supplied schema (plus the technical
 * columns), so the catalog can show what the table WOULD contain. Names and
 * types are allow-listed before interpolation; anything else falls back to
 * VARCHAR / a positional alias.
 */
export async function writeEmptyParquetWithSchema(parquetPath: string, schema: ColumnSchema): Promise<void> {
  const db = await createGuardedDuckDb();
  try {
    const projections = schema
      .filter((col) => !(TECHNICAL_COLUMNS as readonly string[]).includes(col.name))
      .map((col, i) => {
        const safeName = isSafeColumnName(col.name) ? col.name : `col_${i}`;
        const safeType = isSafeSqlType(col.sqlType) ? col.sqlType : 'VARCHAR';
        return `NULL::${safeType} AS ${q(safeName)}`;
      });
    projections.push(`NULL::TIMESTAMPTZ AS ${q(SYNCED_AT_COL)}`, `NULL::BOOLEAN AS ${q(DELETED_COL)}`);
    await db.all(`
      COPY (SELECT ${projections.join(', ')} WHERE FALSE)
      TO '${esc(parquetPath)}' (FORMAT 'parquet', COMPRESSION 'snappy')
    `);
  } finally {
    await db.close();
  }
}

// ─── Row serialisation ────────────────────────────────────────────────────
/** One NDJSON line per row: `undefined` keys dropped, non-finite numbers → null. */
export function jsonLine(row: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) cleaned[k] = null;
    else cleaned[k] = v;
  }
  return `${JSON.stringify(cleaned)}\n`;
}
