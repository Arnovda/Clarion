/**
 * Source SQL type → DuckDB warehouse type, and the value coercion that goes
 * with it.
 *
 * TWO RULES MAKE THIS LOAD-BEARING RATHER THAN COSMETIC.
 *
 * 1. **The result must always be on the writer's allow-list.**
 *    `parquetOps.isSafeSqlType` accepts a fixed set, and a type outside it is
 *    not rejected — the column is silently FILTERED OUT of the read. A single
 *    unmapped type would therefore make a column vanish from the warehouse
 *    with nothing anywhere saying so. `VARCHAR` is the correct answer for
 *    anything unrecognised, never a guess at something cleverer.
 *
 * 2. **Explicit types are the whole point.** The playbook requires new
 *    connectors to pass `WriteTableOptions.columns` rather than relying on
 *    DuckDB's `auto_detect`, because sample-based inference drifts between
 *    syncs: a column that is all-NULL in one run and populated in the next
 *    changes type, and the merge UNION then fails. A SQL source knows its
 *    types exactly, so there is no excuse for inference here.
 */

import type { RawColumn } from './types';

/** DuckDB's maximum DECIMAL precision. */
const MAX_DECIMAL_PRECISION = 38;

/**
 * Types whose values do not belong in an analytics warehouse and are dropped
 * from the sync with a warning.
 *
 * Binary is excluded rather than mapped to BLOB on purpose. Rows are staged as
 * NDJSON, so a blob column would embed a base64 copy of every image in the
 * table in the staging file and again in the Parquet — on a table with
 * attachments that is the difference between a sync that works and a worker
 * killed at its 1 GiB ceiling. Nothing downstream (a chart, a question, a
 * join) can use the bytes anyway. Dropping it is stated in a warning, never
 * silent.
 */
const EXCLUDED_TYPES = new Set([
  'bytea', 'blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary',
  'image', 'geometry', 'geography', 'raw', 'long raw', 'rowversion',
]);

/**
 * Strip the modifiers a catalog view leaves on a type name so the lookup has
 * one key per type: `varchar(255)` → `varchar`, `numeric(10,2)` → `numeric`,
 * `timestamp(3) with time zone` → `timestamp with time zone`.
 *
 * Array types collapse to their element handling (Postgres reports `ARRAY`
 * or a leading `_`); an array lands as its JSON text in VARCHAR, which is at
 * least readable and joinable, unlike a dropped column.
 */
export function normaliseTypeName(raw: string): string {
  let t = (raw ?? '').trim().toLowerCase();
  t = t.replace(/\s+/g, ' ');
  // Any parenthesised modifier: `numeric(10,2)`, `varchar(255)`,
  // `timestamp(3) with time zone` — and `varbinary(max)`, where the modifier
  // is a WORD. Matching only digits let `varbinary(max)` slip past the binary
  // exclusion below, which is precisely the largest-blob case it exists for.
  t = t.replace(/\([^)]*\)/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Postgres array spellings.
  if (t.endsWith('[]')) return 'array';
  if (t === 'array') return 'array';
  if (t.startsWith('_')) return 'array';
  // MySQL's unsigned/zerofill attributes.
  t = t.replace(/\s+(unsigned|zerofill)\b/g, '').trim();
  return t;
}

/** True when this column should be left out of the sync entirely. */
export function isExcludedType(rawType: string): boolean {
  return EXCLUDED_TYPES.has(normaliseTypeName(rawType));
}

/**
 * The shared mapping, used by every dialect. Dialects override only where
 * their type genuinely behaves differently (MySQL's `tinyint(1)`, SQL
 * Server's `money`).
 */
