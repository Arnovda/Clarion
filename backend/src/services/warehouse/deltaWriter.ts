/**
 * Delta + Python-sidecar writer for product tables.
 *
 * Pairs Node DuckDB (executes the AI-generated transformation SQL) with
 * the Python sidecar (`etl/scd2/commit_table.py`) that owns the Delta
 * commit:
 *
 *   1. DuckDB writes the transformation result to a tmp parquet — WITH the
 *      per-row `_row_hash`, computed here in SQL over the business columns.
 *   2. DuckDB counts what changed against the table's previous state
 *      (business key + hash on both sides, a FULL OUTER JOIN under the
 *      session's memory limit, spilling to `temp_directory` when it must).
 *   3. The sidecar streams the parquet into a Delta commit — never holding
 *      the table — and returns the write's shape.
 *   4. Node persists counts + outcome in `product_table_refresh_history`
 *      for the per-table change-evolution chart.
 *
 * THE DIVISION OF LABOUR IS THE POINT (2026-09-10). Until this rewrite
 * the sidecar loaded the existing table AND the new state into pandas,
 * hashed every row through a Python lambda and outer-merged the frames
 * for the counts: two full copies of a fact table inside a 1 GiB
 * jobs-worker, the same failure class phase 2 closed on the source side.
 * Everything that is proportional to the table now runs where a memory
 * ceiling exists — DuckDB (`applyResourceGuardrails`) — and the sidecar
 * only ever holds one batch. Measured on the PoC's 3M-row table:
 * delta-rs' own MERGE peaked at 1.9 GB even for a 10k-row delta and at
 * 4.3 GB for a full-table merge, which is why the counts are NOT computed
 * by delta-rs and the write is an overwrite, not a merge (see the
 * ingestion-chain assessment §9).
 *
 * Feature flagging: `STORAGE_FORMAT=parquet` keeps the legacy parquet
 * path; anything else (including unset) is Delta.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { Database } from 'duckdb-async';

import { createScanView } from './views';
import { tenantQuery } from '../tenantQuery';
import { logger } from '../../utils/logger';

const log = logger.child({ component: 'deltaWriter' });

/** Default sidecar timeout — 15 min. SMB-scale refreshes complete in seconds;
 *  the headroom protects against pathological Azure latency without leaving
 *  stuck processes around indefinitely. */
const SIDECAR_TIMEOUT_MS = 15 * 60 * 1000;
/** Maintenance walks every product table of every tenant in one run. */
const MAINTAIN_TIMEOUT_MS = 60 * 60 * 1000;

/** Parquet row groups the sidecar reads one at a time; small groups keep the
 *  reader's footprint small (a DuckDB default group is 122,880 rows). */
const TMP_PARQUET_ROW_GROUP = 16_384;

export const ROW_HASH_COL = '_row_hash';
/** The hash of a row with no business columns to hash — every row identical,
 *  which is the honest reading when rows cannot be told apart. Mirrors the
 *  sidecar's `NO_BUSINESS_COLUMNS_HASH`. */
export const NO_BUSINESS_COLUMNS_HASH = 'no-business-columns';

export interface DeltaWriteResult {
  status: 'ok' | 'failed';
  error?: string;
  firstRun?: boolean;
  rowsUnchanged: number;
  rowsUpdated: number;
  rowsInserted: number;
  rowsDeleted: number;
  rowsTotal: number;
  /** The refresh produced zero rows over a table that already had some, so
   *  the existing data was kept. Not an error — see the sidecar's write
   *  step — but the caller must not report it as "refreshed to 0 rows". */
  preservedExisting?: boolean;
  /** How the sidecar wrote: `overwrite`, `preserved`, `emptied`. */
  writeMode?: string;
}

export interface ChangeCounts {
  rows_unchanged: number;
  rows_updated: number;
  rows_inserted: number;
  rows_deleted: number;
  rows_total: number;
}

interface SidecarConfig {
  mode: 'scd1';
  delta_path: string;
  new_state_parquet: string;
  business_key_columns: string[];
  business_columns: string[];
  storage_options?: Record<string, string>;
  /** Explicit "this table really should end up empty". Without it a zero-row
   *  result over a non-empty table preserves what is there, matching the
   *  source writers' contract. */
  allow_empty?: boolean;
  target_file_size?: number;
  /** Counts Node computed against the previous state; absent on a first run
   *  or an unkeyed table, where the sidecar reports "all inserted". */
  counts?: ChangeCounts;
}

