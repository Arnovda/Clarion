/**
 * lineageDerivation — column-level lineage derived from the transformation
 * SQL itself, deterministically, at build time.
 *
 * Why this exists: the bus-matrix prompt tells the model to OMIT lineage[]
 * for trivial columns (a sound token rule — most columns are passthroughs),
 * which left AI-built topics with almost no column_lineage rows and the
 * "Where it comes from" view empty. But a passthrough's lineage is not
 * unknowable — `s.ItemCode` names its source table and column EXACTLY, no
 * model required. So the builder now derives what the design didn't spell
 * out: parse the table's FROM/JOIN clauses into an alias→table map, scan
 * each column's transformation_expression for qualified references, and
 * write the rows.
 *
 * Correctness guards, each load-bearing:
 *  - Only tables in the design's declared `source_tables` may appear as a
 *    lineage source. Fact SQL joins DIMENSION tables to fetch surrogate
 *    keys — a `d.item_key` reference must NOT become a column_lineage row,
 *    because `source_table_name` means a SOURCE-layer table and an
 *    unresolvable name renders as "no longer in the catalog" in the UI.
 *  - CTE names are excluded from the alias map: a reference through a CTE
 *    cannot be attributed to a physical table without walking the CTE body,
 *    and a wrong attribution is worse than none (v1 skips them).
 *  - Comments and string literals are stripped before parsing, so a table
 *    name inside a comment or a literal can never mint an alias.
 *
 * Pure module, no imports — unit-tested without a DB, same pattern as
 * fkVerification and matchMeasure.
 */

export interface DerivedLineage {
  source_table_name: string;
  source_column_name: string;
  transformation_description: string | null;
}

const RESERVED = new Set([
  'on', 'where', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join',
  'group', 'order', 'limit', 'using', 'lateral', 'as', 'select', 'union',
  'natural', 'having', 'qualify', 'window', 'and', 'or', 'not',
]);

/** Remove SQL comments and string literals so they can't mint aliases. */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * alias → table name from every FROM/JOIN clause. The table's own name maps
 * to itself, so unaliased qualified references (`Items.Code`) resolve too.
 */
export function parseAliasMap(sql: string): Map<string, string> {
  const clean = stripSqlNoise(sql);

  // CTE names: `WITH a AS (...), b AS (...)` — anything defined this way is
  // not a physical table and must not be attributable.
  const cteNames = new Set<string>();
  for (const m of clean.matchAll(/(?:\bwith\s+|,\s*)("?)([A-Za-z_]\w*)\1\s+as\s*\(/gi)) {
    cteNames.add(m[2].toLowerCase());
  }

  const map = new Map<string, string>();
  for (const m of clean.matchAll(
    /\b(?:from|join)\s+("?)([A-Za-z_][\w]*)\1(?:\s+(?:as\s+)?("?)([A-Za-z_]\w*)\3)?/gi,
  )) {
    const table = m[2];
    if (cteNames.has(table.toLowerCase())) continue;
    const alias = m[4];
    map.set(table.toLowerCase(), table);
    if (alias && !RESERVED.has(alias.toLowerCase())) {
      map.set(alias.toLowerCase(), table);
    }
  }
  return map;
}

const QUALIFIED_REF = /("?)([A-Za-z_]\w*)\1\s*\.\s*("?)([A-Za-z_]\w*)\3/g;
const BARE_IDENTIFIER = /^\s*"?([A-Za-z_]\w*)"?\s*$/;

/**
 * Derive the lineage of ONE column from its transformation expression.
 *
 * `allowedTables` is the design's declared source_tables for the table —
 * the only names permitted as lineage sources (see module header).
 * `soleSource` covers the unqualified case: when the table reads exactly
 * one source, a bare `ItemCode` can only mean that source's column.
 */
export function deriveColumnLineage(
  expression: string | null | undefined,
  aliasMap: ReadonlyMap<string, string>,
  allowedTables: ReadonlySet<string>,
  soleSource?: string,
): DerivedLineage[] {
  if (!expression) return [];
  const expr = stripSqlNoise(expression);

  const refs: Array<{ table: string; column: string }> = [];
  for (const m of expr.matchAll(QUALIFIED_REF)) {
    const table = aliasMap.get(m[2].toLowerCase());
    if (!table || !allowedTables.has(table)) continue;
    refs.push({ table, column: m[4] });
  }

  if (refs.length === 0 && soleSource && allowedTables.has(soleSource)) {
    const bare = BARE_IDENTIFIER.exec(expr);
    if (bare && !RESERVED.has(bare[1].toLowerCase())) {
      refs.push({ table: soleSource, column: bare[1] });
    }
  }

  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    if (r.column.startsWith('_')) return false;
    const key = `${r.table}|${r.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);

  // A single reference that IS the whole expression (modulo an alias
  // qualifier and quoting) is a plain copy — say so in words. Anything
  // else gets no description: the lineage endpoint falls back to showing
  // the expression itself, which is the honest rendering of a transform.
  const isPlainCopy = unique.length === 1
    && new RegExp(`^\\s*(?:"?[A-Za-z_]\\w*"?\\s*\\.\\s*)?"?${unique[0].column}"?\\s*$`, 'i').test(expr);

  return unique.map((r) => ({
    source_table_name: r.table,
    source_column_name: r.column,
    transformation_description: isPlainCopy ? 'Copied as-is' : null,
  }));
}
