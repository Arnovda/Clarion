/**
 * Measure whether a proposed relationship actually holds in the data.
 *
 * This exists to serve one interaction: the user drags a line between two
 * columns on the relationship canvas, and instead of a form asking them to
 * declare "is this one-to-many?", Clarion answers from the data:
 *
 *   97% of values found in target · 1-to-many (avg 3.2, max 47) · 23 orphans
 *
 * The measurement IS the confirmation dialog, so three things matter as much
 * as correctness:
 *
 *   • It must be FAST. A popover that spins is worse than no popover — hence
 *     the wall-clock budget below, which is far tighter than DuckDB's own
 *     45s query timeout.
 *   • It must NEVER throw at the caller. Every failure becomes an
 *     `unmeasurable` verdict with a machine-readable reason the UI renders as
 *     a sentence. A raw stack trace in a design tool is a dead end for the user.
 *   • It must NEVER refuse. A weak or broken result is information, not a
 *     veto — the user may know something the data does not show yet (an empty
 *     table, a source that has not synced). We report; they decide.
 *
 * CONSISTENCY WITH THE DETECTOR IS NON-NEGOTIABLE. Containment and target
 * uniqueness come from `verifyFkCandidate` in semantic/fkVerification — the
 * same function, the same thresholds, the same sample the automatic detector
 * uses — because a canvas reporting 97% for a relationship the detector
 * silently rejected is lying to the user about which one is wrong. That
 * function is why there is no second copy of the test here.
 */

import { verifyFkCandidate, type FkVerdict } from '../semantic/fkVerification';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'relationshipMeasure' });

/**
 * Wall-clock budget for a whole measurement. Deliberately much shorter than
 * `DUCKDB_QUERY_TIMEOUT_MS` (45s): this runs while a popover is open under the
 * user's cursor. Past a few seconds the honest answer is "we couldn't tell you
 * quickly", not a longer spinner.
 */
const MEASURE_TIMEOUT_MS = Number(process.env.RELATIONSHIP_MEASURE_TIMEOUT_MS) || 8000;

export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

/**
 * What the UI colours and phrases the result with.
 *
 *   strong       — passes every guard the automatic detector applies.
 *   weak         — plausible, but the data does not confirm it. Either too few
 *                  distinct values to be evidence, or the target is not a key,
 *                  or containment is below threshold but not absurd.
 *   broken       — containment so low the relationship almost certainly is not
 *                  one (fewer than half the values have a partner).
 *   unmeasurable — we could not run the check. Not a judgement on the
 *                  relationship.
 */
export type MeasureVerdict = 'strong' | 'weak' | 'broken' | 'unmeasurable';

export type MeasureReason =
  | 'ok'
  | 'too-few-distinct'
  | 'target-not-key'
  | 'low-containment'
  | 'no-values'
  | 'timeout'
  | 'query-failed';

export interface RelationshipMeasurement {
  verdict: MeasureVerdict;
  reason: MeasureReason;
  /**
   * Distinct-value containment, measured on a bounded sample. `matched` and
   * `sampled` come from the SAME sample — mixing a sampled numerator with a
   * whole-column denominator is the exact defect measured in production on
   * 2026-08-03, and it systematically rejected the wide keys worth having.
   */
  containment: {
    matchedDistinct: number;
    sampledDistinct: number;
    ratio: number;
    sampleSize: number;
  } | null;
  /** Is the target side actually a key? Measured, never guessed from its name. */
  target: { rows: number; distinct: number; isKey: boolean } | null;
  /**
   * Measured over the FULL source table, not the sample — "max 47" is
   * meaningless from a sample of 1,000 distinct values. Reported separately
   * from `containment` so the two are never mistaken for one ratio.
   */
  cardinality: {
    type: Cardinality;
    avgChildren: number;
    maxChildren: number;
    basis: 'full';
  } | null;
  /** Source rows whose value has no partner in the target. Full table. */
  orphans: { rows: number; basis: 'full' } | null;
  /**
   * Actual values from both columns, so a person can SEE why a percentage is
   * what it is.
   *
   * A ratio says there is a gap; the values say whether it is a formatting
   * problem you can fix (`BE 0123.456` against `be0123456`), a wrong column
   * (GUIDs against codes), or a genuinely absent parent. This is the same
   * reasoning that made the unmatched samples the substance of the cross-source
   * match panel, applied to joins.
   *
   * Best-effort: a failure here leaves this null and never costs the verdict.
   */
  examples: {
    matched: string[];
    unmatched: string[];
    /** A few values from the target column, for shape comparison. */
    target: string[];
  } | null;
  /** Echoed so the UI can say "min 85%" without hardcoding a threshold. */
  thresholds: {
    sampleSize: number;
    minDistinct: number;
    targetUniqueness: number;
    minContainment: number;
  };
  elapsedMs: number;
}

