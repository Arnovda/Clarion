/**
 * Read-query self-heal.
 *
 * When the model writes SQL the database refuses to compile, the answer is not
 * "Something went wrong. Please try again." — retrying re-runs the same
 * generator with the same context and usually produces the same slip. The
 * database already said exactly what is wrong; handing that sentence back to
 * the model with the schema fixes it in one call.
 *
 * This is the read-path twin of the repair pass `transformationRunner` has run
 * on the write path for a long time, and it is deliberately narrow:
 *
 *   ONE attempt.  Not a loop. A compile error needs the error text and the
 *   schema, both of which we already have. The multi-turn `/query/repair`
 *   agent answers a different question — "this ran, but are the numbers
 *   right?" — and is still what runs for a suspicious RESULT.
 *
 *   ONLY compile-shaped errors.  A timeout, a permission refusal or a dead
 *   connection is not something a rewrite can fix, and retrying those wastes
 *   a model call and the user's time.
 *
 * ── The ordering rule this module exists to make structural ───────────────
 * Data policies WRAP the query (`SELECT * FROM (…) AS _policy_filtered WHERE
 * …`) and REWRITE masked columns to '***'. So the policy-applied SQL must
 * never be what we hand the model to rewrite: a returned rewrite with the
 * wrapper dropped or the mask undone would be a policy bypass, and it would
 * look exactly like a successful repair.
 *
 * Therefore this module owns the whole sequence — policies are applied here,
 * to whichever SQL is about to run, and the repair always works from the
 * PRE-policy text. Callers hand over model SQL and get rows back; they cannot
 * get the order wrong because they never see the intermediate.
 */

import { assertSafeReadQuery, isSqlShaped } from '../utils/sqlGuard';
import { applyDataPolicies, PolicyApplicationResult } from './policyEngine';
import { repairReadQuerySql, AiCreditExhaustedError } from '../ai/AIService';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'sql-self-heal' });

/**
 * Errors a rewrite can plausibly fix: the query named something that isn't
 * there, or isn't valid syntax. Spelled out per dialect because the read path
 * serves DuckDB (product layer) and Postgres / MySQL / SQL Server / SQLite
 * (source layer).
 *
 * Deliberately NOT matched: timeouts, connection loss, permission denials,
 * out-of-memory. Those are real conditions the user needs told about, and a
 * rewritten query would fail the same way while costing a model call.
 */
const REPAIRABLE_ERROR = new RegExp(
  [
    // DuckDB
    'Binder Error',
    'Catalog Error',
    'Parser Error',
    'Referenced column',
    'does not have a column',
    // Postgres
    'column .* does not exist',
    'relation .* does not exist',
    'missing FROM-clause entry',
    // MySQL
    'Unknown column',
    'Unknown table',
    // SQL Server
    'Invalid column name',
    'Invalid object name',
    // Shared / SQLite
    'no such column',
    'no such table',
    'ambiguous column',
    'syntax error',
    'must appear in the GROUP BY clause',
  ].join('|'),
  'i',
);

export function isRepairableSqlError(message: string): boolean {
  return REPAIRABLE_ERROR.test(message);
}

export interface SelfHealOutcome {
  rows: Record<string, unknown>[];
  /**
   * The model-authored SQL that produced these rows, BEFORE policies were
   * applied. This is what gets shown in "show SQL", logged and persisted —
   * after a repair it is the corrected query, never the one that failed, so
   * the SQL on the card is always the SQL that produced the numbers.
   */
  sql: string;
  /** Policy metadata for the query that actually ran. */
  policy: PolicyApplicationResult;
  /** Present only when the first attempt failed and the repair succeeded. */
  repair?: { failedSql: string; error: string };
}

