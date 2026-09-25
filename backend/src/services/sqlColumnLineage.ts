/**
 * sqlColumnLineage — which source columns feed each output column of a
 * table, read off the table's CURRENT transformation SQL.
 *
 * Why this exists next to lineageDerivation.ts: that module runs once, at
 * build time, over the design's per-column `transformation_expression`, and
 * writes `column_lineage` rows. Those rows then go stale the moment the SQL
 * changes — a save on the SQL tab, the key upgrade rewriting every key, a
 * repair — because nothing rewrites them. A lineage view that describes SQL
 * the table no longer runs is worse than none. This module reads the SQL
 * that is stored NOW, so the view can never disagree with the SQL tab.
 *
 * What it follows, because transformation SQL is rarely one flat SELECT:
 *  - the final SELECT's select list, item by item (`expr AS name`,
 *    `x.col`, `x.col alias`, bare `col`);
 *  - CTEs and subqueries in FROM: a reference to one is followed into that
 *    query's select list, recursively — `WITH s AS (SELECT a.X + a.Y AS z …)
 *    SELECT s.z` resolves to X and Y;
 *  - `SELECT *` / `x.*` over a CTE, a subquery or a source table whose
 *    columns we know;
 *  - UNION / INTERSECT / EXCEPT: every branch feeds the column at the same
 *    position;
 *  - several columns combined into one (`concat_ws(' ', h.A, h.B)`,
 *    `l.Qty * l.Price`): one edge per source column, all into that one
 *    output column, with the expression as the transformation.
 *
 * What it will NOT do, on purpose — a wrong line is worse than a missing one:
 *  - attribute a column to anything that is not a known SOURCE table (a
 *    fact reading a lookup's key is a product-to-product link, not lineage
 *    from the source layer — `column_lineage.source_table_name` has always
 *    meant a source table);
 *  - guess a bare identifier when two relations could own it and we cannot
 *    tell which from the known column lists;
 *  - read an identifier inside a string literal or a comment
 *    (`clarion_key('accounts', h.InvoiceTo)` names h.InvoiceTo, not a
 *    column called accounts).
 *
 * Pure: no imports, no DB. Unit-tested in sqlColumnLineage.test.ts.
 */

export interface SourceCatalogTable {
  /** The table's name as stored in the catalog (canonical casing). */
  name: string;
  /** lower-case column name → canonical name. Absent = unknown columns. */
  columns?: Map<string, string>;
}

/** lower-case table name → the catalog entry. */
export type SourceCatalog = Map<string, SourceCatalogTable>;

export interface ColumnSourceRef {
  table: string;
  column: string;
}

export interface DerivedColumnLineage {
  /** The output column's name as the SQL spells it. */
  name: string;
  refs: ColumnSourceRef[];
  /**
   * null = every hop is a plain copy of one source column ("Copied as-is");
   * otherwise the expression that computes it — the outermost one that does
   * more than pass a value through.
   */
  transformation: string | null;
}

export interface SqlLineageResult {
  /** False when the SQL could not be read as a SELECT at all. */
  parsed: boolean;
  /** lower-case output column name → its lineage. */
  columns: Map<string, DerivedColumnLineage>;
}

// ─── Text preparation (length-preserving, so offsets stay valid) ─────────────

