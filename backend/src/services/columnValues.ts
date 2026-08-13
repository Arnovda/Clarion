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
 * **THE TWO LISTS ARE INDEPENDENT, AND EVERY COUNT COMES FROM `matched`.**
 *
 * An earlier version interleaved them so equal values shared a row. That was
 * wrong twice over, and both mistakes are worth remembering:
 *
 *   1. It derived "how many are on both sides" from the merge, over two windows
 *      fetched independently. `Payments.TransactionID` (218 GUIDs, all late in
 *      the alphabet) against the first 300 of `TransactionLines.ID` (2,589, all
 *      early) reported 458 one-sided values on a relationship measuring a true
 *      100% — the same defect shape as the 2026-08-03 detector bug, a numerator
 *      from one sample and a denominator from another.
 *   2. Even once the counts were fixed, the alignment earned nothing. In a
 *      containment check "found" means the two values are **textually equal**,
 *      so a paired row shows the same string twice, and an unpaired row shows a
 *      blank. The merge could not add information in either case — it could
 *      only fill the gaps with parent keys nobody asked about. With 20 child
 *      values against 1,289 parent values, that buried the answer under 280
 *      rows of noise.
 *
 * So: two plain lists, each ascending, each scrolling on its own, and the
 * per-value `matched` flag — measured against the WHOLE parent column — carries
 * every fact. Nothing on screen implies a row-by-row correspondence, because
 * there is none.
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
    /** How many actually came back, so the UI can say "first 300 of 1,289". */
    shown: number;
  } | null;
  limit: number;
}

export interface QueryableConnector {
  executeQuery(sql: string): Promise<{ rows: unknown[] }>;
}

/**
 * `matched` is an EXISTS over the ENTIRE parent column, not over the sample
 * fetched beside it. A value can be absent from those rows and still exist in
 * the table, and calling that "not found" is the lie this file exists to avoid.
 *
 * The parent side is a plain first-N sample. It answers one question — *what do
 * the values over there look like?* — and that is a question about character
 * shape, not about any particular row. Earlier versions bounded it to the
 * child's range and ordered it to keep paired values inside the cap; both were
 * scaffolding for an alignment that no longer exists, and both made the sample
 * less representative of the column it is meant to characterise.
 */
function valuesSql(
  leftTable: string, leftColumn: string, rightTable: string, rightColumn: string,
): string {
  return `WITH l AS (
      SELECT DISTINCT CAST("${leftColumn}" AS TEXT) AS v
      FROM "${leftTable}" WHERE "${leftColumn}" IS NOT NULL
      ORDER BY 1 LIMIT ${VALUE_LIMIT}
    )
    SELECT 'l' AS side, l.v AS v,
           EXISTS (SELECT 1 FROM "${rightTable}" t
                   WHERE CAST(t."${rightColumn}" AS TEXT) = l.v) AS matched
    FROM l
    UNION ALL
    SELECT 'r' AS side, v, TRUE AS matched FROM (
      SELECT DISTINCT CAST("${rightColumn}" AS TEXT) AS v
      FROM "${rightTable}" WHERE "${rightColumn}" IS NOT NULL
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
  /**
   * Sorted here rather than trusted from SQL: the database's collation is not
   * guaranteed to be JavaScript's, and two lists a person reads side by side
   * should be in the order that person's browser would put them in.
   */
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
      shown: rightValues.length,
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