export function baseDuckDbType(col: RawColumn): string {
  const t = normaliseTypeName(col.data_type);

  switch (t) {
    // ── Integers ────────────────────────────────────────────────────────
    case 'smallint': case 'int2': case 'smallserial': case 'serial2': case 'year':
      return 'SMALLINT';
    case 'tinyint':
      return 'TINYINT';
    case 'integer': case 'int': case 'int4': case 'mediumint': case 'serial': case 'serial4':
      return 'INTEGER';
    case 'bigint': case 'int8': case 'bigserial': case 'serial8':
      return 'BIGINT';

    // ── Exact numerics ──────────────────────────────────────────────────
    case 'numeric': case 'decimal': case 'dec': case 'fixed': case 'number':
      return decimalType(col.numeric_precision, col.numeric_scale);

    // ── Approximate numerics ────────────────────────────────────────────
    case 'real': case 'float4':
      return 'REAL';
    case 'double precision': case 'float8': case 'double': case 'float': case 'binary_double':
      return 'DOUBLE';

    // ── Boolean ─────────────────────────────────────────────────────────
    case 'boolean': case 'bool': case 'bit':
      return 'BOOLEAN';

    // ── Dates and times ─────────────────────────────────────────────────
    case 'date':
      return 'DATE';
    case 'timestamp': case 'timestamp without time zone': case 'datetime':
    case 'datetime2': case 'smalldatetime':
      return 'TIMESTAMP';
    case 'timestamptz': case 'timestamp with time zone': case 'datetimeoffset':
      return 'TIMESTAMPTZ';

    // ── Identifiers ─────────────────────────────────────────────────────
    case 'uuid': case 'uniqueidentifier':
      return 'UUID';

    default:
      // Everything else — text, enum, set, json, xml, network addresses,
      // intervals, arrays, spatial text, vendor extensions — lands as
      // VARCHAR. Readable, joinable, and never silently dropped. `time` is
      // here deliberately: DuckDB has a TIME type but the writer's allow-list
      // does not, so mapping to it would remove the column.
      return 'VARCHAR';
  }
}

/**
 * `DECIMAL(p,s)` when the database declared a precision, `DOUBLE` when it did
 * not.
 *
 * An unconstrained `numeric` (legal in Postgres) has no width to express, and
 * DuckDB requires one. DOUBLE is the standard analytics answer and sums
 * correctly; the cost is that a value beyond 15 significant digits rounds.
 * Recorded here rather than hidden because it is the one place this mapping
 * can lose precision on money.
 */
function decimalType(precision?: number | null, scale?: number | null): string {
  if (!precision || precision <= 0) return 'DOUBLE';
  const p = Math.min(Math.trunc(precision), MAX_DECIMAL_PRECISION);
  const s = Math.min(Math.max(Math.trunc(scale ?? 0), 0), p);
  return `DECIMAL(${p},${s})`;
}

/**
 * Turn a driver's JS value into something `JSON.stringify` can serialise and
 * DuckDB can cast to `targetType`.
 *
 * The cases here are each a real failure that would otherwise surface as a
 * whole-table sync error, because one bad value fails the `read_json` cast for
 * every row:
 *   • a `Date` stringifies to ISO 8601 already — but only if it is a real
 *     Date, so invalid dates are nulled rather than becoming `"Invalid Date"`
 *   • `JSON.stringify` THROWS on a BigInt, which would abort the whole write;
 *     big integers arrive as strings and DuckDB casts them without the
 *     precision loss a JS number would suffer
 *   • objects and arrays (json/jsonb columns, Postgres arrays) become their
 *     JSON text, matching the VARCHAR the mapper chose for them
 *   • MySQL reports `tinyint(1)` booleans as 0/1 and SQL Server `bit` as
 *     0/1 through some drivers; a JSON number will not cast to BOOLEAN
 */
export function normaliseValue(v: unknown, targetType: string): unknown {
  if (v === null || v === undefined) return null;

  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? v.toISOString() : null;
  }
  if (typeof v === 'bigint') return v.toString();

  if (typeof v === 'boolean') return v;

  if (targetType === 'BOOLEAN') {
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === '1' || s === 'true' || s === 't' || s === 'y' || s === 'yes') return true;
      if (s === '0' || s === 'false' || s === 'f' || s === 'n' || s === 'no') return false;
      return null;
    }
  }

  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;

  // Buffers should already be excluded by type, but a driver can surprise us
  // (a vendor extension reported as text). Never embed megabytes of base64.
  if (isBinary(v)) return null;

  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  }
  return String(v);
}

function isBinary(v: unknown): boolean {
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) return true;
  return typeof v === 'object' && v !== null && (v as { type?: string }).type === 'Buffer';
}
