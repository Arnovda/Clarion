/**
 * THE KEY RULE — how every product table's surrogate key is made, defined once.
 *
 * A dimension's key and every fact column that points at it must hold the
 * SAME value for the same source row, on every build, whichever of the two
 * was rebuilt last. Two ways of making keys fail that:
 *
 *   - numbered per build (`ROW_NUMBER() OVER (ORDER BY a.ID)`): a new account
 *     lands mid-order and every key after it shifts by one, while the facts
 *     keep the old numbers — invoice lines silently move to the neighbouring
 *     customer. Refused since 2026-09-09 (C1).
 *   - the source id itself (`a.ID AS account_key`): stable, but a 36-char
 *     GUID. Measured 2026-09-24 on DuckDB 1.4.2 over Parquet, 20M fact rows:
 *     joins twice as slow as an integer and a 7.5× larger key column (720 MB
 *     vs 95 MB), which is also what is read from blob storage on a cold query.
 *
 * `clarion_key('<Entity>', <source id>)` is a 63-bit BIGINT derived from
 * MD5 of the entity name and the id: stable by construction (no counter, no
 * state, no build order), an integer for the join (within 5–13% of a dense
 * 1,2,3 key in the same measurement), and MD5 is a fixed algorithm — unlike
 * DuckDB's `hash()`, whose output may change between DuckDB versions. A fact
 * computes its foreign key with the same call on ITS OWN column, so it never
 * has to look the key up in the dimension.
 *
 * Normalisation, so the two sides agree even when the source is sloppy:
 *   - entity and id are trimmed and lower-cased (a GUID in upper case in one
 *     endpoint and lower case in another is the same GUID; a SQL Server code
 *     compares case-insensitively; trailing padding is not part of a code);
 *   - a whole-number DOUBLE/DECIMAL id is written without its fraction, so a
 *     column JSON auto-detection typed as DOUBLE (5.0) matches an INTEGER 5;
 *   - NULL and '' give NULL — a missing reference is not a key.
 * Two ids that differ only in case therefore share a key; if a source really
 * has both, the dimension's key-uniqueness check refuses the build rather
 * than joining wrong rows. Composite keys: `clarion_key('Entity',
 * concat_ws('|', a, b))`.
 *
 * Collisions: 63 bits over, say, a million rows of one entity is a chance of
 * about 1 in 20 million — and a collision fails the (blocking) uniqueness
 * check on the dimension's key; it can never publish a wrong join.
 *
 * This file is imported by the backend (registration in every warehouse
 * session, the design/declaration validators) and by this package's own
 * template tests and conformance checks, so the definition and the rule
 * exist exactly once.
 */

export const CLARION_KEY_FUNCTION = 'clarion_key';

/**
 * The DuckDB macro. Registered by `setupDuckDBForWarehouse` in every session
 * that builds, previews or compiles product-table SQL. CHANGING ITS BODY
 * CHANGES EVERY KEY IN EVERY TENANT — a version bump, never an edit.
 */
export const CLARION_KEY_MACRO_SQL = `
CREATE OR REPLACE MACRO clarion_key(entity, id) AS (
  CASE
    WHEN id IS NULL THEN NULL
    WHEN trim(CAST(id AS VARCHAR)) = '' THEN NULL
    ELSE (md5_number(
      lower(trim(CAST(entity AS VARCHAR))) || chr(31) ||
      lower(trim(CASE
        WHEN typeof(id) IN ('FLOAT', 'DOUBLE') OR typeof(id) LIKE 'DECIMAL%'
          THEN CASE WHEN CAST(id AS DOUBLE) = trunc(CAST(id AS DOUBLE))
                    THEN CAST(CAST(id AS HUGEINT) AS VARCHAR)
                    ELSE CAST(id AS VARCHAR) END
        ELSE CAST(id AS VARCHAR)
      END))
    ) >> 65)::BIGINT
  END
);`;