/** The subset of a connector this needs — keeps the unit tests free of DuckDB. */
export interface QueryableConnector {
  executeQuery(sql: string): Promise<{ rows: unknown[] }>;
}

/**
 * Identifier guard.
 *
 * Table and column names here are resolved from the catalog by id, never taken
 * from the request body, so this is defence in depth rather than the primary
 * control. It exists because these names are interpolated into SQL: a name
 * carrying a double quote would break out of the quoting, and `sqlGuard` does
 * not run on queries this service composes itself.
 */
const SAFE_IDENT = /^[A-Za-z0-9_][A-Za-z0-9_ .$-]{0,127}$/;

export function assertSafeIdentifier(name: string, what: string): void {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`Unsafe ${what} from catalog: ${JSON.stringify(name)}`);
  }
}

/**
 * Decide the cardinality from measured uniqueness on both sides.
 *
 * Read "from" as the child and "to" as the parent — the direction the user
 * dragged. A foreign key is the many-to-one case, which is why it is the one
 * that must come out right.
 */
export function classifyCardinality(
  fromIsUnique: boolean,
  toIsUnique: boolean,
): Cardinality {
  if (fromIsUnique && toIsUnique) return 'one_to_one';
  if (fromIsUnique && !toIsUnique) return 'one_to_many';
  if (!fromIsUnique && toIsUnique) return 'many_to_one';
  return 'many_to_many';
}

/**
 * Map the detector's verdict onto something the UI can colour.
 *
 * `low-containment` splits: below half, the relationship is almost certainly
 * wrong and should look it; between half and the threshold it is worth showing
 * as unconfirmed rather than condemned, because a partially-synced source
 * produces exactly that shape.
 */
export function verdictFromFk(v: FkVerdict): { verdict: MeasureVerdict; reason: MeasureReason } {
  if (v.sampled === 0) return { verdict: 'unmeasurable', reason: 'no-values' };
  switch (v.reason) {
    case 'ok':
      return { verdict: 'strong', reason: 'ok' };
    case 'too-few-distinct':
      return { verdict: 'weak', reason: 'too-few-distinct' };
    case 'target-not-key':
      return { verdict: 'weak', reason: 'target-not-key' };
    case 'low-containment':
      return v.containment < 0.5
        ? { verdict: 'broken', reason: 'low-containment' }
        : { verdict: 'weak', reason: 'low-containment' };
  }
}

/**
 * Cardinality + orphan counts, over the full source table.
 *
 * One statement rather than three, because every round trip is latency the
 * user watches. The grouped CTE yields distinct values, total rows, the
 * children-per-parent distribution and the orphan row count together.
 */
function cardinalitySql(
  fromTable: string, fromColumn: string, toTable: string, toColumn: string,
): string {
  return `WITH g AS (
    SELECT "${fromColumn}" AS v, COUNT(*) AS n
    FROM "${fromTable}"
    WHERE "${fromColumn}" IS NOT NULL
    GROUP BY 1
  )
  SELECT (SELECT COUNT(*)             FROM g) AS distinct_vals,
         (SELECT COALESCE(SUM(n), 0)  FROM g) AS total_rows,
         (SELECT COALESCE(AVG(n), 0)  FROM g) AS avg_children,
         (SELECT COALESCE(MAX(n), 0)  FROM g) AS max_children,
         (SELECT COALESCE(SUM(n), 0)  FROM g
            WHERE NOT EXISTS (
              SELECT 1 FROM "${toTable}" t
              WHERE CAST(t."${toColumn}" AS TEXT) = CAST(g.v AS TEXT)
            )) AS orphan_rows`;
}

/** Control-flow marker for "not asked for", so it is not logged as a failure. */
class SkipExamples extends Error {}

/** How many values of each kind to show. Enough to spot a pattern, not a dump. */
const EXAMPLE_LIMIT = 5;
/**
 * Examples get their OWN slice of the budget, well inside the overall one.
 *
 * Without this the illustration could eat the whole wall clock and turn a
 * measurement that had already succeeded into `unmeasurable` — the verdict lost
 * to the thing that was only ever meant to explain it.
 */