export interface SelfHealOptions {
  /** Model-authored SQL, pre-policy. */
  sql: string;
  /** The user's question — the repair must preserve its intent. */
  question: string;
  /** Schema the model may reference. Bounds what a repair can invent. */
  schemaContext: string;
  userId: number;
  userRole: string;
  tenantId: number;
  /** Runs one statement. The caller owns the connector and its lifecycle. */
  execute: (sql: string) => Promise<Record<string, unknown>[]>;
  /** Called once, before the repair model call, so the UI can say so. */
  onRepairStart?: () => void;
}

/**
 * Apply policies, run, and on a compile-shaped failure repair once and re-run.
 *
 * Throws the ORIGINAL database error when the repair is unavailable, declined,
 * rejected or itself fails — the user is owed the real problem, not a second
 * error from the machinery that tried to help.
 */
export async function executeWithSelfHeal(opts: SelfHealOptions): Promise<SelfHealOutcome> {
  const { sql, question, schemaContext, userId, userRole, tenantId, execute } = opts;

  const firstPolicy = await applyDataPolicies(sql, userId, userRole, tenantId);
  try {
    return { rows: await execute(firstPolicy.sql), sql, policy: firstPolicy };
  } catch (firstErr) {
    const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (!isRepairableSqlError(errMsg)) throw firstErr;

    log.warn({ err: errMsg.slice(0, 200) }, '[self-heal] query failed to compile — attempting one repair');
    opts.onRepairStart?.();

    let repaired: string;
    try {
      // The PRE-policy sql, never firstPolicy.sql — see the header note.
      repaired = await repairReadQuerySql(question, sql, errMsg, schemaContext);
    } catch (repairErr) {
      // Out of credits, model unavailable, aborted: the user's problem is
      // still the original error, so that is what they get told about.
      if (!(repairErr instanceof AiCreditExhaustedError)) {
        log.warn({ err: repairErr }, '[self-heal] repair call failed');
      }
      throw firstErr;
    }

    if (!repaired || repaired.trim() === sql.trim()) {
      // The prompt tells the model to return the original unchanged when it
      // cannot fix the error with the schema it was given. That is a refusal,
      // and re-running identical SQL would just fail identically.
      throw firstErr;
    }
    if (!isSqlShaped(repaired)) {
      log.warn('[self-heal] repair returned prose, not SQL — rejecting');
      throw firstErr;
    }

    // Fresh model output: same trust as first-pass generation, so the full
    // read guard runs again before anything executes, and policies are
    // re-applied to the REPAIRED text rather than carried over.
    let repairedPolicy: PolicyApplicationResult;
    try {
      assertSafeReadQuery(repaired);
      repairedPolicy = await applyDataPolicies(repaired, userId, userRole, tenantId);
    } catch (guardErr) {
      log.warn({ err: guardErr }, '[self-heal] repair refused by the read guard — rejecting');
      throw firstErr;
    }

    // A repair that loses a policy is not a repair. Policies attach to the
    // tables named in the SQL, so a rewrite that still reads the same tables
    // attracts the same count. Fewer means the rewrite dropped a table — which
    // is occasionally legitimate (a broken join removed), but is also what an
    // evasion looks like, and the two are indistinguishable from here. We take
    // the safe direction: refuse, and report the original error. The cost is a
    // repair we could have made; the alternative cost is showing a viewer rows
    // a policy exists to hide.
    if (repairedPolicy.policiesApplied < firstPolicy.policiesApplied) {
      log.warn(
        { before: firstPolicy.policiesApplied, after: repairedPolicy.policiesApplied },
        '[self-heal] repair dropped a data policy — rejecting',
      );
      throw firstErr;
    }

    try {
      const rows = await execute(repairedPolicy.sql);
      log.info('[self-heal] repair succeeded');
      return {
        rows,
        sql: repaired,
        policy: repairedPolicy,
        repair: { failedSql: sql, error: errMsg },
      };
    } catch {
      // The repair did not work either. Report the original failure — it is
      // the one that describes what the user actually asked for.
      throw firstErr;
    }
  }
}