function blankComments(sql: string): string {
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

/** Index just past the quoted run starting at `i` ('' and "" escape). */
function skipQuoted(sql: string, i: number): number {
  const q = sql[i];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === q) {
      if (sql[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

/** Blank the contents of string literals (and, with `identifiers`, of "…"). */
function mask(sql: string, identifiers: boolean): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || (identifiers && c === '"')) {
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

/**
 * A statement in three aligned views: `text` (comments blanked), `lits`
 * (string literal contents blanked too — for scanning identifiers) and
 * `struct` (quoted identifiers blanked as well — for depth, commas and
 * keywords).
 */
interface Views { text: string; lits: string; struct: string }

function views(text: string): Views {
  return { text, lits: mask(text, false), struct: mask(text, true) };
}

function slice(v: Views, start: number, end: number): Views {
  return { text: v.text.slice(start, end), lits: v.lits.slice(start, end), struct: v.struct.slice(start, end) };
}

// ─── Top-level scanning helpers ──────────────────────────────────────────────

/** Positions (in `struct`) where `re` matches at paren depth 0. */
function topLevelMatches(struct: string, re: RegExp): Array<{ index: number; length: number; text: string }> {
  const depthAt: number[] = new Array(struct.length + 1);
  let depth = 0;
  for (let i = 0; i < struct.length; i++) {
    depthAt[i] = depth;
    if (struct[i] === '(') depth++;
    else if (struct[i] === ')') depth = Math.max(0, depth - 1);
  }
  depthAt[struct.length] = depth;
  const out: Array<{ index: number; length: number; text: string }> = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(struct)) !== null) {
    if (depthAt[m.index] === 0) out.push({ index: m.index, length: m[0].length, text: m[0] });
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

function splitTopLevel(v: Views, sep: RegExp): Views[] {
  const hits = topLevelMatches(v.struct, sep);
  const parts: Views[] = [];
  let start = 0;
  for (const h of hits) {
    parts.push(slice(v, start, h.index));
    start = h.index + h.length;
  }
  parts.push(slice(v, start, v.text.length));
  return parts;
}

function matchingParen(struct: string, open: number): number {
  let depth = 0;
  for (let i = open; i < struct.length; i++) {
    if (struct[i] === '(') depth++;
    else if (struct[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;

function unquote(id: string): string {
  const t = id.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
}

const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset', 'qualify', 'window',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral', 'on', 'using',
  'as', 'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end',
  'between', 'like', 'ilike', 'distinct', 'all', 'union', 'intersect', 'except', 'with', 'over',
  'partition', 'rows', 'range', 'preceding', 'following', 'unbounded', 'current', 'row', 'asc', 'desc',
  'nulls', 'first', 'last', 'filter', 'interval', 'exists', 'any', 'some', 'cast', 'try_cast',
  'date', 'time', 'timestamp', 'integer', 'int', 'bigint', 'double', 'varchar', 'boolean', 'decimal',
  'numeric', 'real', 'float', 'text', 'smallint', 'tinyint', 'hugeint', 'year', 'month', 'day',
  'hour', 'minute', 'second', 'values', 'recursive', 'materialized', 'escape', 'similar', 'glob',
]);

// ─── The query model ─────────────────────────────────────────────────────────

type Relation =
  | { kind: 'table'; name: string }
  | { kind: 'query'; query: Query };

interface SelectItem {
  /** Output name; null for a star. */
  name: string | null;
  expr: Views;
  /** `*` or `x.*`: qualifier (lower-case) or '' for a bare star. */
  star?: string;
}

interface SelectCore {
  items: SelectItem[];
  /** lower-case alias / name → relation. */
  relations: Map<string, Relation>;
  /** The relations in FROM order (for bare stars and bare identifiers). */
  ordered: Relation[];
}

interface Query {
  branches: SelectCore[];
}

const MAX_DEPTH = 12;

function parseQuery(v: Views, ctes: Map<string, Query>, depth: number): Query | null {
  if (depth > MAX_DEPTH) return null;
  let body = v;
  // Leading parens around the whole statement: `(SELECT …)`.
  for (;;) {
    const lead = body.struct.search(/\S/);
    if (lead === -1) return null;
    if (body.struct[lead] !== '(') break;
    const close = matchingParen(body.struct, lead);
    if (close === -1 || body.struct.slice(close + 1).trim() !== '') break;
    body = slice(body, lead + 1, close);
  }

  // WITH …: parse each CTE in order; later ones may read earlier ones.
  const scope = new Map(ctes);
  const withM = /^\s*with\s+(?:recursive\s+)?/i.exec(body.struct);
  if (withM) {
    let pos = withM[0].length;
    for (;;) {
      const rest = body.struct.slice(pos);
      const head = new RegExp(`^\\s*(${IDENT})\\s*(\\([^)]*\\))?\\s*as\\s+(?:not\\s+)?(?:materialized\\s+)?\\(`, 'i').exec(
        body.text.slice(pos),
      );
      if (!head || !/^\s*\S/.test(rest)) return null;
      const open = pos + head[0].length - 1;
      const close = matchingParen(body.struct, open);
      if (close === -1) return null;
      const name = unquote(head[1]).toLowerCase();
      const cte = parseQuery(slice(body, open + 1, close), scope, depth + 1);
      if (cte) {
        // A column list after the name renames the CTE's outputs.
        if (head[2]) {
          const names = head[2].slice(1, -1).split(',').map((s) => unquote(s));
          for (const br of cte.branches) {
            br.items.forEach((it, idx) => { if (names[idx] && !it.star) it.name = names[idx]; });
          }
        }
        scope.set(name, cte);
      }
      pos = close + 1;
      const next = /^\s*,/.exec(body.struct.slice(pos));
      if (next) { pos += next[0].length; continue; }
      break;
    }
    body = slice(body, pos, body.text.length);
  }

  const branchViews = splitTopLevel(body, /\b(?:union|intersect|except)(?:\s+(?:all|distinct|by\s+name))?\b/i);
  const branches: SelectCore[] = [];
  for (const b of branchViews) {
    const core = parseSelectCore(b, scope, depth);
    if (!core) return null;
    branches.push(core);
  }
  return branches.length ? { branches } : null;
}

function parseSelectCore(v: Views, ctes: Map<string, Query>, depth: number): SelectCore | null {
  let body = v;
  const lead = body.struct.search(/\S/);
  if (lead !== -1 && body.struct[lead] === '(') {
    const close = matchingParen(body.struct, lead);
    if (close !== -1 && body.struct.slice(close + 1).trim() === '') {
      const inner = parseQuery(slice(body, lead + 1, close), ctes, depth + 1);
      return inner?.branches[0] ?? null;
    }
  }
  const sel = /^\s*select\s+(?:distinct\s+on\s*\([^)]*\)\s*|distinct\s+|all\s+)?/i.exec(body.struct);
  if (!sel) return null;
  const afterSelect = sel[0].length;
  const rest = slice(body, afterSelect, body.text.length);
  const fromHit = topLevelMatches(rest.struct, /\bfrom\b/i)[0];
  const listEnd = fromHit ? fromHit.index : rest.text.length;
  const list = slice(rest, 0, listEnd);

  const relations = new Map<string, Relation>();
  const ordered: Relation[] = [];
  if (fromHit) {
    const fromBody = slice(rest, fromHit.index + fromHit.length, rest.text.length);
    const stop = topLevelMatches(
      fromBody.struct,
      /\b(?:where|group\s+by|having|qualify|window|order\s+by|limit|offset)\b/i,
    )[0];
    parseFromClause(slice(fromBody, 0, stop ? stop.index : fromBody.text.length), ctes, depth, relations, ordered);
  }

  const items: SelectItem[] = [];
  for (const raw of splitTopLevel(list, /,/)) {
    const item = parseSelectItem(raw);
    if (item) items.push(item);
  }
  return { items, relations, ordered };
}

function parseFromClause(
  v: Views,
  ctes: Map<string, Query>,
  depth: number,
  relations: Map<string, Relation>,
  ordered: Relation[],
): void {
  // Split the FROM clause into relation segments at top-level JOIN keywords
  // and commas; each segment starts with a relation, then optional alias,
  // then (for joins) ON / USING which we ignore.
  const segments = splitTopLevel(
    v,
    /,|\b(?:(?:natural\s+)?(?:left|right|full|inner|cross|anti|semi|positional|asof)?\s*(?:outer\s+)?join)\b/i,
  );
  for (const seg of segments) {
    const s = seg.struct;
    const start = s.search(/\S/);
    if (start === -1) continue;
    let rel: Relation | null = null;
    let after = start;
    let defaultAlias: string | null = null;
    if (s[start] === '(') {
      const close = matchingParen(s, start);
      if (close === -1) continue;
      const q = parseQuery(slice(seg, start + 1, close), ctes, depth + 1);
      if (q) rel = { kind: 'query', query: q };
      after = close + 1;
    } else {
      const m = new RegExp(`^(?:${IDENT}\\s*\\.\\s*)*(${IDENT})`).exec(seg.text.slice(start));
      if (!m) continue;
      const name = unquote(m[1]);
      after = start + m[0].length;
      const cte = ctes.get(name.toLowerCase());
      rel = cte ? { kind: 'query', query: cte } : { kind: 'table', name };
      defaultAlias = name.toLowerCase();
      // A table function (`read_parquet(…)`, `generate_series(…)`) is not a
      // relation we can follow.
      if (/^\s*\(/.test(s.slice(after))) {
        const close = matchingParen(s, s.indexOf('(', after));
        rel = null;
        after = close === -1 ? s.length : close + 1;
        defaultAlias = null;
      }
    }
    const aliasM = new RegExp(`^\\s*(?:as\\s+)?(${IDENT})`, 'i').exec(seg.text.slice(after));
    let alias: string | null = null;
    if (aliasM && !KEYWORDS.has(unquote(aliasM[1]).toLowerCase())) alias = unquote(aliasM[1]).toLowerCase();
    if (!rel) continue;
    ordered.push(rel);
    if (defaultAlias) relations.set(defaultAlias, rel);
    if (alias) relations.set(alias, rel);
  }
}

function parseSelectItem(raw: Views): SelectItem | null {
  const t = raw.text.trim();
  if (!t) return null;
  const off = raw.text.indexOf(t);
  const v = slice(raw, off, off + t.length);

  const star = new RegExp(`^(?:(${IDENT})\\s*\\.\\s*)?\\*\\s*(?:exclude\\s*\\(|replace\\s*\\(|$)`, 'i').exec(v.text);
  if (star) return { name: null, expr: v, star: star[1] ? unquote(star[1]).toLowerCase() : '' };

  // `expr AS name` — the last top-level AS.
  const asHits = topLevelMatches(v.struct, new RegExp(`\\bas\\s+${IDENT}\\s*$`, 'i'));
  if (asHits.length) {
    const h = asHits[asHits.length - 1];
    const nameText = v.text.slice(h.index).replace(/^as\s+/i, '');
    return { name: unquote(nameText), expr: slice(v, 0, h.index) };
  }
  // `expr alias` without AS.
  const implicit = new RegExp(`^([\\s\\S]*?[\\w")\\]])\\s+(${IDENT})\\s*$`).exec(v.text);
  if (implicit) {
    const alias = unquote(implicit[2]);
    const exprText = implicit[1];
    const prevTok = /(\w+)\s*$/.exec(exprText)?.[1]?.toLowerCase();
    if (!KEYWORDS.has(alias.toLowerCase()) && prevTok !== 'end' && !/::\s*$/.test(exprText)) {
      // Only when the expression part is itself balanced — the alias must sit
      // at depth 0, never inside a CAST( … AS type ) or a function call.
      const exprStruct = v.struct.slice(0, exprText.length);
      const opens = (exprStruct.match(/\(/g) ?? []).length;
      const closes = (exprStruct.match(/\)/g) ?? []).length;
      if (opens === closes && !/\b(?:case|cast|try_cast)\b[^)]*$/i.test(exprStruct)) {
        return { name: alias, expr: slice(v, 0, exprText.length) };
      }
    }
  }
  // Plain `x.col` or `col`.
  const plain = new RegExp(`^(?:${IDENT}\\s*\\.\\s*)*(${IDENT})$`).exec(v.text);
  if (plain) return { name: unquote(plain[1]), expr: v };
  // An unnamed expression: DuckDB would name it after its text — no one
  // can reference it by that, so it has no lineage worth recording.
  return { name: null, expr: v };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

interface Resolved {
  refs: ColumnSourceRef[];
  transformation: string | null;
}

function outputNames(q: Query, catalog: SourceCatalog, depth: number): string[] {
  const b = q.branches[0];
  const out: string[] = [];
  for (const it of b.items) {
    if (it.star !== undefined) out.push(...expandStar(b, it.star, catalog, depth).map((e) => e.name));
    else if (it.name) out.push(it.name);
  }
  return out;
}

function relationColumns(rel: Relation, catalog: SourceCatalog, depth: number): string[] | null {
  if (rel.kind === 'query') return depth > MAX_DEPTH ? null : outputNames(rel.query, catalog, depth + 1);
  const t = catalog.get(rel.name.toLowerCase());
  return t?.columns ? [...t.columns.values()] : null;
}

function expandStar(core: SelectCore, qualifier: string, catalog: SourceCatalog, depth: number): Array<{ name: string; rel: Relation }> {
  const rels = qualifier ? [core.relations.get(qualifier)].filter((r): r is Relation => !!r) : core.ordered;
  const out: Array<{ name: string; rel: Relation }> = [];
  for (const rel of rels) {
    for (const name of relationColumns(rel, catalog, depth) ?? []) out.push({ name, rel });
  }
  return out;
}

function resolveInRelation(rel: Relation, column: string, catalog: SourceCatalog, depth: number): Resolved {
  if (depth > MAX_DEPTH) return { refs: [], transformation: null };
  if (rel.kind === 'table') {
    const t = catalog.get(rel.name.toLowerCase());
    if (!t) return { refs: [], transformation: null };
    const canonical = t.columns?.get(column.toLowerCase());
    if (t.columns && !canonical) return { refs: [], transformation: null };
    if (column.startsWith('_')) return { refs: [], transformation: null };
    return { refs: [{ table: t.name, column: canonical ?? column }], transformation: null };
  }
  return resolveOutput(rel.query, column, catalog, depth + 1);
}

/** The lineage of output `column` of `q`, merged across union branches. */
function resolveOutput(q: Query, column: string, catalog: SourceCatalog, depth: number): Resolved {
  const target = column.toLowerCase();
  const first = q.branches[0];
  // Position of the column in branch 0 (unions line up by position).
  let position = -1;
  let idx = 0;
  const flat: Array<{ core: SelectCore; item: SelectItem; starRel?: Relation; starName?: string }>[] = [];
  for (const core of q.branches) {
    const list: Array<{ core: SelectCore; item: SelectItem; starRel?: Relation; starName?: string }> = [];
    for (const item of core.items) {
      if (item.star !== undefined) {
        for (const e of expandStar(core, item.star, catalog, depth)) list.push({ core, item, starRel: e.rel, starName: e.name });
      } else {
        list.push({ core, item });
      }
    }
    flat.push(list);
  }
  for (const entry of flat[0] ?? []) {
    const name = entry.starName ?? entry.item.name;
    if (name && name.toLowerCase() === target) { position = idx; }
    idx++;
  }
  if (position === -1 || !first) return { refs: [], transformation: null };

  const refs: ColumnSourceRef[] = [];
  let transformation: string | null = null;
  for (const list of flat) {
    const entry = list[position];
    if (!entry) continue;
    const r = entry.starRel
      ? resolveInRelation(entry.starRel, entry.starName!, catalog, depth)
      : resolveExpression(entry.core, entry.item.expr, catalog, depth);
    for (const ref of r.refs) {
      if (!refs.some((x) => x.table === ref.table && x.column === ref.column)) refs.push(ref);
    }
    if (transformation == null && r.transformation != null) transformation = r.transformation;
  }
  return { refs, transformation };
}

/** Is `expr` nothing but one column reference (`x.col`, `"col"`, `col`)? */
function isPlainReference(expr: string): boolean {
  return new RegExp(`^\\s*(?:${IDENT}\\s*\\.\\s*)?${IDENT}\\s*$`).test(expr);
}

function resolveExpression(core: SelectCore, expr: Views, catalog: SourceCatalog, depth: number): Resolved {
  const refs: ColumnSourceRef[] = [];
  let innerTransformation: string | null = null;
  const add = (r: Resolved) => {
    for (const ref of r.refs) {
      if (!refs.some((x) => x.table === ref.table && x.column === ref.column)) refs.push(ref);
    }
    if (innerTransformation == null && r.transformation != null) innerTransformation = r.transformation;
  };

  // Qualified references: alias.column (scanned where string literals are
  // blanked; quoted identifiers are kept so "Order Date" reads correctly).
  const qualified = new RegExp(`(${IDENT})\\s*\\.\\s*(${IDENT})(?!\\s*\\()`, 'g');
  const consumed: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = qualified.exec(expr.lits)) !== null) {
    // Skip a match that is the tail of a longer dotted name (schema.table.col).
    const before = expr.lits.slice(0, m.index);
    if (/\.\s*$/.test(before)) continue;
    consumed.push([m.index, m.index + m[0].length]);
    const rel = core.relations.get(unquote(m[1]).toLowerCase());
    if (!rel) continue;
    add(resolveInRelation(rel, unquote(m[2]), catalog, depth));
  }

  // Bare identifiers — only when we can tell which relation owns them.
  const bare = new RegExp(IDENT, 'g');
  while ((m = bare.exec(expr.lits)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (consumed.some(([a, b]) => s >= a && s < b)) continue;
    const name = unquote(m[0]);
    const lower = name.toLowerCase();
    const before = expr.lits.slice(0, s);
    const after = expr.lits.slice(e);
    if (m[0][0] !== '"' && KEYWORDS.has(lower)) continue;
    if (/^\s*\(/.test(after)) continue;                 // a function call
    if (/^\s*\./.test(after) || /\.\s*$/.test(before)) continue;
    if (/\bas\s+$/i.test(before) || /::\s*$/.test(before)) continue; // a type name
    if (/^\d/.test(name)) continue;
    const owners: Relation[] = [];
    for (const rel of core.ordered) {
      const cols = relationColumns(rel, catalog, depth);
      if (cols ? cols.some((c) => c.toLowerCase() === lower) : false) owners.push(rel);
    }
    let owner: Relation | null = owners.length === 1 ? owners[0] : null;
    // One relation whose columns we do not know, and the expression is that
    // identifier alone: it can only be that relation's column.
    if (!owner && owners.length === 0 && core.ordered.length === 1
        && relationColumns(core.ordered[0], catalog, depth) == null && isPlainReference(expr.text)) {
      owner = core.ordered[0];
    }
    if (owner) add(resolveInRelation(owner, name, catalog, depth));
  }

  const own = expr.text.trim();
  const transformation = isPlainReference(own) ? innerTransformation : own.replace(/\s+/g, ' ');
  return { refs: refs.slice(0, 12), transformation };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Lineage for every named output column of `sql`, following CTEs,
 * subqueries, stars and unions back to the tables in `catalog`.
 * `parsed: false` means the SQL did not read as a SELECT — callers fall
 * back to whatever lineage they stored.
 */
export function deriveSqlLineage(sql: string | null | undefined, catalog: SourceCatalog): SqlLineageResult {
  const columns = new Map<string, DerivedColumnLineage>();
  if (!sql || !sql.trim()) return { parsed: false, columns };
  let q: Query | null = null;
  try {
    q = parseQuery(views(blankComments(sql).replace(/;\s*$/, '')), new Map(), 0);
  } catch {
    q = null;
  }
  if (!q) return { parsed: false, columns };
  let names: string[];
  try {
    names = outputNames(q, catalog, 0);
  } catch {
    return { parsed: false, columns };
  }
  for (const name of names) {
    const key = name.toLowerCase();
    if (columns.has(key)) continue;
    const r = resolveOutput(q, name, catalog, 0);
    columns.set(key, { name, refs: r.refs, transformation: r.transformation });
  }
  return { parsed: true, columns };
}
