/**
 * sqlProvenance — read the FROM / JOIN relations out of a transformation.
 *
 * Manage mode's "How it's built" card shows a provenance trail: the physical
 * source relation, then one chip per lens the table joins to. That trail is
 * derived from the SQL rather than from `product_relationships` on purpose —
 * relationship rows are curated metadata that can lag the SQL, and the trail
 * has to describe what the table ACTUALLY reads or it is worse than absent.
 *
 * This is a lexer-lite, not a SQL parser. It strips comments and string
 * literals first (so `-- from x` and `'... join ...'` can't produce phantom
 * relations), then matches identifiers after FROM/JOIN at any nesting level.
 * A subquery's `from` is a real read, so counting it is correct; the only
 * thing deliberately dropped is a CTE name, which names an alias defined in
 * the same statement rather than a stored relation.
 */

export interface Provenance {
  /** First relation read — the source the table is built from. */
  from: string | null;
  /** Every joined relation, in order, de-duplicated. */
  joins: string[];
}

const EMPTY: Provenance = { from: null, joins: [] };

/** Remove line comments, block comments and string literals. */
function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Names defined by `WITH x AS (…)` in this statement — aliases, not relations. */
function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const withMatch = /\bwith\b([\s\S]*)/i.exec(sql);
  if (!withMatch) return names;
  const re = /(?:\bwith\b|,)\s*([a-z_][a-z0-9_$]*)\s+as\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) names.add(m[1].toLowerCase());
  return names;
}

/** Unquote and normalise an identifier: `"Sales"."Lines"` → `Sales.Lines`. */
function cleanIdentifier(raw: string): string {
  return raw.replace(/["`\[\]]/g, '').trim();
}

export function extractProvenance(sql: string | null | undefined): Provenance {
  if (!sql || !sql.trim()) return EMPTY;
  const clean = strip(sql);
  const ctes = cteNames(clean);

  // An identifier may be schema-qualified and may be quoted on either part.
  const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[a-z_][a-z0-9_$]*)';
  const RELATION = `${IDENT}(?:\\.${IDENT})*`;

  const fromRe = new RegExp(`\\bfrom\\s+(${RELATION})`, 'gi');
  const joinRe = new RegExp(`\\bjoin\\s+(${RELATION})`, 'gi');

  let from: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(clean)) !== null) {
    const name = cleanIdentifier(m[1]);
    if (ctes.has(name.toLowerCase())) continue;
    from = name;
    break;
  }

  const joins: string[] = [];
  const seen = new Set<string>();
  while ((m = joinRe.exec(clean)) !== null) {
    const name = cleanIdentifier(m[1]);
    const key = name.toLowerCase();
    if (ctes.has(key) || seen.has(key)) continue;
    seen.add(key);
    joins.push(name);
  }

  return { from, joins };
}

/**
 * Join a list into an English clause: ["a"] → "a", ["a","b"] → "a and b",
 * ["a","b","c"] → "a, b and c". Used by the fallback summary sentence.
 */
export function englishList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
