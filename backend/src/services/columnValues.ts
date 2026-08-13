/**
 * The distinct values of both sides of a relationship, for a human to compare.
 *
 * The measurement answers *how much* overlaps. This answers *what the values
 * actually look like*, which is the only thing that tells you WHY they do not:
 * a formatting difference you can fix, a column of GUIDs against a column of
 * codes, or a parent that genuinely is not there. Five samples are enough to
 * form a suspicion; settling it means reading down both columns.
 *
 * ---
 *
 * **THE WINDOWS MUST COVER THE SAME RANGE. This is the whole correctness
 * problem here, and the first version got it wrong.**
 *
 * Taking the first N values of each side independently and then setting them
 * next to each other compares two different slices of the value space the
 * moment either side is truncated. Measured in production:
 * `Payments.TransactionID` (218 GUIDs, all late in the alphabet) against
 * `TransactionLines.ID` (2,589 values, of which the first 300 are all early in
 * the alphabet). Containment was a true 100% — every payment does reference a
 * real transaction line — while the side-by-side view showed 30 shared and 458
 * one-sided, i.e. it reported a catastrophic mismatch that did not exist.
 *
 * That is the same defect shape as the 2026-08-03 detector bug: a numerator
 * from one sample and a denominator from another. Two fixes, both required:
 *
 *   • **`matched` is computed against the WHOLE right column**, never against
 *     the fetched window, so the headline count always agrees with the check.
 *   • **The right side is fetched within the left window's range**, so the two
 *     columns on screen describe the same stretch of the value space and the
 *     gaps between them mean something.
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

/** One value of the child column, and whether it exists in the parent at all. */
export interface LeftValue {
  v: string;
  matched: boolean;
}

export interface ValueComparison {
  ok: boolean;
  reason: 'ok' | 'timeout' | 'query-failed';
  left: {
    table: string;
    column: string;
    values: LeftValue[];
    /** True distinct count of the column, so the cap is stated not implied. */
    distinct: number;
    truncated: boolean;
  } | null;
  right: {
    table: string;
    column: string;
    values: string[];
    distinct: number;
    truncated: boolean;
    /**
     * True when the right side was narrowed to the left window's range. The UI
     * must say so — otherwise its list looks like the whole column.
     */
    rangeLimited: boolean;
  } | null;
  limit: number;
}

export interface QueryableConnector {
  executeQuery(sql: string): Promise<{ rows: unknown[] }>;
}

/**
 * `matched` is an EXISTS over the entire parent column, not over the window
 * below it. A value can be absent from the fetched 300 and still exist in the
 * table, and calling that "not found" is the exact lie this file exists to
 * avoid.
 */
function valuesSql(
  leftTable: string, leftColumn: string, rightTable: string, rightColumn: string,
): string {
  return `WITH l AS (
      SELECT DISTINCT CAST("${leftColumn}" AS TEXT) AS v
      FROM "${leftTable}" WHERE "${leftColumn}" IS NOT NULL
      ORDER BY 1 LIMIT ${VALUE_LIMIT}
    ),
    bounds AS (SELECT MIN(v) AS lo, MAX(v) AS hi FROM l)
    SELECT 'l' AS side, l.v AS v,
           EXISTS (SELECT 1 FROM "${rightTable}" t
                   WHERE CAST(t."${rightColumn}" AS TEXT) = l.v) AS matched
    FROM l
    UNION ALL
    SELECT 'r' AS side, v, TRUE AS matched FROM (
      SELECT DISTINCT CAST("${rightColumn}" AS TEXT) AS v
      FROM "${rightTable}", bounds
      WHERE "${rightColumn}" IS NOT NULL
        AND CAST("${rightColumn}" AS TEXT) >= bounds.lo
        AND CAST("${rightColumn}" AS TEXT) <= bounds.hi
      ORDER BY 1 LIMIT ${VALUE_LIMIT}
    )`;
}

function countsSql(
  leftTable: string, leftColumn: string, rightTable: string, rightColumn: string,
): string {
  return `SELECT
    (SELECT COUNT(DISTINCT CAST("${leftColumn}"  AS TEXT)) FROM "${leftTable}"  WHERE "${leftColumn}"  IS NOT NULL) AS l,
    (SELECT COUNT(DISTINCT CAST("${rightColumn}" AS TEXT)) FROM "${rightTable}" WHERE "${rightColumn}" IS NOT NULL) AS r`;
}

/** Shape the result set. Pure, so the ordering and truncation rules are testable. */
export function shapeSides(
  valueRows: readonly unknown[],
  countRow: Record<string, unknown> | undefined,
  left: { table: string; column: string },
  right: { table: string; column: string },
): NonNullable<Pick<ValueComparison, 'left' | 'right'>> {
  const rows = valueRows as { side?: string; v?: unknown; matched?: unknown }[];
  // Re-sorted here rather than trusted from SQL: the two lists are merged
  // against each other in the UI, and a merge is only correct when both sides
  // use the SAME comparison. The database's collation is not guaranteed to be
  // JavaScript's.
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const leftValues: LeftValue[] = rows
    .filter((r) => r.side === 'l')
    .map((r) => ({ v: String(r.v ?? ''), matched: r.matched === true }))
    .sort((a, b) => byText(a.v, b.v));

  const rightValues = rows
    .filter((r) => r.side === 'r')
    .map((r) => String(r.v ?? ''))
    .sort(byText);

  const leftDistinct = Number(countRow?.l ?? 0);
  const rightDistinct = Number(countRow?.r ?? 0);

  return {
    left: {
      ...left,
      values: leftValues,
      distinct: leftDistinct,
      truncated: leftDistinct > leftValues.length,
    },
    right: {
      ...right,
      values: rightValues,
      distinct: rightDistinct,
      truncated: rightDistinct > rightValues.length,
      // The right list was narrowed to the left window's range whenever it
      // could not have held the whole column anyway.
      rangeLimited: rightDistinct > rightValues.length,
    },
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
