/**
 * Managed grids — the in-Clarion spreadsheet place (budgets, mappings, lists).
 *
 * Postgres (`managed_grids` + `managed_grid_rows`, JSONB) is the TRUTH the
 * user edits; this module turns that truth into an ordinary warehouse table
 * so Ask AI, dashboards and topics can read it next to the connectors' data.
 *
 * The integration follows the ROLLUP pattern exactly (the four-surface
 * contract documented on `rollupViewName`): the materialiser writes a
 * versioned DIRECTORY and records its URI on the grid row; `tableCatalog`
 * lists materialised grids; `ConnectorFactory.createProductConnector`
 * registers a `grid_<slug>` view per grid; `productContext` tells the model
 * the table exists. Versioned paths (never overwrite-in-place) are what make
 * pooled-session staleness structurally impossible — the pool key includes
 * every registered path.
 *
 * Security shape, for the reviewer:
 *   - Cell VALUES are data end to end: JSONB in Postgres, NDJSON staging file
 *     into `read_json(columns={...})` — they are never interpolated into SQL.
 *   - Grid slugs and column KEYS become identifiers (view name, parquet
 *     columns). They are derived/validated here against strict patterns
 *     before any interpolation, and `writeRowsParquet` re-checks them.
 */

import { Database } from 'duckdb-async';
import {
  gridBasePath,
  gridViewName,
  isAzurePath,
  setupDuckDBForWarehouse,
  ensureWarehouseContainer,
  writeRowsParquet,
  deleteWarehousePath,
  type DeclaredColumn,
} from './warehouse';
import path from 'path';
import fs from 'fs';
import { invalidateWidgetCache } from './widgetCache';
import { invalidateFilterOptionsCache } from './filterOptionsCache';
import { publishInvalidation } from '../jobs/cacheBus';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'managed-grids' });

// ─── Contract constants ─────────────────────────────────────────────────────

// Grids are for budgets/mappings/lists (hundreds to low thousands of rows),
// not data dumps — bigger data belongs in a source connector. 10k also keeps
// a full-replace save comfortably inside the 2mb JSON body limit.
export const GRID_MAX_ROWS = 10_000;
export const GRID_MAX_COLUMNS = 40;
export const GRID_MAX_CELL_CHARS = 2_000;

export type GridColumnType = 'text' | 'number' | 'date' | 'boolean';
export type GridKind = 'budget' | 'mapping' | 'list';

export interface GridColumn {
  /** Warehouse identifier — `^[a-z][a-z0-9_]*$`, unique within the grid. */
  key: string;
  /** Display label the user sees and renames freely. */
  name: string;
  type: GridColumnType;
}

const COLUMN_KEY_RE = /^[a-z][a-z0-9_]*$/;
const SLUG_RE = /^[a-z][a-z0-9_]*$/;

const DUCKDB_TYPE: Record<GridColumnType, string> = {
  text: 'VARCHAR',
  number: 'DOUBLE',
  date: 'DATE',
  boolean: 'BOOLEAN',
};

// ─── Identifier derivation (pure, unit-tested) ──────────────────────────────

/**
 * Turn a display name into a safe identifier fragment: lowercase, runs of
 * non-alphanumerics collapse to `_`, trimmed, length-capped. Returns '' when
 * nothing survives (e.g. a name of only punctuation) — callers must handle.
 */
function sanitizeIdentifier(name: string, maxLen: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen)
    .replace(/_+$/g, '');
}

/**
 * Derive the grid slug from its display name at CREATION time. The slug is
 * fixed for the grid's life (renames change only the display name), because
 * `grid_<slug>` is the name saved dashboards and questions reference.
 */
export function deriveGridSlug(name: string): string {
  const s = sanitizeIdentifier(name, 40);
  if (s === '' || !/^[a-z]/.test(s)) return s === '' ? 'table' : `g_${s}`.slice(0, 40);
  return s;
}

/**
 * Derive a column key from its display name, made unique against `taken`.
 * Total: always returns a valid key.
 */
