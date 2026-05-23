/**
 * SAVEPOINT-wrapped defensive query helper.
 *
 * Lets a route handler use the "if this query fails, just continue with
 * a fallback" pattern WITHOUT poisoning the surrounding request
 * transaction.
 *
 * Why this exists:
 *
 *   The platform wraps every authenticated request in one Postgres
 *   transaction (`req.dbTrx`, opened by requireAuth). Every query
 *   inside the request shares that transaction. This is good for
 *   tenant safety (one SET LOCAL app.current_tenant covers everything)
 *   but it means a single failed query taints the WHOLE transaction —
 *   Postgres rejects every subsequent statement with error 25P02
 *   "current transaction is aborted" until ROLLBACK is called.
 *
 *   The naive defensive pattern:
 *
 *       const rows = await db('foo').where(...).catch(() => []);
 *
 *   catches the JavaScript error but does NOT roll Postgres back —
 *   the transaction is still poisoned. The next query in the same
 *   request fails with 25P02, and the user sees a misleading error
 *   that has nothing to do with the actual broken query several lines
 *   earlier. This is exactly how the May 23 2026 /query DISTINCT-ON
 *   bug surfaced ("connections SELECT failed" — actually
 *   dataset_profiles failed three queries before).
 *
 *   `safeQuery` fixes the pattern: open a SAVEPOINT first, run the
 *   query, RELEASE the savepoint on success, ROLLBACK TO the savepoint
 *   on failure. After a rollback the outer transaction is back to a
 *   clean state and subsequent queries run normally.
 *
 * When to use this:
 *
 *   • Defensive lookups where "no data" is a valid fallback. Quality
 *     hints, AI prompt enrichment, optional joins on potentially-
 *     missing rows.
 *   • DO NOT use for queries whose failure should propagate (writes,
 *     critical reads). Let those throw and let the request error
 *     handler return a clean 500.
 *
 * Cost: 2 extra round-trips per call (SAVEPOINT + RELEASE/ROLLBACK).
 * Acceptable for the defensive-read use case.
 *
 * Naming for SAVEPOINTs:
 *
 *   Each call generates a unique identifier so nested safeQuery calls
 *   don't clash. Postgres allows nested savepoints; the name only has
 *   to be unique within the current transaction.
 *
 * Example migration:
 *
 *   // BEFORE — silently poisons the trx on schema/permission error
 *   const profiles = await db('dataset_profiles')
 *     .where({ connection_id: id })
 *     .catch(() => []);
 *
 *   // AFTER — savepoint isolates the failure
 *   const profiles = await safeQuery(db, (trx) =>
 *     trx('dataset_profiles').where({ connection_id: id }),
 *     [],
 *   );
 */

import type { Knex } from 'knex';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'safeQuery' });

let savepointCounter = 0;

/**
 * Run a query inside a SAVEPOINT. On error, ROLLBACK TO the savepoint
 * (leaving the outer transaction usable) and return `fallback`. On
 * success, RELEASE the savepoint and return the query result.
 *
 * @param trx       The Knex transaction (typically `reqDb(req)`).
 * @param queryFn   Function that receives the trx and returns a query.
 *                  The trx passed in is the SAME trx — the savepoint is
 *                  opened on it before queryFn runs.
 * @param fallback  Returned when the query throws. Same shape as the
 *                  query's expected return.
 */
export async function safeQuery<T>(
  trx: Knex | Knex.Transaction,
  queryFn: (trx: Knex | Knex.Transaction) => Promise<T> | Knex.QueryBuilder,
  fallback: T,
): Promise<T> {
  // Unique savepoint name per call so nested usage doesn't collide.
  // Identifiers must start with a letter; counter suffix keeps it unique
  // within the transaction. Wraps after 2^31 — safe for a single request.
  savepointCounter = (savepointCounter + 1) | 0;
  if (savepointCounter < 0) savepointCounter = 0;
  const sp = `sq_${Date.now().toString(36)}_${savepointCounter}`;

  try {
    await trx.raw(`SAVEPOINT ${sp}`);
  } catch (err) {
    // SAVEPOINT can fail if `trx` isn't a real transaction (e.g. the
    // caller passed the global semanticDb instead of req.dbTrx). Surface
    // this clearly — silently falling back would mask a misuse.
    log.error({ err }, 'safeQuery: SAVEPOINT failed; is trx really a transaction?');
    throw err;
  }

  try {
    const result = await queryFn(trx);
    await trx.raw(`RELEASE SAVEPOINT ${sp}`);
    return result as T;
  } catch (err) {
    // Roll back to the savepoint so the outer transaction stays usable.
    // If this rollback itself throws, the outer trx is poisoned and
    // there's nothing we can do — re-throw the original.
    try {
      await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
    } catch (rollbackErr) {
      log.error(
        { err, rollbackErr, savepoint: sp },
        'safeQuery: ROLLBACK TO SAVEPOINT failed — outer transaction is now poisoned',
      );
      throw err;
    }
    log.warn(
      { err: err instanceof Error ? err.message : String(err), savepoint: sp },
      'safeQuery: query failed; rolled back to savepoint and returning fallback',
    );
    return fallback;
  }
}
