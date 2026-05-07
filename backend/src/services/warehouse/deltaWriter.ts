/**
 * Delta + Python-sidecar writer for product tables.
 *
 * Pairs Node DuckDB (executes the AI-generated transformation SQL) with
 * a Python sidecar (`etl/scd2/commit_table.py`) that owns the Delta
 * commit:
 *
 *   1. DuckDB writes the transformation result to a tmp parquet
 *   2. Sidecar reads that parquet + the existing Delta table
 *   3. Sidecar computes `_row_hash` per row + diffs on business key
 *   4. Sidecar writes the new state to Delta with schema evolution
 *   5. Sidecar returns counts (unchanged / updated / inserted / deleted)
 *   6. Node persists the counts in `product_table_refresh_history` for
 *      the per-table change-evolution chart on /products/[id]
 *
 * Why a Python sidecar at all: deltalake-rs (via the Python `deltalake`
 * package) handles ACID Delta commits, schema evolution, and time travel
 * natively. DuckDB's Delta WRITE support is improving but not at parity.
 * The sidecar is ~150 lines of Python; the architectural seam is small
 * and pays for itself when SCD2 lands (same sidecar, different mode flag).
 *
 * Feature flagging: gated on `STORAGE_FORMAT=delta_v1`. When unset (or
 * any value other than `delta_v1`), `transformationRunner` keeps using
 * the legacy parquet path. Lets us roll out tenant-by-tenant if needed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { Database } from 'duckdb-async';

import { isAzurePath, sqlEscapePath } from './paths';
import { semanticDb } from '../../db/knex';
import { logger } from '../../utils/logger';

const log = logger.child({ component: 'deltaWriter' });

/** Default sidecar timeout — 15 min per the user's call. SMB-scale dim
 *  refreshes complete in seconds; the headroom protects against pathological
 *  Azure latency without leaving stuck processes around indefinitely. */
const SIDECAR_TIMEOUT_MS = 15 * 60 * 1000;

export interface DeltaWriteResult {
  status: 'ok' | 'failed';
  error?: string;
  firstRun?: boolean;
  rowsUnchanged: number;
  rowsUpdated: number;
  rowsInserted: number;
  rowsDeleted: number;
  rowsTotal: number;
}

interface SidecarConfig {
  delta_path: string;
  new_state_parquet: string;
  business_key_columns: string[];
  business_columns: string[];
  mode: 'scd1';
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
}

/**
 * Returns true when the Delta-storage feature flag is on. Off by default
 * so existing tenants keep the parquet path until we're ready to flip.
 */
export function isDeltaStorageEnabled(): boolean {
  return process.env.STORAGE_FORMAT === 'delta_v1';
}

/**
 * Run the transformation SQL via DuckDB → tmp parquet → sidecar → Delta.
 * Persists a row in `product_table_refresh_history` for chart consumption.
 *
 * Caller is responsible for setting tenant context on the DB session
 * (`SET app.current_tenant = '<id>'`) before calling — the refresh-history
 * insert relies on RLS being correctly scoped.
 */
export async function writeDeltaWithSidecar(opts: {
  db: Database;
  /** Final Delta destination URI (`az://...` or local path). */
  deltaUri: string;
  /** A SQL expression that produces rows. Wrapped in parens internally. */
  selectSql: string;
  productTableId: number;
  tenantId: number;
  /** Columns the sidecar should treat as the business key for diffing.
   *  Empty array = no change tracking; counts come back as "all inserted". */
  businessKeyColumns: string[];
  /** All business columns (excluding technical `_row_hash`, etc.). Used
   *  to compute `_row_hash` over the same set on both sides of the diff. */
  businessColumns: string[];
}): Promise<DeltaWriteResult> {
  const refreshStartedAt = new Date();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-scd1-'));
  const tmpParquet = path.join(tmpDir, `${randomUUID()}.parquet`).replace(/\\/g, '/');

  let result: DeltaWriteResult;
  try {
    // 1. DuckDB → tmp parquet
    const escaped = tmpParquet.replace(/'/g, "''");
    await opts.db.exec(`COPY (${opts.selectSql}) TO '${escaped}' (FORMAT PARQUET);`);

    // 2. Sidecar
    const sidecarResult = await spawnSidecar({
      delta_path: opts.deltaUri,
      new_state_parquet: tmpParquet,
      business_key_columns: opts.businessKeyColumns,
      business_columns: opts.businessColumns,
      mode: 'scd1',
    });

    if (sidecarResult.status !== 'ok') {
      result = {
        status: 'failed',
        error: sidecarResult.error ?? 'unknown sidecar error',
        rowsUnchanged: 0,
        rowsUpdated: 0,
        rowsInserted: 0,
        rowsDeleted: 0,
        rowsTotal: 0,
      };
    } else {
      result = {
        status: 'ok',
        firstRun: sidecarResult.first_run,
        rowsUnchanged: sidecarResult.rows_unchanged ?? 0,
        rowsUpdated: sidecarResult.rows_updated ?? 0,
        rowsInserted: sidecarResult.rows_inserted ?? 0,
        rowsDeleted: sidecarResult.rows_deleted ?? 0,
        rowsTotal: sidecarResult.rows_total ?? 0,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      status: 'failed',
      error: msg,
      rowsUnchanged: 0,
      rowsUpdated: 0,
      rowsInserted: 0,
      rowsDeleted: 0,
      rowsTotal: 0,
    };
  } finally {
    // Always clean up tmp; if sidecar already consumed it, this is a no-op.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 3. Persist the refresh row regardless of outcome — failed rows show
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

/**
 * Spawn the Python sidecar with the given config. Returns the parsed JSON
 * result on success, throws on hard failure (timeout, non-zero exit,
 * unparseable output).
 */
async function spawnSidecar(cfg: SidecarConfig): Promise<SidecarResult> {
  return new Promise<SidecarResult>((resolve, reject) => {
    const pythonBin = process.env.PYTHON_BIN ?? 'python3';
    const sidecarPath = process.env.SCD2_SIDECAR_PATH
      ?? path.resolve(__dirname, '../../../../etl/scd2/commit_table.py');

    const proc = spawn(pythonBin, [sidecarPath], {
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
      reject(new Error(`sidecar timed out after ${SIDECAR_TIMEOUT_MS}ms`));
    }, SIDECAR_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`sidecar spawn error: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`sidecar exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as SidecarResult;
        resolve(parsed);
      } catch (e) {
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
  await semanticDb.raw(`SET app.current_tenant = '${Number(opts.tenantId)}'`);
  await semanticDb('product_table_refresh_history').insert({
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
  });
}

/**
 * Sanity check helper — used by transformationRunner to confirm the
 * sidecar binary is reachable before starting a long transformation. If
 * we're going to fail, we'd rather fail fast (before running the AI
 * transformation SQL) than after.
 */
export function isSidecarReachable(): boolean {
  if (!isDeltaStorageEnabled()) return false;
  const sidecarPath = process.env.SCD2_SIDECAR_PATH
    ?? path.resolve(__dirname, '../../../../etl/scd2/commit_table.py');
  return fs.existsSync(sidecarPath);
}

// Used in tests / integration: silence unused imports of `isAzurePath`
// + `sqlEscapePath` until the next iteration that uses them for storage
// option derivation on the Node side. Keeping the imports stops the
// editor from auto-removing them, since they'll be needed shortly.
void isAzurePath;
void sqlEscapePath;