export function deriveColumnKey(name: string, taken: ReadonlySet<string>): string {
  let base = sanitizeIdentifier(name, 60);
  if (base === '' || !/^[a-z]/.test(base)) base = base === '' ? 'column' : `c_${base}`.slice(0, 60);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function isValidColumnKey(key: string): boolean {
  return COLUMN_KEY_RE.test(key) && key.length <= 60;
}

export function isValidGridSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && slug.length <= 40;
}

/**
 * Normalise a client-submitted column list into a valid `GridColumn[]`.
 * Keys the client supplies are kept when valid (so renames preserve the key
 * and existing row data); missing/invalid keys are derived from the name.
 * Throws with a user-safe message on structural problems.
 */
export function normalizeColumns(
  input: ReadonlyArray<{ key?: string | null; name: string; type: string }>,
): GridColumn[] {
  if (input.length === 0) throw new GridValidationError('A table needs at least one column.');
  if (input.length > GRID_MAX_COLUMNS) {
    throw new GridValidationError(`A table can have at most ${GRID_MAX_COLUMNS} columns.`);
  }
  const taken = new Set<string>();
  const out: GridColumn[] = [];
  for (const col of input) {
    const name = col.name.trim();
    if (name === '') throw new GridValidationError('Every column needs a name.');
    const type = col.type as GridColumnType;
    if (!(type in DUCKDB_TYPE)) {
      throw new GridValidationError(`Unknown column type "${col.type}".`);
    }
    let key = typeof col.key === 'string' && isValidColumnKey(col.key) ? col.key : '';
    if (key !== '' && taken.has(key)) {
      throw new GridValidationError(`Duplicate column key "${key}".`);
    }
    if (key === '') key = deriveColumnKey(name, taken);
    taken.add(key);
    out.push({ key, name, type });
  }
  return out;
}

/** User-safe validation failure — routes translate it into a 400. */
export class GridValidationError extends Error {}

// ─── Row validation / coercion (pure, unit-tested) ──────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a number the way a spreadsheet user writes one. Accepts plain JS
 * numbers, `1,234.56` (en) and `1.234,56` (eu — the format every Belgian
 * Excel produces), with optional currency symbol/percent and spaces.
 * Returns null when the text is not a number.
 */