const EXAMPLES_TIMEOUT_MS = Math.min(2500, Math.floor(MEASURE_TIMEOUT_MS / 3));
/** A join key longer than this is not being read, it is being scrolled past. */
const EXAMPLE_MAX_LEN = 64;

/**
 * Values from both sides: some that found a partner, some that did not, and a
 * few from the target for comparison.
 *
 * Deliberately NOT part of `verifyFkCandidate`. That function runs for every
 * candidate of every table during profiling, and making it carry a presentation
 * concern would put this cost on a path that never displays the result.
 */
function examplesSql(
  fromTable: string, fromColumn: string, toTable: string, toColumn: string, sampleSize: number,
): string {
  // The CTE is named `ex`, not `src`, so this query is never mistaken for
  // `verifyFkCandidate`'s — they are otherwise near-identical in shape, and the
  // unit tests tell the three queries apart by exactly that opening.
  const exists = `EXISTS (SELECT 1 FROM "${toTable}" t WHERE CAST(t."${toColumn}" AS TEXT) = s.v)`;
  return `WITH ex AS (
      SELECT DISTINCT CAST("${fromColumn}" AS TEXT) AS v
      FROM "${fromTable}" WHERE "${fromColumn}" IS NOT NULL LIMIT ${sampleSize}
    )
    SELECT * FROM (
      SELECT 'matched' AS bucket, s.v AS v FROM ex s WHERE ${exists} LIMIT ${EXAMPLE_LIMIT}
    )
    UNION ALL SELECT * FROM (
      SELECT 'unmatched' AS bucket, s.v AS v FROM ex s WHERE NOT ${exists} LIMIT ${EXAMPLE_LIMIT}
    )
    UNION ALL SELECT * FROM (
      SELECT 'target' AS bucket, CAST("${toColumn}" AS TEXT) AS v
      FROM "${toTable}" WHERE "${toColumn}" IS NOT NULL GROUP BY 1 LIMIT ${EXAMPLE_LIMIT}
    )`;
}

export function shapeExamples(rows: unknown[]): RelationshipMeasurement['examples'] {
  const take = (bucket: string) => rows
    .filter((r) => (r as { bucket?: string }).bucket === bucket)
    .map((r) => String((r as { v?: unknown }).v ?? ''))
    .map((v) => (v.length > EXAMPLE_MAX_LEN ? `${v.slice(0, EXAMPLE_MAX_LEN)}…` : v));
  return {
    matched: take('matched'),
    unmatched: take('unmatched'),
    target: take('target'),
  };
}

function emptyThresholds(): RelationshipMeasurement['thresholds'] {
  return {
    sampleSize: Number(process.env.FK_SAMPLE_SIZE) || 1000,
    minDistinct: Number(process.env.FK_MIN_DISTINCT) || 8,
    targetUniqueness: Number(process.env.FK_TARGET_UNIQUENESS) || 0.99,
    minContainment: Number(process.env.FK_MIN_CONTAINMENT) || 0.85,
  };
}

function unmeasurable(reason: MeasureReason, elapsedMs: number): RelationshipMeasurement {
  return {
    verdict: 'unmeasurable',
    reason,
    containment: null,
    target: null,
    cardinality: null,
    orphans: null,
    examples: null,
    thresholds: emptyThresholds(),
    elapsedMs,
  };
}

/**
 * Measure a proposed relationship. Never throws.
 */
