/**
 * The distinct values of both sides of a relationship, for a human to compare.
 *
 * The measurement answers *how much* overlaps. This answers *what the values
 * actually look like*, which is the only thing that tells you WHY they do not:
 * a formatting difference you can fix, a column of GUIDs against a column of
 * codes, or a parent that genuinely is not there. Five samples are enough to
 * form a suspicion; settling it means reading down both columns.
 *
 * Values are compared and ordered **as text**, matching how `verifyFkCandidate`
 * compares them (`CAST(... AS TEXT)`). Ordering a numeric key as text gives
 * 1, 10, 100, 2 — visually odd, but it is the ordering under which the two
 * columns were judged to match or not, and showing a different one would invite
 * exactly the wrong conclusion.
 */

import { assertSafeIdentifier } from './relationshipMeasure';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'columnValues' });

/** Enough to see the shape of a column and scroll it; not a data export. */
export const VALUE_LIMIT = 300;

/** Its own budget: this runs under an open dialog, like every other read here. */
const VALUES_TIMEOUT_MS = Number(process.env.RELATIONSHIP_VALUES_TIMEOUT_MS) || 8000;

export interface ColumnSide {
  table: string;
  column: string;
  /** Distinct non-null values, ascending as text, capped at VALUE_LIMIT. */
  values: string[];
  /** How many distinct values the column really has, so the cap is honest. */
  distinct: number;
}

export interface ValueComparison {
  ok: boolean;
  reason: 'ok' | 'timeout' | 'query-failed';
  left: ColumnSide | null;
  right: ColumnSide | null;
  limit: number;
}

export interface QueryableConnector {
  executeQuery(sql: string): Promise<{ rows: unknown[] }>;
}

function valuesSql(
  leftTable: string, leftColumn: string, rightTable: string, rightColumn: string,
): string {
  const side = (tag: string, table: string, column: string) => `
    SELECT * FROM (
      SELECT '${tag}' AS side, CAST("${column}" AS TEXT) AS v
      FROM "${table}" WHERE "${column}" IS NOT NULL
      GROUP BY 1, 2 ORDER BY 2 LIMIT ${VALUE_LIMIT}
    )`;
  return `${side('l', leftTable, leftColumn)} UNION ALL ${side('r', rightTable, rightColumn)}`;
}

function countsSql(
  leftTable: string, leftColumn: string, rightTable: string, rightColumn: string,
): string {
  return `SELECT
    (SELECT COUNT(DISTINCT CAST("${leftColumn}"  AS TEXT)) FROM "${leftTable}"  WHERE "${leftColumn}"  IS NOT NULL) AS l,
    (SELECT COUNT(DISTINCT CAST("${rightColumn}" AS TEXT)) FROM "${rightTable}" WHERE "${rightColumn}" IS NOT NULL) AS r`;
}

/** Shape the two result sets. Pure, so the ordering rules are testable. */
export function shapeSides(
  valueRows: readonly unknown[],
  countRow: Record<string, unknown> | undefined,
  left: { table: string; column: string },
  right: { table: string; column: string },
): { left: ColumnSide; right: ColumnSide } {
  const take = (tag: string) => valueRows
    .filter((r) => (r as { side?: string }).side === tag)
    .map((r) => String((r as { v?: unknown }).v ?? ''))
    // Re-sorted here rather than trusted from SQL: the two lists are merged
    // against each other in the UI, and a merge is only correct when both
    // sides use the SAME comparison. The database's collation is not
    // guaranteed to be JavaScript's.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    left:  { ...left,  values: take('l'), distinct: Number(countRow?.l ?? 0) },
    right: { ...right, values: take('r'), distinct: Number(countRow?.r ?? 0) },
  };
}

/** Never throws: a failure becomes `ok: false` with a reason the UI can phrase. */
export async function compareColumnValues(
  connector: QueryableConnector,
  leftTable: string, leftColumn: string,
  rightTable: string, rightColumn: string,
): Promise<ValueComparison> {
  const fail = (reason: ValueComparison['reason']): ValueComparison =>
    ({ ok: false, reason, left: null, right: null, limit: VALUE_LIMIT });

  try {
    assertSafeIdentifier(leftTable, 'table name');
    assertSafeIdentifier(leftColumn, 'column name');
    assertSafeIdentifier(rightTable, 'table name');
    assertSafeIdentifier(rightColumn, 'column name');
  } catch (err) {
    log.error({ err }, 'refusing to read values: unsafe identifier');
    return fail('query-failed');
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      const values = await connector.executeQuery(
        valuesSql(leftTable, leftColumn, rightTable, rightColumn),
      );
      const counts = await connector.executeQuery(
        countsSql(leftTable, leftColumn, rightTable, rightColumn),
      );
      return { values: values.rows, counts: counts.rows[0] as Record<string, unknown> | undefined };
    })();
    // Same rejection sink as the measurement: when the budget wins, the route
    // disconnects the connector under a query nobody is listening to.
    work.catch(() => undefined);

    const budget = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), VALUES_TIMEOUT_MS);
    });
    const settled = await Promise.race([work, budget]);
    if (settled === 'timeout') return fail('timeout');

    const { left, right } = shapeSides(
      settled.values, settled.counts,
      { table: leftTable, column: leftColumn },
      { table: rightTable, column: rightColumn },
    );
    return { ok: true, reason: 'ok', left, right, limit: VALUE_LIMIT };
  } catch (err) {
    log.warn({ err, leftTable, leftColumn }, 'could not read column values');
    return fail('query-failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