export function parseFlexibleNumber(raw: string): number | null {
  let t = raw.trim().replace(/[\s ]/g, '').replace(/^[€$£]/, '').replace(/[€$£%]$/, '');
  if (t === '' || t === '-' || t === '+') return null;
  const hasDot = t.includes('.');
  const hasComma = t.includes(',');
  if (hasDot && hasComma) {
    // The RIGHTMOST separator is the decimal mark; the other is grouping.
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) {
      t = t.replace(/\./g, '').replace(',', '.');
    } else {
      t = t.replace(/,/g, '');
    }
  } else if (hasComma) {
    // A single comma is a decimal mark ("12,5"); repeated commas are
    // grouping ("1,234,567").
    t = (t.match(/,/g) ?? []).length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a date the way a spreadsheet user writes one: `2026-08-21`,
 * `21/08/2026`, `21-08-2026`, `21.08.2026` (day-first — the European
 * reading; this product's market writes dd/mm). Returns `YYYY-MM-DD` or
 * null.
 */
export function parseFlexibleDate(raw: string): string | null {
  const t = raw.trim().slice(0, 10);
  if (DATE_RE.test(t)) {
    return Number.isNaN(Date.parse(t)) ? null : t;
  }
  const m = raw.trim().match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/);
  if (!m) return null;
  let year: number; let month: number; let day: number;
  if (m[1].length === 4) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
  } else if (m[3].length === 4) {
    day = Number(m[1]); month = Number(m[2]); year = Number(m[3]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Validate and coerce one raw row against the grid's columns. Returns a
 * clean object holding ONLY declared keys (stale keys from deleted columns
 * are dropped). Throws `GridValidationError` naming the row and column on
 * the first invalid value.
 */
export function coerceRow(
  raw: Record<string, unknown>,
  columns: ReadonlyArray<GridColumn>,
  rowIndex: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    const v = raw[col.key];
    if (v === undefined || v === null || v === '') {
      out[col.key] = null;
      continue;
    }
    switch (col.type) {
      case 'text': {
        const s = String(v);
        if (s.length > GRID_MAX_CELL_CHARS) {
          throw new GridValidationError(
            `Row ${rowIndex + 1}, "${col.name}": text is longer than ${GRID_MAX_CELL_CHARS} characters.`,
          );
        }
        out[col.key] = s;
        break;
      }
      case 'number': {
        const n = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : parseFlexibleNumber(String(v));
        if (n === null) {
          throw new GridValidationError(
            `Row ${rowIndex + 1}, "${col.name}": "${String(v).slice(0, 40)}" is not a number.`,
          );
        }
        out[col.key] = n;
        break;
      }
      case 'date': {
        const s = parseFlexibleDate(String(v));
        if (s === null) {
          throw new GridValidationError(
            `Row ${rowIndex + 1}, "${col.name}": "${String(v).slice(0, 40)}" is not a date (use 21/08/2026 or 2026-08-21).`,
          );
        }
        out[col.key] = s;
        break;
      }
      case 'boolean': {
        if (typeof v === 'boolean') { out[col.key] = v; break; }
        const s = String(v).trim().toLowerCase();
        if (s === 'true' || s === 'yes' || s === '1') { out[col.key] = true; break; }
        if (s === 'false' || s === 'no' || s === '0') { out[col.key] = false; break; }
        throw new GridValidationError(
          `Row ${rowIndex + 1}, "${col.name}": "${String(v).slice(0, 40)}" is not yes/no.`,
        );
      }
    }
  }
  return out;
}

export function declaredColumnsFor(columns: ReadonlyArray<GridColumn>): DeclaredColumn[] {
  return columns.map((c) => ({ name: c.key, sqlType: DUCKDB_TYPE[c.type] }));
}

// ─── Materialisation ────────────────────────────────────────────────────────

export interface MaterializeInput {
  tenantId: number;
  gridId: number;
  /** The version to WRITE (caller increments and persists it). */
  version: number;
  columns: ReadonlyArray<GridColumn>;
  rows: ReadonlyArray<Record<string, unknown>>;
  /** Previous directory URI, deleted best-effort after a successful write. */
  previousPath?: string | null;
}

/**
 * Write the grid's rows to its versioned warehouse directory and return the
 * DIRECTORY URI to record. Throws on failure — the caller records the error
 * on the grid row so the UI can say why the table isn't available yet.
 * Postgres truth is never at risk here: rows are already committed before
 * materialisation runs.
 */
export async function materializeGrid(input: MaterializeInput): Promise<string> {
  const dir = gridBasePath(input.tenantId, input.gridId, input.version);
  const useAzure = isAzurePath(dir);
  const fileUri = useAzure ? `${dir}/data.parquet` : path.join(dir, 'data.parquet');

  if (useAzure) {
    await ensureWarehouseContainer(input.tenantId);
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = await Database.create(':memory:');
  try {
    await setupDuckDBForWarehouse(db, useAzure);
    await writeRowsParquet(db, fileUri, input.rows, declaredColumnsFor(input.columns));
  } finally {
    await db.close();
  }

  if (input.previousPath && input.previousPath !== dir) {
    deleteWarehousePath(input.previousPath).catch((err) => {
      log.warn({ err, path: input.previousPath }, 'grid: old version cleanup failed (non-fatal)');
    });
  }

  // Widget/filter caches key on (tenant, SQL) — the SQL doesn't change when
  // the data behind it does, so they must be dropped explicitly. The pooled
  // DuckDB sessions need nothing: the new URI changes the pool key. The
  // publisher does not receive its own message, hence local + broadcast.
  invalidateWidgetCache(input.tenantId);
  invalidateFilterOptionsCache(input.tenantId);
  publishInvalidation({ tenantId: input.tenantId });

  return dir;
}