export async function measureRelationship(
  connector: QueryableConnector,
  fromTable: string, fromColumn: string,
  toTable: string, toColumn: string,
  /**
   * Example values cost a third query. Checking one relationship under an open
   * panel wants them; checking a whole table's worth in a row does not — there
   * the answer is a list of pass/fail, and the values are what you look at
   * afterwards on the one that failed.
   */
  opts: { examples?: boolean } = {},
): Promise<RelationshipMeasurement> {
  const wantExamples = opts.examples !== false;
  const started = Date.now();
  const thresholds = emptyThresholds();

  try {
    assertSafeIdentifier(fromTable, 'table name');
    assertSafeIdentifier(fromColumn, 'column name');
    assertSafeIdentifier(toTable, 'table name');
    assertSafeIdentifier(toColumn, 'column name');
  } catch (err) {
    log.error({ err, fromTable, fromColumn, toTable, toColumn }, 'refusing to measure: unsafe identifier');
    return unmeasurable('query-failed', Date.now() - started);
  }

  // A single budget across both queries. Whichever settles first loses to the
  // clock if the pair takes too long; the user gets a definite answer either
  // way, which is the point.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), MEASURE_TIMEOUT_MS);
  });

  try {
    const work = (async () => {
      const fk = await verifyFkCandidate(connector, fromTable, fromColumn, toTable, toColumn);

      const card = await connector.executeQuery(
        cardinalitySql(fromTable, fromColumn, toTable, toColumn),
      );
      const row = card.rows[0] as Record<string, unknown> | undefined;

      // Best-effort, and its own try/catch on purpose: examples make the number
      // readable, but losing them must never cost the verdict that was already
      // measured.
      let examples: RelationshipMeasurement['examples'] = null;
      let exTimer: NodeJS.Timeout | undefined;
      try {
        if (!wantExamples) throw new SkipExamples();
        const exQuery = connector.executeQuery(
          examplesSql(fromTable, fromColumn, toTable, toColumn, thresholds.sampleSize),
        );
        // Same sink as the outer race, for the same reason: when the sub-budget
        // wins, this query is still in flight and the route will disconnect the
        // connector underneath it.
        exQuery.catch(() => undefined);
        const exBudget = new Promise<'slow'>((resolve) => {
          exTimer = setTimeout(() => resolve('slow'), EXAMPLES_TIMEOUT_MS);
        });
        const settledEx = await Promise.race([exQuery, exBudget]);
        if (settledEx === 'slow') {
          log.warn({ fromTable, fromColumn, ms: EXAMPLES_TIMEOUT_MS }, 'example values exceeded their slice');
        } else {
          examples = shapeExamples(settledEx.rows);
        }
      } catch (err) {
        if (!(err instanceof SkipExamples)) {
          log.warn({ err, fromTable, fromColumn }, 'could not sample example values');
        }
      } finally {
        if (exTimer) clearTimeout(exTimer);
      }

      return { fk, row, examples };
    })();
    // When the budget wins the race, this promise is still in flight and its
    // caller has already returned. The route then disconnects the connector,
    // which can make the abandoned query reject — with nothing listening, that
    // becomes an unhandled rejection and, depending on the Node flags, takes
    // the process down. Attaching a sink here does not consume the promise for
    // the race below.
    work.catch(() => undefined);

    const settled = await Promise.race([work, budget]);
    if (settled === 'timeout') {
      log.warn({ fromTable, fromColumn, toTable, toColumn, ms: MEASURE_TIMEOUT_MS }, 'measurement exceeded budget');
      return unmeasurable('timeout', Date.now() - started);
    }

    const { fk, row, examples } = settled;
    const { verdict, reason } = verdictFromFk(fk);

    const distinctVals = Number(row?.distinct_vals ?? 0);
    const totalRows    = Number(row?.total_rows ?? 0);
    const avgChildren  = Number(row?.avg_children ?? 0);
    const maxChildren  = Number(row?.max_children ?? 0);
    const orphanRows   = Number(row?.orphan_rows ?? 0);

    const fromIsUnique = totalRows > 0 && distinctVals === totalRows;
    const toIsUnique   = fk.targetRows > 0 && fk.targetDistinct / fk.targetRows >= thresholds.targetUniqueness;

    return {
      verdict,
      reason,
      containment: {
        matchedDistinct: fk.matched,
        sampledDistinct: fk.sampled,
        ratio: fk.containment,
        sampleSize: thresholds.sampleSize,
      },
      target: { rows: fk.targetRows, distinct: fk.targetDistinct, isKey: toIsUnique },
      cardinality: totalRows > 0
        ? {
            type: classifyCardinality(fromIsUnique, toIsUnique),
            avgChildren,
            maxChildren,
            basis: 'full',
          }
        : null,
      orphans: { rows: orphanRows, basis: 'full' },
      examples,
      thresholds,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    // A missing table, a type that will not cast, a warehouse that has not been
    // materialised. All of these are "we cannot tell you", not a server error —
    // the user is mid-gesture and needs a sentence, not a 500.
    log.warn({ err, fromTable, fromColumn, toTable, toColumn }, 'measurement query failed');
    return unmeasurable('query-failed', Date.now() - started);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
