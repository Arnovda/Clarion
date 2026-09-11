/**
 * Page SQL, built once for every SQL dialect.
 *
 * The three dialects differ only in how they quote identifiers, spell bound
 * parameters and limit rows. The ORDER BY, the keyset predicate and the
 * boundary rule are identical, so they live here — a pagination bug fixed for
 * Postgres is fixed for SQL Server on the same line.
 *
 * THE BOUNDARY RULE (playbook Phase D.1). The incremental filter is `>=`, not
 * `>`. A timestamp cursor usually has second or millisecond precision, so two
 * rows can share the exact value the last run stopped at; `>` would skip the
 * ones that lost the race. Re-reading them is free because the warehouse
 * writer merges by business key, so a re-pulled row replaces itself. The
 * cursor only ADVANCES on a strictly-greater value — that half is the engine's
 * job (`syncEngine.ts`), and together they make the sync idempotent at the
 * boundary instead of lossy.
 *
 * THE KEYSET PREDICATE. `(cursor, key) > (lastCursor, lastKey)` is written out
 * as `cursor > ? OR (cursor = ? AND key > ?)` rather than as a row-value
 * comparison. Postgres and MySQL support the tuple form; SQL Server does not,
 * and one shape everywhere is worth more than a marginally shorter query on
 * two of three dialects.
 *
 * Keyset paging rather than OFFSET is what makes a large table safe to read:
 * OFFSET re-scans and re-sorts everything it skips, so page 10,000 of a 3M-row
 * table costs far more than page 1, and a row inserted mid-sync shifts every
 * later page — silently duplicating and skipping rows.
 */

import type { PageQueryArgs, KeyPageQueryArgs, SqlQuery } from './types';

/** The dialect-specific spellings the builder needs. */
export interface SqlSyntax {
  quoteIdent(name: string): string;
  /** Placeholder for the i-th (1-based) bound parameter: `$1`, `?`, `@p1`. */
  placeholder(i: number): string;
  /**
   * `limit`  — `… LIMIT n [OFFSET m]` (Postgres, MySQL)
   * `fetch`  — `… ORDER BY … OFFSET m ROWS FETCH NEXT n ROWS ONLY` (SQL Server),
   *            which REQUIRES an ORDER BY, hence the `(SELECT NULL)` fallback.
   */
  limitStyle: 'limit' | 'fetch';
}

/** Fully-qualified, quoted table reference. */
export function qualify(syntax: SqlSyntax, schema: string, table: string): string {
  return `${syntax.quoteIdent(schema)}.${syntax.quoteIdent(table)}`;
}

export function buildPageQuery(syntax: SqlSyntax, args: PageQueryArgs): SqlQuery {
  const params: unknown[] = [];
  const ph = (): string => syntax.placeholder(params.length);   // called after push

  const select = args.columns.map((c) => syntax.quoteIdent(c)).join(', ');
  const from = qualify(syntax, args.schema, args.table);
  const where: string[] = [];
  let orderBy: string[];
  let offset = 0;

  const plan = args.plan;
  if (plan.mode === 'keyset-cursor') {
    const cursor = syntax.quoteIdent(plan.cursorColumn);
    const key = syntax.quoteIdent(plan.keyColumn);

    // Inclusive lower bound — the boundary rule above.
    if (plan.lowerBound !== undefined) {
      params.push(plan.lowerBound);
      where.push(`${cursor} >= ${ph()}`);
    }
    if (plan.after) {
      params.push(plan.after.cursor);
      const a = ph();
      params.push(plan.after.cursor);
      const b = ph();
      params.push(plan.after.key);
      const c = ph();
      where.push(`(${cursor} > ${a} OR (${cursor} = ${b} AND ${key} > ${c}))`);
    }
    orderBy = [`${cursor} ASC`, `${key} ASC`];
  } else if (plan.mode === 'keyset-key') {
    const key = syntax.quoteIdent(plan.keyColumn);
    if (plan.after !== undefined) {
      params.push(plan.after);
      where.push(`${key} > ${ph()}`);
    }
    orderBy = [`${key} ASC`];
  } else {
    orderBy = plan.orderBy.map((c) => `${syntax.quoteIdent(c)} ASC`);
    offset = plan.offset;
  }

  const parts = [`SELECT ${select}`, `FROM ${from}`];
  if (where.length > 0) parts.push(`WHERE ${where.join(' AND ')}`);
  parts.push(orderClause(syntax, orderBy));
  parts.push(limitClause(syntax, args.limit, offset));
  return { sql: parts.filter(Boolean).join(' '), params };
}

/** `SELECT <key>` only — reconcile's cheap listing. Always keyset-paged. */
export function buildKeyPageQuery(syntax: SqlSyntax, args: KeyPageQueryArgs): SqlQuery {
  const params: unknown[] = [];
  const key = syntax.quoteIdent(args.keyColumn);
  const where: string[] = [];
  if (args.after !== undefined) {
    params.push(args.after);
    where.push(`${key} > ${syntax.placeholder(params.length)}`);
  }
  const parts = [
    `SELECT ${key}`,
    `FROM ${qualify(syntax, args.schema, args.table)}`,
    ...(where.length > 0 ? [`WHERE ${where.join(' AND ')}`] : []),
    orderClause(syntax, [`${key} ASC`]),
    limitClause(syntax, args.limit, 0),
  ];
  return { sql: parts.filter(Boolean).join(' '), params };
}

function orderClause(syntax: SqlSyntax, cols: readonly string[]): string {
  if (cols.length > 0) return `ORDER BY ${cols.join(', ')}`;
  // SQL Server's OFFSET/FETCH is only legal after an ORDER BY, and a table
  // with nothing stable to order by still has to be readable.
  return syntax.limitStyle === 'fetch' ? 'ORDER BY (SELECT NULL)' : '';
}

function limitClause(syntax: SqlSyntax, limit: number, offset: number): string {
  const n = Math.max(1, Math.trunc(limit));
  const off = Math.max(0, Math.trunc(offset));
  if (syntax.limitStyle === 'fetch') {
    return `OFFSET ${off} ROWS FETCH NEXT ${n} ROWS ONLY`;
  }
  return off > 0 ? `LIMIT ${n} OFFSET ${off}` : `LIMIT ${n}`;
}
