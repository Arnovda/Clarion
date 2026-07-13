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
