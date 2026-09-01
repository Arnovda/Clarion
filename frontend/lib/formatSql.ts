/**
 * Pretty-print SQL — one copy, used everywhere SQL is shown to a person.
 *
 * There were four of these. This one (DuckDB dialect, upper keywords) came
 * from app/query/utils.ts; the others were a naive regex that inserted a
 * newline before every keyword — including keywords inside string literals,
 * which silently corrupts the query on screen — and a bare `format()` call
 * with no guard, which throws inside a render when the SQL does not parse.
 *
 * Never throws: unparseable input comes back verbatim. A provenance panel
 * showing awkward SQL is a small problem; one that blanks the page is not.
 */
import { format as sqlFormat } from 'sql-formatter';

export function formatSql(raw: string): string {
  if (!raw) return '';
  try {
    return sqlFormat(raw, {
      language: 'duckdb',
      keywordCase: 'upper',
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
  } catch {
    return raw;
  }
}
