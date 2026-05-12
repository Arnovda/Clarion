'use client';

/**
 * Cube loader + per-widget query runner against DuckDB-WASM.
 *
 * Phase 5a contract:
 *   - `loadCube(connectionId, widgetSqls, dataLayer?)` fetches the
 *     parquet bytes for every table the dashboard touches, registers
 *     each in the singleton DuckDB-WASM instance, and returns a
 *     handle the caller stores in a useRef. The handle just keeps
 *     the list of registered table names + total bytes so callers
 *     can render "Fast mode · N MB" badges.
 *   - `runWidgetSql(handle, sql)` executes the SQL against the WASM
 *     instance. The cube handle is unused at runtime (the tables are
 *     globally registered) but threading it through prevents callers
 *     from accidentally querying before a cube is loaded.
 *
 * Memory budget — the safety net:
 *   - Before fetching, we ask the server for the total cube size in
 *     a HEAD-ish call (just look at the JSON.totalBytes field). If
 *     it exceeds CUBE_MAX_BYTES we refuse to load and surface a
 *     friendly error so the dashboard falls back to server mode.
 *   - The default cap (200MB compressed parquet, expands to ~5-10x
 *     in WASM memory) is conservative; can be tuned per-environment
 *     via NEXT_PUBLIC_CUBE_MAX_MB.
 *
 * On dashboard close: tables stay registered until the page is
 * navigated away. The DuckDB singleton lives for the document
 * lifetime; we don't drop tables explicitly because (a) loading the
 * next dashboard registers fresh ones under different names, and (b)
 * dropping is asynchronous and adds latency to dashboard switching.
 */

import api from '@/lib/api';
import { getWasmDb } from './duckdb';

const CUBE_MAX_BYTES = Number(process.env.NEXT_PUBLIC_CUBE_MAX_MB ?? '200') * 1024 * 1024;

export interface CubeHandle {
  /** Table names registered in the WASM database, ready for SQL. */
  tableNames: string[];
  /** Total bytes of parquet loaded — surfaced in the UI. */
  totalBytes: number;
}

export interface CubeLoadResult {
  ok: true;
  handle: CubeHandle;
}

export interface CubeLoadError {
  ok: false;
  /** Why the cube couldn't be loaded. Caller decides whether to
   *  surface this to the user or fall back silently. */
  error: string;
  /** True when the dataset was too large for the configured budget.
   *  Callers may want to show a different message in that case. */
  budgetExceeded?: boolean;
}

interface CubeApiTable {
  tableName: string;
  parquetBase64: string;
  rowCount: number;
  sizeBytes: number;
}

interface CubeApiResponse {
  ok: boolean;
  data?: { tables: CubeApiTable[]; totalBytes: number };
  error?: string;
}

/**
 * Fetch the dashboard's cube from the backend, decode each parquet,
 * register it as a virtual file in DuckDB-WASM, and create a view
 * named after the underlying table. After this resolves the
 * frontend can run any of the widget SQLs against the local DB.
 */
export async function loadCube(params: {
  connectionId: number;
  widgetSqls: string[];
  dataLayer?: 'product' | 'source';
}): Promise<CubeLoadResult | CubeLoadError> {
  try {
    // Step 1: fetch the cube. The endpoint returns base64-encoded
    // parquets; we decode each to a Uint8Array before handing to
    // DuckDB-WASM's registerFileBuffer.
    const res = await api.post<CubeApiResponse>('/dashboards/cube', {
      connectionId: params.connectionId,
      widgetSqls: params.widgetSqls,
      ...(params.dataLayer === 'source' ? { dataLayer: 'source' as const } : {}),
    });

    if (!res.data.ok || !res.data.data) {
      return { ok: false, error: res.data.error ?? 'Failed to load cube' };
    }

    const { tables, totalBytes } = res.data.data;

    // Step 2: memory budget guardrail. The server happily streams the
    // bytes; the budget check protects the user's browser tab.
    if (totalBytes > CUBE_MAX_BYTES) {
      return {
        ok: false,
        error: `This dashboard's data (${formatMb(totalBytes)}) exceeds the fast-mode budget of ${formatMb(CUBE_MAX_BYTES)}. Falling back to server mode.`,
        budgetExceeded: true,
      };
    }

    if (tables.length === 0) {
      return { ok: false, error: 'No tables found for this dashboard' };
    }

    // Step 3: spin up DuckDB-WASM + register every parquet under its
    // table name. DuckDB-WASM's registerFileBuffer takes a Uint8Array,
    // then CREATE VIEW points at it.
    const db = await getWasmDb();
    const conn = await db.connect();
    try {
      for (const t of tables) {
        const bytes = base64ToUint8Array(t.parquetBase64);
        const fileName = `${sanitiseFileName(t.tableName)}.parquet`;
        await db.registerFileBuffer(fileName, bytes);
        // Drop + recreate so subsequent loads (e.g. user re-opens
        // the dashboard) don't error on "table already exists".
        const safe = `"${t.tableName.replace(/"/g, '""')}"`;
        await conn.query(`DROP VIEW IF EXISTS ${safe}`);
        await conn.query(`CREATE VIEW ${safe} AS SELECT * FROM read_parquet('${fileName}')`);
      }
    } finally {
      await conn.close();
    }

    return {
      ok: true,
      handle: {
        tableNames: tables.map((t) => t.tableName),
        totalBytes,
      },
    };
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
      ?? (err as { message?: string })?.message
      ?? 'Cube load failed';
    return { ok: false, error: msg };
  }
}

/**
 * Execute a single widget's SQL against the local cube. Mirrors the
 * shape of a /batch-execute-stream result: rows on success, error
 * string on failure (so the caller can render an inline error per
 * widget instead of crashing the whole dashboard).
 */
export async function runWidgetSql(
  _handle: CubeHandle,
  sql: string,
): Promise<{ rows: Record<string, unknown>[] } | { error: string }> {
  try {
    const db = await getWasmDb();
    const conn = await db.connect();
    try {
      const result = await conn.query(sql);
      // duckdb-wasm returns an Arrow Table. Materialise to plain JS
      // objects so the existing widget renderers can consume them
      // without an Arrow-aware path.
      const rows = result.toArray().map((r: unknown) => {
        const obj = (r as { toJSON?: () => Record<string, unknown> }).toJSON
          ? (r as { toJSON: () => Record<string, unknown> }).toJSON()
          : (r as Record<string, unknown>);
        // BigInt → Number for downstream Recharts / JSON consumption.
        // Charts choke on bigint; SMB data fits safely in 2^53.
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return out;
      });
      return { rows };
    } finally {
      await conn.close();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sanitiseFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
