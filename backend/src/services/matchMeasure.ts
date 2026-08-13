/**
 * Match measurement — how well two tables from DIFFERENT sources line up.
 *
 * A relationship inside one source is a foreign key, and `relationshipMeasure`
 * answers it with containment. Between two sources there is no foreign key:
 * nothing in a webshop points at an accounting package's account id. What links
 * them is an assertion that two rows describe the same real-world thing, and the
 * only honest way to check it is to ask how many rows actually find a partner.
 *
 * So this reports a MATCH RATE, in both directions, plus a sample of the values
 * that found nobody. The samples are the point: a rate of 68% is a number, but
 * seeing that the misses are all formatted `BE 0123.456.789` while the other side
 * writes `BE0123456789` tells you what to do about it.
 *
 * NORMALISATION IS THE WHOLE GAME. Two systems almost never format a VAT number,
 * an IBAN or an email the same way, so a raw equality join understates the true
 * overlap badly — and understating it is the failure that makes someone conclude
 * their data cannot be joined when it can.
 */

import { assertSafeIdentifier } from './relationshipMeasure';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'matchMeasure' });

/** Same reasoning as the join measurement: this runs under an open panel. */
const MATCH_TIMEOUT_MS = Number(process.env.RELATIONSHIP_MATCH_TIMEOUT_MS) || 12000;

/** How many unmatched examples to show per side. Enough to spot a pattern. */
const SAMPLE_SIZE = 12;

export type Normalisation = 'exact' | 'loose';

export interface MatchMeasurement {
  ok: boolean;
  reason: 'ok' | 'table-not-found' | 'timeout' | 'query-failed';
  normalisation: Normalisation;
  left: { total: number; matched: number; unmatchedSample: string[] } | null;
  right: { total: number; matched: number; unmatchedSample: string[] } | null;
  /** Share of the LEFT side that found a partner. The headline number. */
  matchRate: number | null;
  elapsedMs: number;
}

/**
 * SQL for the normalised comparison key.
 *
 * `loose` strips everything that is not a letter or digit and upper-cases the
 * rest, which is what makes `BE 0123.456.789` and `be0123456789` the same
 * company. It is deliberately aggressive: for the identifiers people actually
 * match on — VAT numbers, company numbers, IBANs, product codes — punctuation
 * and case carry no meaning, and treating them as meaningful is how a real
 * overlap gets reported as a miss.
 *
 * `exact` is available for the cases where formatting IS the value.
 */
function normExpr(col: string, mode: Normalisation): string {
  const raw = `CAST("${col}" AS TEXT)`;
  if (mode === 'exact') return `NULLIF(TRIM(${raw}), '')`;
  return `NULLIF(UPPER(REGEXP_REPLACE(${raw}, '[^A-Za-z0-9]', '', 'g')), '')`;
}

function empty(reason: MatchMeasurement['reason'], normalisation: Normalisation, elapsedMs: number): MatchMeasurement {
  return { ok: false, reason, normalisation, left: null, right: null, matchRate: null, elapsedMs };
}

/**
 * Fixed neutral view names. Two sources may each have a table called
 * `Accounts`, so the real names cannot be used without colliding.
 */
export const LEFT_VIEW = 'match_left';
export const RIGHT_VIEW = 'match_right';

/**
 * Measure the overlap. Never throws — same contract as the join measurement,
 * because this also runs under a panel the user is looking at.
 */
export async function measureMatch(
  connector: { executeQuery(sql: string): Promise<{ rows: unknown[] }> },
  leftColumn: string,
  rightColumn: string,
  normalisation: Normalisation = 'loose',
): Promise<MatchMeasurement> {
  const started = Date.now();

  try {
    assertSafeIdentifier(leftColumn, 'column name');
    assertSafeIdentifier(rightColumn, 'column name');
  } catch (err) {
    log.error({ err, leftColumn, rightColumn }, 'refusing to measure match: unsafe identifier');
    return empty('query-failed', normalisation, Date.now() - started);
  }

  const l = normExpr(leftColumn, normalisation);
  const r = normExpr(rightColumn, normalisation);

  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), MATCH_TIMEOUT_MS);
  });

  try {
    const work = (async () => {
      // Counts in one statement; samples in a second. Splitting them keeps the
      // count query cheap enough to stay useful even when the sample side is
      // large, and the samples are only meaningful once a gap is known to exist.
      const counts = await connector.executeQuery(
        `WITH a AS (SELECT DISTINCT ${l} AS v FROM "${LEFT_VIEW}" WHERE ${l} IS NOT NULL),
              b AS (SELECT DISTINCT ${r} AS v FROM "${RIGHT_VIEW}" WHERE ${r} IS NOT NULL)
         SELECT (SELECT COUNT(*) FROM a) AS a_total,
                (SELECT COUNT(*) FROM b) AS b_total,
                (SELECT COUNT(*) FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.v = a.v)) AS a_matched,
                (SELECT COUNT(*) FROM b WHERE EXISTS (SELECT 1 FROM a WHERE a.v = b.v)) AS b_matched`,
      );

      const samples = await connector.executeQuery(
        `WITH a AS (SELECT DISTINCT ${l} AS v FROM "${LEFT_VIEW}" WHERE ${l} IS NOT NULL),
              b AS (SELECT DISTINCT ${r} AS v FROM "${RIGHT_VIEW}" WHERE ${r} IS NOT NULL)
         SELECT 'a' AS side, v FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.v = a.v) LIMIT ${SAMPLE_SIZE}
         UNION ALL
         SELECT 'b' AS side, v FROM b WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.v = b.v) LIMIT ${SAMPLE_SIZE}`,
      );

      return { counts, samples };
    })();
    // A late rejection after the budget wins has nobody listening; without a
    // sink it becomes an unhandled rejection when the route disconnects.
    work.catch(() => undefined);

    const settled = await Promise.race([work, budget]);
    if (settled === 'timeout') {
      log.warn({ leftColumn, rightColumn, ms: MATCH_TIMEOUT_MS }, 'match measurement exceeded budget');
      return empty('timeout', normalisation, Date.now() - started);
    }

    const row = settled.counts.rows[0] as Record<string, unknown> | undefined;
    const aTotal = Number(row?.a_total ?? 0);
    const bTotal = Number(row?.b_total ?? 0);
    const aMatched = Number(row?.a_matched ?? 0);
    const bMatched = Number(row?.b_matched ?? 0);

    const sampleRows = settled.samples.rows as Array<{ side?: string; v?: unknown }>;
    const take = (side: string) => sampleRows
      .filter((s) => s.side === side)
      .map((s) => String(s.v ?? ''))
      .filter(Boolean);

    return {
      ok: true,
      reason: 'ok',
      normalisation,
      left: { total: aTotal, matched: aMatched, unmatchedSample: take('a') },
      right: { total: bTotal, matched: bMatched, unmatchedSample: take('b') },
      matchRate: aTotal > 0 ? aMatched / aTotal : null,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    log.warn({ err, leftColumn, rightColumn }, 'match measurement failed');
    return empty('query-failed', normalisation, Date.now() - started);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