interface MaintainConfig {
  mode: 'maintain';
  delta_paths: string[];
  target_file_size?: number;
  retention_hours?: number;
  storage_options?: Record<string, string>;
}

interface SidecarResult {
  status: 'ok' | 'failed';
  error?: string;
  first_run?: boolean;
  rows_unchanged?: number;
  rows_updated?: number;
  rows_inserted?: number;
  rows_deleted?: number;
  rows_total?: number;
  preserved_existing?: boolean;
  legacy_cleanup?: string;
  write_mode?: string;
}

export interface MaintainTableResult {
  delta_path: string;
  skipped?: string;
  error?: string;
  files_before?: number;
  files_after?: number;
  compact?: { numFilesAdded?: number; numFilesRemoved?: number; totalConsideredFiles?: number };
  vacuum_files_removed?: number;
}

interface MaintainResult {
  status: 'ok' | 'failed';
  error?: string;
  results?: MaintainTableResult[];
}

/**
 * Returns true when product transformations should write Delta + run
 * the Python sidecar. Delta is the DEFAULT — the production image bakes
 * the Python venv + sidecar in. The only escape hatch is
 * `STORAGE_FORMAT=parquet`; any other value is treated as Delta too, so a
 * typo doesn't silently downgrade.
 */
export function isDeltaStorageEnabled(): boolean {
  return process.env.STORAGE_FORMAT !== 'parquet';
}

/** `DELTA_TARGET_FILE_SIZE_MB` (default 64): the data-file size delta-rs aims
 *  for. Smaller files make a future partial rewrite touch less; larger files
 *  read faster. 64 MB is delta-rs' recommended middle for tables this size. */
export function deltaTargetFileSizeBytes(): number {
  const mb = Number(process.env.DELTA_TARGET_FILE_SIZE_MB ?? '64');
  return (Number.isFinite(mb) && mb >= 1 ? mb : 64) * 1024 * 1024;
}

/** `DELTA_VACUUM_RETENTION_HOURS` (default 168): how long a superseded data
 *  file stays on storage for time travel before the weekly vacuum drops it.
 *  delta-rs refuses anything under its own 7-day minimum unless enforcement
 *  is switched off, which this deliberately never does. */
