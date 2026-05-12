/**
 * Client-side SQL rewriters for the DuckDB-WASM "Fast mode" path.
 *
 * Mirrors the backend's `resolveWidgetFilters` (in routes/dashboards.ts)
 * and `injectCrossFilter` (same file) verbatim so the WASM path produces
 * the same SQL the server would have produced. Duplicating the logic
 * here is deliberate — eliminates a server round-trip just to rewrite a
 * filter clause. Phase 5b should extract these into a shared package
 * if the WASM path proves out.
 *
 * Any change to the server-side rewriters MUST be mirrored here, and
 * vice versa. Tests would help; for now the rewriters are simple
 * enough to inspect side-by-side.
 */

/**
 * Substitute filter placeholders. `{{date_from}}` → `2024-01-01`, etc.
 * Unsubstituted placeholders get safe defaults:
 *   - `_from` → 1900-01-01
 *   - `_to`   → 2099-12-31
 *   - others  → 'all' (so widget SQLs of the form
 *               `('{{x}}' = 'all' OR col = '{{x}}')` no-op safely)
 */
export function resolveFilters(sql: string, filterValues: Record<string, string>): string {
  let resolved = sql;
  for (const [key, value] of Object.entries(filterValues)) {
    const replacement = value || (key.endsWith('_from') ? '1900-01-01' : key.endsWith('_to') ? '2099-12-31' : 'all');
    resolved = resolved.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), replacement);
  }
  return resolved
    .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
    .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
    .replace(/\{\{[^}]+\}\}/g, 'all');
}

/**
 * Inject an `AND <dimension> = '<value>'` clause into a widget's SQL
 * to apply a cross-filter. Same logic as the server's injectCrossFilter.
 * Returns the SQL unchanged when we can't safely rewrite (CTEs, no
 * top-level FROM).
 */
export function injectCrossFilter(sql: string, dimension: string, value: string): string {
  if (!sql || !dimension) return sql;
  if (/^\s*WITH\s+/i.test(sql)) return sql;

  const fromMatch = sql.match(/\bFROM\b/i);
  if (!fromMatch || fromMatch.index == null) return sql;

  const safeKey = dimension.replace(/[^a-zA-Z0-9_."`\[\]]/g, '');
  if (!safeKey) return sql;
  const escapedValue = String(value).replace(/'/g, "''");
  const filterClause = `${safeKey} = '${escapedValue}'`;

  const boundaryRe = /\s+(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT)\b/i;
  const tail = sql.slice(fromMatch.index);
  const whereInTail = tail.match(/\bWHERE\b/i);

  if (whereInTail && whereInTail.index != null) {
    const boundaryInTail = tail.match(boundaryRe);
    if (boundaryInTail && boundaryInTail.index != null) {
      const splitPoint = fromMatch.index + boundaryInTail.index;
      return sql.slice(0, splitPoint) + ` AND ${filterClause}` + sql.slice(splitPoint);
    }
    return sql.trimEnd() + ` AND ${filterClause}`;
  }

  const boundaryInTail = tail.match(boundaryRe);
  if (boundaryInTail && boundaryInTail.index != null) {
    const splitPoint = fromMatch.index + boundaryInTail.index;
    return sql.slice(0, splitPoint) + ` WHERE ${filterClause}` + sql.slice(splitPoint);
  }
  return sql.trimEnd() + ` WHERE ${filterClause}`;
}
