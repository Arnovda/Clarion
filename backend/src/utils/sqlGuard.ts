/**
 * Read-only guard for AI-generated SQL.
 *
 * Model-authored SQL is executed against tenant warehouses (DuckDB) and, for
 * source-layer questions, against the tenant's actual source database through
 * the stored credentials — which may be read-write. A prompt-injected or
 * simply wrong model response could otherwise emit a data-modifying statement.
 * This guard is the last line before execution: it accepts a SINGLE read-only
 * `SELECT`/`WITH` statement and rejects everything else.
 *
 * It is intentionally conservative — false negatives (rejecting a valid read)
 * are safe here; a rejected query surfaces as "couldn't run that safely",
 * which is strictly better than executing a mutation. It is NOT applied to the
 * notebook surface (which deliberately runs arbitrary SQL, including DDL) or
 * to the transformation writer (which must write).
 *
 * Pure string function, no DB dependency — unit-tested without a native build.
 */

export class UnsafeSqlError extends Error {
  constructor(reason: string) {
    super(`Refused to run non-read-only SQL: ${reason}`);
    this.name = 'UnsafeSqlError';
  }
}

// Whole-word tokens that must never appear in a read-only query. Catches
// data-modifying CTEs (`WITH x AS (DELETE ... RETURNING ...) SELECT ...`),
// DDL, privilege changes, and DuckDB side-channels (ATTACH/COPY/INSTALL/
// LOAD/PRAGMA/SET/EXPORT) that could read or write outside the query.
const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'upsert', 'replace',
  'drop', 'alter', 'create', 'truncate', 'rename',
  'grant', 'revoke',
  'attach', 'detach', 'copy', 'export', 'import',
  'install', 'load', 'pragma', 'set', 'reset', 'call', 'execute',
  'vacuum', 'analyze', 'reindex', 'checkpoint',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`, 'i');

// DuckDB table/scalar functions that read from an ARBITRARY path or URI rather
// than a registered view. These are the cross-tenant reachability primitive:
// user/AI SQL only ever needs the tenant-scoped VIEW NAMES we register for it,
// so a query that names one of these functions is either an attack
// (`read_parquet('az://warehouse/tenant_<other>/...')`,
// `read_text('/proc/self/environ')`) or a mistake — both must be refused. This
// is checked on the read surfaces (Ask-AI, dashboards, notebooks) in addition
// to the SELECT-only guard above; the transformation writer does NOT use it
// (it legitimately reads source paths server-side).
const EXTERNAL_FNS = [
  'read_parquet', 'parquet_scan', 'parquet_metadata', 'parquet_schema',
  'read_csv', 'read_csv_auto', 'sniff_csv',
  'read_json', 'read_json_auto', 'read_json_objects', 'read_json_objects_auto',
  'read_ndjson', 'read_ndjson_auto', 'read_ndjson_objects',
  'read_text', 'read_blob',
  'delta_scan',
  'iceberg_scan', 'iceberg_metadata', 'iceberg_snapshots',
  'read_arrow', 'scan_arrow',
  'postgres_scan', 'postgres_query', 'mysql_scan', 'mysql_query', 'sqlite_scan',
  'glob',
];
// Match `fn(` allowing whitespace, on literal-stripped SQL (so a string that
// merely contains the word is ignored, but an actual call is caught).
const EXTERNAL_FN_RE = new RegExp(`\\b(${EXTERNAL_FNS.join('|')})\\s*\\(`, 'i');

// Object-storage URI schemes that must never appear as a literal in a read
// query — these virtually never occur as legitimate column data, so flagging
// them is high-signal. Deliberately EXCLUDES http(s)/file/memory: those show up
// as ordinary data (a `referrer` URL, a `file://` path column) and would
// false-positive; the file/http *read* vectors are instead caught by the
// function denylist above and the FROM-literal check below. Scanned on RAW sql
// (the path lives inside a quote).
const URI_SCHEME_RE = /\b(az|azure|abfss?|s3a?|gs|gcs|r2|hdfs)\s*:\/\//i;

/**
 * Strip SQL comments, single-quoted string literals, dollar-quoted strings,
 * and double-quoted identifiers so that keyword/`;` scanning can't be fooled
 * by content inside them (a column named "update", a literal 'a;b', etc.).
 */
function stripLiterals(sql: string): string {
  let s = sql;
  s = s.replace(/--[^\n]*/g, ' ');          // line comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');  // block comments
  s = s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' '); // dollar-quoted
  s = s.replace(/'(?:[^']|'')*'/g, ' ');    // single-quoted strings ('' escape)
  s = s.replace(/"(?:[^"]|"")*"/g, ' ');    // double-quoted identifiers
  return s;
}