export function deltaVacuumRetentionHours(): number {
  const h = Number(process.env.DELTA_VACUUM_RETENTION_HOURS ?? '168');
  return Number.isFinite(h) && h >= 0 ? h : 168;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * The `_row_hash` expression: md5 over the business columns the result
 * actually carries, joined with the ASCII unit separator, NULL spelled
 * 'NULL' so an empty string stays distinguishable from a missing value.
 * Columns declared in `product_columns` but absent from the SELECT are
 * skipped (a catalog column the transformation renamed or dropped); with
 * none present every row gets the same placeholder hash.
 */
export function rowHashExpression(businessColumns: readonly string[], presentColumns: readonly string[]): string {
  const present = new Set(presentColumns);
  const cols = businessColumns.filter((c) => present.has(c) && c !== ROW_HASH_COL);
  if (cols.length === 0) return `'${NO_BUSINESS_COLUMNS_HASH}'`;
  const parts = cols.map((c) => `COALESCE(CAST(${q(c)} AS VARCHAR), 'NULL')`).join(', ');
  return `md5(concat_ws(chr(31), ${parts}))`;
}

async function describeSelect(db: Database, selectSql: string): Promise<string[]> {
  const rows = await db.all(`DESCRIBE ${selectSql}`) as Array<{ column_name: string }>;
  return rows.map((r) => r.column_name);
}

/**
 * Change counts of `selectSql` (the new state, hash included) against the
 * table at `deltaUri`, keyed on the business key. Returns null when the
 * previous state cannot be read — a first run, or a path that is not yet a
 * table — so the caller reports "all inserted" instead of guessing.
 *
 * The previous state is read through `createScanView`: the same door every
 * other read uses, and the one the warehouse-scan ratchet allows. The join
 * runs under the session's memory limit and spills; it never holds more
 * than the key + hash of each side.
 */
export async function countChangesAgainstPrevious(
  db: Database,
  deltaUri: string,
  selectSql: string,
  businessKeyColumns: readonly string[],
): Promise<ChangeCounts | null> {
  if (businessKeyColumns.length === 0) return null;
  const view = `__prev_${randomUUID().replace(/-/g, '')}`;
  try {
    await createScanView(db, view, deltaUri);
  } catch {
    return null;
  }
  try {
    const prevCols = new Set(await describeSelect(db, `SELECT * FROM ${q(view)}`));
    if (!prevCols.has(ROW_HASH_COL) || businessKeyColumns.some((k) => !prevCols.has(k))) return null;
    const keys = businessKeyColumns.map(q).join(', ');
    const joinOn = businessKeyColumns.map((k) => `e.${q(k)} IS NOT DISTINCT FROM n.${q(k)}`).join(' AND ');
    const rows = await db.all(`
      WITH e AS (SELECT ${keys}, ${q(ROW_HASH_COL)} AS h_old FROM ${q(view)}),
           n AS (SELECT ${keys}, ${q(ROW_HASH_COL)} AS h_new FROM (${selectSql}))
      SELECT
        COUNT(*) FILTER (WHERE h_old IS NULL AND h_new IS NOT NULL)                       AS ins,
        COUNT(*) FILTER (WHERE h_old IS NOT NULL AND h_new IS NULL)                       AS del,
        COUNT(*) FILTER (WHERE h_old IS NOT NULL AND h_new IS NOT NULL AND h_old <> h_new) AS upd,
        COUNT(*) FILTER (WHERE h_old IS NOT NULL AND h_new IS NOT NULL AND h_old = h_new)  AS same,
        (SELECT COUNT(*) FROM n)                                                            AS total
      FROM e FULL OUTER JOIN n ON ${joinOn}
    `) as Array<{ ins: number | bigint; del: number | bigint; upd: number | bigint; same: number | bigint; total: number | bigint }>;
    const r = rows[0];
    return {
      rows_unchanged: Number(r.same),
      rows_updated: Number(r.upd),
      rows_inserted: Number(r.ins),
      rows_deleted: Number(r.del),
      rows_total: Number(r.total),
    };
  } finally {
    await db.exec(`DROP VIEW IF EXISTS ${q(view)};`).catch(() => undefined);
  }
}

/** Rows of `selectSql` whose business key repeats — a merge could not tell
 *  them apart, and a diff on them would count wrong. */
export async function duplicateKeyRows(db: Database, selectSql: string, businessKeyColumns: readonly string[]): Promise<number> {
  if (businessKeyColumns.length === 0) return 0;
  const keys = businessKeyColumns.map(q).join(', ');
  const rows = await db.all(`
    SELECT COALESCE(SUM(n - 1), 0) AS dup FROM (SELECT ${keys}, COUNT(*) AS n FROM (${selectSql}) GROUP BY ALL HAVING COUNT(*) > 1)
  `) as Array<{ dup: number | bigint }>;
  return Number(rows[0]?.dup ?? 0);
}

/**
 * Run the transformation SQL via DuckDB → tmp parquet → sidecar → Delta.
 * Persists a row in `product_table_refresh_history` for chart consumption.
 *
 * The refresh-history insert runs in its own tenant-scoped transaction
 * (`tenantQuery(opts.tenantId, …)`) — callers set no session-level context.
 */
export async function writeDeltaWithSidecar(opts: {
  db: Database;
  /** Final Delta destination URI (`az://...` or local path). */
  deltaUri: string;
  /** A SQL expression that produces rows. Wrapped in parens internally. */
  selectSql: string;
  productTableId: number;
  tenantId: number;
  /** Columns that identify a row across refreshes. Empty = no change
   *  tracking; counts come back as "all inserted". */
  businessKeyColumns: string[];
  /** All business columns (excluding technical `_row_hash`, etc.). Hashed
   *  in the same order on both sides of the diff. */
  businessColumns: string[];
  /** Opt in to emptying the table when the transformation returns no rows.
   *  Default (absent) preserves the existing rows — a source that answers
   *  empty for one run must not wipe a topic. */
  allowEmpty?: boolean;
}): Promise<DeltaWriteResult> {
  const refreshStartedAt = new Date();
  const startedMs = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-scd1-'));
  const tmpParquet = path.join(tmpDir, `${randomUUID()}.parquet`).replace(/\\/g, '/');

  let result: DeltaWriteResult;
  try {
    // 1. The new state, hash included, as one SELECT DuckDB can both copy
    //    and join. Duplicate business keys mean the key does not identify a
    //    row: the diff is skipped and the chart reads "all inserted", which
    //    is what is true.
    const presentColumns = await describeSelect(opts.db, `(${opts.selectSql})`);
    const hashExpr = rowHashExpression(opts.businessColumns, presentColumns);
    const newState = `SELECT *, ${hashExpr} AS ${q(ROW_HASH_COL)} FROM (${opts.selectSql})`;

    let keyColumns = opts.businessKeyColumns.filter((k) => presentColumns.includes(k));
    if (keyColumns.length > 0) {
      const dup = await duplicateKeyRows(opts.db, opts.selectSql, keyColumns);
      if (dup > 0) {
        log.warn(
          { productTableId: opts.productTableId, keyColumns, duplicateRows: dup },
          'business key repeats in the transformation result — change counts unavailable for this refresh',
        );
        keyColumns = [];
      }
    }

    // 2. Counts against the previous state, BEFORE the write replaces it.
    const counts = await countChangesAgainstPrevious(opts.db, opts.deltaUri, newState, keyColumns);

    // 3. The parquet the sidecar streams.
    const escaped = tmpParquet.replace(/'/g, "''");
    await opts.db.exec(`COPY (${newState}) TO '${escaped}' (FORMAT PARQUET, ROW_GROUP_SIZE ${TMP_PARQUET_ROW_GROUP});`);

    // 4. Sidecar
    const sidecarResult = await spawnSidecar<SidecarResult>({
      mode: 'scd1',
      delta_path: opts.deltaUri,
      new_state_parquet: tmpParquet,
      business_key_columns: keyColumns,
      business_columns: opts.businessColumns,
      allow_empty: opts.allowEmpty === true,
      target_file_size: deltaTargetFileSizeBytes(),
      ...(counts ? { counts } : {}),
    }, SIDECAR_TIMEOUT_MS);

    if (sidecarResult.status !== 'ok') {
      result = failed(sidecarResult.error ?? 'unknown sidecar error');
    } else {
      result = {
        status: 'ok',
        firstRun: sidecarResult.first_run,
        rowsUnchanged: sidecarResult.rows_unchanged ?? 0,
        rowsUpdated: sidecarResult.rows_updated ?? 0,
        rowsInserted: sidecarResult.rows_inserted ?? 0,
        rowsDeleted: sidecarResult.rows_deleted ?? 0,
        rowsTotal: sidecarResult.rows_total ?? 0,
        preservedExisting: sidecarResult.preserved_existing === true,
        writeMode: sidecarResult.write_mode,
      };
      // LOAD-BEARING LOG LINE: `.ops/prod-logs` keys `delta-write` on
      // 'delta write complete'. Reword it there too, or the reader goes
      // blind on the one signal that says the rewritten sidecar runs.
      log.info(
        {
          productTableId: opts.productTableId,
          writeMode: result.writeMode,
          firstRun: result.firstRun === true,
          rowsTotal: result.rowsTotal,
          rowsUpdated: result.rowsUpdated,
          rowsInserted: result.rowsInserted,
          rowsDeleted: result.rowsDeleted,
          countsMeasured: counts !== null,
          durationMs: Date.now() - startedMs,
        },
        'delta write complete',
      );
      if (result.preservedExisting) {
        log.warn(
          { productTableId: opts.productTableId, rowsKept: result.rowsTotal },
          'transformation returned zero rows — kept the existing table instead of emptying it',
        );
      }
      if (sidecarResult.legacy_cleanup) {
        log.info(
          { productTableId: opts.productTableId, action: sidecarResult.legacy_cleanup },
          'sidecar cleaned up legacy parquet on first Delta commit',
        );
      }
    }
  } catch (err) {
    result = failed(err instanceof Error ? err.message : String(err));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 5. Persist the refresh row regardless of outcome — failed rows show
  //    up on the chart as red markers so users see "something tried" rather
  //    than silent gaps.
  await recordRefreshHistory({
    tenantId: opts.tenantId,
    productTableId: opts.productTableId,
    refreshStartedAt,
    result,
  }).catch((e) => {
    log.warn({ err: e, productTableId: opts.productTableId }, 'failed to record refresh history (non-fatal)');
  });

  if (result.status !== 'ok') {
    throw new Error(`Delta sidecar failed: ${result.error}`);
  }
  return result;
}

function failed(error: string): DeltaWriteResult {
  return { status: 'failed', error, rowsUnchanged: 0, rowsUpdated: 0, rowsInserted: 0, rowsDeleted: 0, rowsTotal: 0 };
}

/**
 * OPTIMIZE + VACUUM the listed Delta tables through the sidecar's `maintain`
 * mode. A path that is not a Delta table comes back `skipped`, not failed:
 * the caller enumerates catalog rows and a legacy parquet directory is a
 * legitimate thing to find there.
 */
export async function maintainDeltaTables(deltaPaths: string[]): Promise<MaintainTableResult[]> {
  if (deltaPaths.length === 0) return [];
  const res = await spawnSidecar<MaintainResult>({
    mode: 'maintain',
    delta_paths: deltaPaths,
    target_file_size: deltaTargetFileSizeBytes(),
    retention_hours: deltaVacuumRetentionHours(),
  }, MAINTAIN_TIMEOUT_MS);
  if (res.status !== 'ok') throw new Error(`Delta maintenance sidecar failed: ${res.error ?? 'unknown error'}`);
  return res.results ?? [];
}

function sidecarPath(): string {
  return process.env.SCD2_SIDECAR_PATH
    ?? path.resolve(__dirname, '../../../../etl/scd2/commit_table.py');
}

/**
 * Spawn the Python sidecar with the given config. Returns the parsed JSON
 * result on success, throws on hard failure (timeout, non-zero exit,
 * unparseable output).
 */
async function spawnSidecar<T extends { status: string }>(cfg: SidecarConfig | MaintainConfig, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const pythonBin = process.env.PYTHON_BIN ?? 'python3';

    const proc = spawn(pythonBin, [sidecarPath()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      // SIGKILL — SIGTERM may not break a stuck Azure write
      proc.kill('SIGKILL');
      reject(new Error(`sidecar timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`sidecar spawn error: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stderr.trim().length > 0) log.warn({ sidecarStderr: stderr.slice(0, 2000) }, 'sidecar wrote to stderr');
      if (code !== 0) {
        reject(new Error(`sidecar exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`sidecar output not parseable: ${stdout.slice(0, 500)}`));
      }
    });

    try {
      proc.stdin.write(JSON.stringify(cfg));
      proc.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Insert a row into product_table_refresh_history. */
async function recordRefreshHistory(opts: {
  tenantId: number;
  productTableId: number;
  refreshStartedAt: Date;
  result: DeltaWriteResult;
}): Promise<void> {
  await tenantQuery(opts.tenantId, (db) => db('product_table_refresh_history').insert({
    tenant_id: opts.tenantId,
    product_table_id: opts.productTableId,
    refresh_started_at: opts.refreshStartedAt.toISOString(),
    refresh_completed_at: new Date().toISOString(),
    status: opts.result.status,
    rows_unchanged: opts.result.rowsUnchanged,
    rows_updated: opts.result.rowsUpdated,
    rows_inserted: opts.result.rowsInserted,
    rows_deleted: opts.result.rowsDeleted,
    rows_total: opts.result.rowsTotal,
    error_message: opts.result.error ?? null,
    storage_format: 'delta_v1',
  }));
}

/**
 * Sanity check helper — used by transformationRunner to confirm the
 * sidecar script is reachable before starting a long transformation. If
 * we're going to fail, we'd rather fail fast (before running the AI
 * transformation SQL) than after.
 */
export function isSidecarReachable(): boolean {
  return fs.existsSync(sidecarPath());
}