/** Register `clarion_key` on a DuckDB session (anything with `exec`). */
export async function registerClarionKey(db: { exec: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.exec(CLARION_KEY_MACRO_SQL);
}

// ─── Reading keys back out of SQL ─────────────────────────────────────────

/** How a key column is made, read off the SQL. */
export type KeyForm =
  /** `clarion_key('<entity>', …)` — stable, integer. */
  | { kind: 'hashed'; entity: string }
  /** `clarion_key(…)` whose first argument is not a quoted literal — cannot be compared. */
  | { kind: 'hashed-dynamic' }
  /** ROW_NUMBER / UUID / RANDOM / NEXTVAL — renumbered per build. */
  | { kind: 'unstable'; fn: string }
  /** Anything else: the source id itself, a lookup from a dimension, a date key… */
  | { kind: 'other' }
  /** The column is not produced under that name in the SQL we could read. */
  | { kind: 'unknown' };

const UNSTABLE_FN_RE = /\b(ROW_NUMBER|UUID|GEN_RANDOM_UUID|RANDOM|NEXTVAL)\s*\(/i;
const KEY_CALL_RE = /\bclarion_key\s*\(/i;

/** Replace comments with spaces (same length, so offsets stay valid). String-aware. */
export function blankComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = skipQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += ' '.repeat(end - i);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the quoted run starting at `i` ('' / "" escapes honoured). */
function skipQuoted(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === q) {
      if (s[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

/** Blank out the CONTENTS of string literals and quoted identifiers (keeps quotes and offsets). */
function blankQuoted(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = skipQuoted(sql, i);
      out += c + ' '.repeat(Math.max(0, end - i - 2)) + (end - i >= 2 ? sql[end - 1] : '');
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The select-item expression that produces column `column` — the text
 * between the nearest top-level `,` / SELECT before `AS <column>` and that
 * AS. The LAST such item wins: a final SELECT follows its CTEs in the text,
 * and a final SELECT that just passes `c.account_key` through has no
 * `AS account_key` of its own, so the CTE that made it is the one read.
 * Returns null when the SQL never names the column with AS.
 */
export function selectItemFor(sql: string, column: string): string | null {
  const span = selectItemSpan(sql, column);
  return span ? sql.slice(span.start, span.end).trim() : null;
}

/**
 * Where the select item producing `column` sits in `sql`: [start, end) of the
 * expression (without its `AS column`), or null. Offsets index the ORIGINAL
 * text — comments are blanked to spaces of the same length, never removed.
 */
export function selectItemSpan(sql: string, column: string): { start: number; end: number } | null {
  const clean = blankComments(sql);
  const masked = blankQuoted(clean);
  const re = new RegExp(`\\bAS\\s+("${escapeRe(column)}"|${escapeRe(column)})(?![\\w$])`, 'gi');
  let match: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  // Quoted aliases are matched on the un-masked text; bare ones on the masked
  // text so a string literal can never be mistaken for an alias.
  const quotedRe = new RegExp(`\\bAS\\s+"${escapeRe(column)}"`, 'gi');
  while ((m = re.exec(masked)) !== null) match = m;
  let qm: RegExpExecArray | null;
  while ((qm = quotedRe.exec(clean)) !== null) {
    if (!match || qm.index > match.index) match = qm;
  }
  if (!match) return null;
  const asAt = match.index;
  // Walk back to the start of this select item.
  let depth = 0;
  let start = 0;
  for (let i = asAt - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) { start = i + 1; break; }
      depth--;
    } else if (depth === 0 && c === ',') { start = i + 1; break; }
    else if (depth === 0 && /\bselect\s*$/i.test(masked.slice(Math.max(0, i - 6), i + 1))) {
      start = i + 1;
      break;
    }
  }
  // Trim the span to the expression itself (leading/trailing whitespace).
  let a = start;
  let b = asAt;
  while (a < b && /\s/.test(sql[a])) a++;
  while (b > a && /\s/.test(sql[b - 1])) b--;
  // A leading DISTINCT belongs to the SELECT, not to this item.
  const distinct = /^distinct\s+/i.exec(sql.slice(a, b));
  if (distinct) a += distinct[0].length;
  return { start: a, end: b };
}

/** `sql` with the expression producing `column` replaced by `expression`; null when the column is not found. */
export function replaceSelectItem(sql: string, column: string, expression: string): string | null {
  const span = selectItemSpan(sql, column);
  if (!span) return null;
  return sql.slice(0, span.start) + expression + sql.slice(span.end);
}

/** Classify an expression that produces a key. */
export function keyFormOfExpression(expr: string | null | undefined): KeyForm {
  if (!expr || !expr.trim()) return { kind: 'unknown' };
  const clean = blankComments(expr);
  const masked = blankQuoted(clean);
  const call = KEY_CALL_RE.exec(masked);
  if (call) {
    const open = call.index + call[0].length;
    const first = clean.slice(open).match(/^\s*'((?:[^']|'')*)'\s*,/);
    if (!first) return { kind: 'hashed-dynamic' };
    const entity = first[1].replace(/''/g, "'").trim().toLowerCase();
    return entity ? { kind: 'hashed', entity } : { kind: 'hashed-dynamic' };
  }
  const unstable = UNSTABLE_FN_RE.exec(masked);
  if (unstable) return { kind: 'unstable', fn: unstable[1].toUpperCase() };
  return { kind: 'other' };
}

/**
 * How column `column` of a table is made. Reads the SQL first (the truth the
 * build runs); falls back to the column's own `transformation_expression`
 * when the SQL does not name it with AS — which is a paraphrase, never
 * preferred over the SQL.
 */
export function keyFormOf(sql: string | null | undefined, column: string, expression?: string | null): KeyForm {
  const item = sql ? selectItemFor(sql, column) : null;
  if (item !== null) return keyFormOfExpression(item);
  return keyFormOfExpression(expression ?? null);
}

// ─── The rule, over a set of tables and their joins ───────────────────────

export interface KeyRuleTable {
  table_name: string;
  table_role?: string | null;
  transformation_sql?: string | null;
  columns?: Array<{
    column_name: string;
    column_role?: string | null;
    transformation_expression?: string | null;
  }> | null;
}

export interface KeyRuleJoin {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
}

export interface KeyRuleOptions {
  /**
   * `strict` (a new design, a template): every dimension key must be
   * `clarion_key`, and every column that points at one must be too.
   * `consistent` (an edit to a table that already exists): only refuse what
   * would break a join — an unstable key, or two ends of one join made two
   * different ways. A legacy table whose key is still the source id keeps
   * saving until its subject's keys are upgraded; switching ONE end of a join
   * to `clarion_key` without the other is refused.
   */
  mode: 'strict' | 'consistent';
  /** Only report problems that involve these tables (the one being edited). */
  onlyTables?: readonly string[];
}

/** The date dimension's key is YYYYMMDD — stable and already an integer. */
export function isDateDimension(tableName: string): boolean {
  return /^dim_date$/i.test(tableName);
}

function isKeyRole(role: string | null | undefined): boolean {
  return role === 'surrogate_key' || role === 'foreign_key';
}

/**
 * Every violation of the key rule, as sentences naming table and column.
 * Pure: the design validator, the declaration route and the connector
 * conformance suite all call this one function.
 */
export function keyRuleViolations(
  tables: readonly KeyRuleTable[],
  joins: readonly KeyRuleJoin[],
  opts: KeyRuleOptions,
): string[] {
  const out: string[] = [];
  const byName = new Map(tables.map((t) => [t.table_name.toLowerCase(), t]));
  const involved = (...names: string[]) =>
    !opts.onlyTables || names.some((n) => opts.onlyTables!.some((o) => o.toLowerCase() === n.toLowerCase()));

  const formFor = (tableName: string, column: string): KeyForm => {
    const t = byName.get(tableName.toLowerCase());
    if (!t) return { kind: 'unknown' };
    const col = (t.columns ?? []).find((c) => c.column_name.toLowerCase() === column.toLowerCase());
    return keyFormOf(t.transformation_sql, column, col?.transformation_expression);
  };

  // 1. Per key column: never minted per build; a dimension key is hashed (strict).
  for (const t of tables) {
    if (!involved(t.table_name)) continue;
    for (const c of t.columns ?? []) {
      if (!isKeyRole(c.column_role)) continue;
      const form = keyFormOf(t.transformation_sql, c.column_name, c.transformation_expression);
      if (form.kind === 'unstable') {
        out.push(`${t.table_name}.${c.column_name}: the key is renumbered on every build (${form.fn}) — use clarion_key('<Entity>', <source id>)`);
      } else if (form.kind === 'hashed-dynamic') {
        out.push(`${t.table_name}.${c.column_name}: clarion_key's first argument must be the entity name as a quoted literal, e.g. clarion_key('Accounts', a.ID)`);
      } else if (
        opts.mode === 'strict'
        && c.column_role === 'surrogate_key'
        && t.table_role !== 'fact'
        && !isDateDimension(t.table_name)
        && form.kind !== 'hashed'
      ) {
        out.push(`${t.table_name}.${c.column_name}: a lookup's key must be clarion_key('<Entity>', <source id>) — a stable integer — not ${form.kind === 'unknown' ? 'missing from the SQL' : 'the raw id'}`);
      }
    }
  }

  // 2. Per join: both ends made the same way.
  for (const j of joins) {
    if (!involved(j.from_table, j.to_table)) continue;
    if (isDateDimension(j.to_table) || isDateDimension(j.from_table)) continue;
    const to = formFor(j.to_table, j.to_column);
    const from = formFor(j.from_table, j.from_column);
    if (to.kind === 'unknown' || from.kind === 'unknown') continue;
    if (to.kind === 'unstable' || from.kind === 'unstable' || to.kind === 'hashed-dynamic' || from.kind === 'hashed-dynamic') continue; // reported above
    const label = `${j.from_table}.${j.from_column} → ${j.to_table}.${j.to_column}`;
    if (to.kind === 'hashed' && from.kind === 'hashed') {
      if (to.entity !== from.entity) {
        out.push(`${label}: the two ends hash different entities ('${from.entity}' vs '${to.entity}') — they will never match; use clarion_key('${to.entity}', …) on both`);
      }
    } else if (to.kind === 'hashed') {
      out.push(`${label}: the lookup's key is clarion_key('${to.entity}', …) but this column is not — compute it as clarion_key('${to.entity}', <this table's own column>)`);
    } else if (from.kind === 'hashed') {
      out.push(`${label}: this column is clarion_key('${from.entity}', …) but the lookup's key is not — both ends of a join change together`);
    } else if (opts.mode === 'strict') {
      out.push(`${label}: neither end uses clarion_key — both must, with the same entity`);
    }
  }
  return out;
}

/**
 * Every column the SQL makes with `clarion_key`, and the entity it hashes.
 * Used to refuse an automatic rewrite (the runner's AI repair) that would
 * change how a key is made: a repaired dim whose key no longer matches its
 * facts is a worse outcome than a failed build.
 */
export function hashedKeyColumns(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const masked = blankQuoted(blankComments(sql));
  const re = /\bAS\s+("?)([A-Za-z_][\w$]*)\1/gi;
  let m: RegExpExecArray | null;
  const aliases = new Set<string>();
  while ((m = re.exec(masked)) !== null) aliases.add(m[2]);
  // A quoted alias's name is blanked in `masked`; read those from the raw text.
  const quoted = /\bAS\s+"([^"]+)"/gi;
  const clean = blankComments(sql);
  while ((m = quoted.exec(clean)) !== null) aliases.add(m[1]);
  for (const a of aliases) {
    const form = keyFormOf(sql, a);
    if (form.kind === 'hashed') out.set(a.toLowerCase(), form.entity);
  }
  return out;
}

/**
 * The keys a rewrite of `before` into `after` would change: a clarion_key
 * column that disappeared, stopped hashing, or hashes another entity.
 * Empty when every key is made exactly as before.
 */
export function changedKeys(before: string, after: string): string[] {
  const was = hashedKeyColumns(before);
  const now = hashedKeyColumns(after);
  const out: string[] = [];
  for (const [col, entity] of was) {
    const next = now.get(col);
    if (next === undefined) out.push(`${col} is no longer clarion_key('${entity}', …)`);
    else if (next !== entity) out.push(`${col} now hashes '${next}' instead of '${entity}'`);
  }
  return out;
}