/**
 * Like `stripLiterals` but replaces string literals with a distinct sentinel
 * (`@STRLIT@`) and double-quoted identifiers with `@IDENT@`, so we can tell
 * WHERE a string literal sat in the statement. Used to catch DuckDB's bare
 * replacement scan — `FROM '/path/file.parquet'` / `FROM 'az://...'` — which
 * reads a file with no `read_*` function and (for local paths) no URI scheme.
 */
function markLiterals(sql: string): string {
  let s = sql;
  s = s.replace(/--[^\n]*/g, ' ');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' @STRLIT@ ');
  s = s.replace(/'(?:[^']|'')*'/g, ' @STRLIT@ ');
  s = s.replace(/"(?:[^"]|"")*"/g, ' @IDENT@ ');
  return s;
}

// A single-quoted string literal sitting in table position (directly after
// FROM or JOIN) is never a real table reference — tables are identifiers,
// subqueries, or function calls. It IS DuckDB's replacement-scan syntax for
// reading a file/URI by path. Zero false positives on legitimate SQL.
const FROM_LITERAL_RE = /\b(from|join)\s+@STRLIT@/i;

/**
 * Throw `UnsafeSqlError` unless `sql` is a single read-only SELECT/WITH query.
 * Returns the trimmed SQL (without a trailing `;`) on success.
 */
export function assertSelectOnly(sql: string): string {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new UnsafeSqlError('empty query');
  }

  const stripped = stripLiterals(sql).trim();

  // One statement only. A single trailing ';' is allowed; anything after it
  // (a second statement) is not.
  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new UnsafeSqlError('multiple statements');
  }

  // Must be a read query.
  if (!/^\s*(select|with)\b/i.test(withoutTrailing)) {
    throw new UnsafeSqlError('not a SELECT/WITH query');
  }

  // Defence in depth: no data-modifying / side-channel keywords anywhere
  // (catches data-modifying CTEs inside a WITH).
  const m = FORBIDDEN_RE.exec(withoutTrailing);
  if (m) {
    throw new UnsafeSqlError(`forbidden keyword "${m[1].toUpperCase()}"`);
  }

  return sql.trim().replace(/;\s*$/, '').trim();
}

/** Boolean variant for call sites that prefer a check over a throw. */
export function isSelectOnly(sql: string): boolean {
  try {
    assertSelectOnly(sql);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw `UnsafeSqlError` if `sql` reaches outside the registered views — i.e.
 * calls a path/URI-reading table function or embeds a storage/filesystem URI
 * literal. Legitimate read SQL references only the tenant-scoped view names we
 * register, so this never fires on a well-formed query. It is the guard that
 * closes the cross-tenant blob-read and local-file-read vectors that
 * SELECT-only alone does not (a `SELECT` from `read_parquet('az://...')` is
 * still a SELECT).
 */
export function assertNoExternalAccess(sql: string): void {
  if (typeof sql !== 'string') return;
  // Object-storage URI literals: scan the raw SQL (the path lives inside a quote).
  const uri = URI_SCHEME_RE.exec(sql);
  if (uri) {
    throw new UnsafeSqlError(`external path/URI literal "${uri[1].toLowerCase()}://"`);
  }
  // Bare replacement scan: a string literal in FROM/JOIN position reads a file
  // by path (catches local paths + any scheme, e.g. `FROM '/warehouse/tenant_x/…'`).
  const marked = markLiterals(sql);
  if (FROM_LITERAL_RE.test(marked)) {
    throw new UnsafeSqlError('path literal in FROM/JOIN position (replacement scan)');
  }
  // Table/scalar functions that read arbitrary paths: scan literal-stripped SQL
  // so a string merely containing the word is ignored but a real call is caught.
  const stripped = stripLiterals(sql);
  const fn = EXTERNAL_FN_RE.exec(stripped);
  if (fn) {
    throw new UnsafeSqlError(`external-access function "${fn[1].toLowerCase()}()"`);
  }
}

/**
 * Full read-surface guard: a single read-only SELECT/WITH that does NOT reach
 * outside its registered views. Use on every surface that executes
 * user- or AI-authored SQL against a tenant warehouse (Ask-AI, dashboards,
 * notebooks). Returns the cleaned SQL on success.
 */
export function assertSafeReadQuery(sql: string): string {
  const cleaned = assertSelectOnly(sql);
  assertNoExternalAccess(sql);
  return cleaned;
}

/** Boolean variant of {@link assertSafeReadQuery}. */
export function isSafeReadQuery(sql: string): boolean {
  try {
    assertSafeReadQuery(sql);
    return true;
  } catch {
    return false;
  }
}
