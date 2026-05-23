import { Request, Response, NextFunction } from 'express';
import { AiBudgetExceededError } from '../services/aiBudget';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'error-handler' });

/**
 * Postgres 25P02 "in_failed_sql_transaction" — Postgres is rejecting
 * statements because the transaction had an EARLIER failure that
 * wasn't rolled back. This is never the real bug. The real bug is the
 * query that originally failed, somewhere earlier in the request.
 *
 * Surface this loudly so future trx-poison incidents don't make us
 * chase the wrong error like the May 23 2026 /query DISTINCT-ON cascade.
 *
 * The fix is structural: any defensive `.catch(() => …)` on a Knex
 * query inside a shared request transaction must use `safeQuery`
 * (SAVEPOINT-wrapped) so a failure rolls back to the savepoint
 * instead of poisoning the outer trx.
 */
function isPostgresTrxAborted(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  if (e.code === '25P02') return true;
  // node-postgres sometimes surfaces the SQLSTATE only in the message.
  return /current transaction is aborted/i.test(e.message);
}

// Postgres / SDK errors carry properties we want to keep in logs but
// never expose to clients (driver internals, query text, etc.). Allow-
// list the fields we DO want.
function sanitizeForLog(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  const e = err as Error & {
    code?: string;
    statusCode?: number;
    name?: string;
  };
  return {
    name:       e.name,
    message:    e.message,
    code:       e.code,
    statusCode: e.statusCode,
    stack:      e.stack?.split('\n').slice(0, 5).join('\n'),
  };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Typed: AI token budget blown — tell the client clearly so the UI can
  // show a "contact admin" message rather than a generic failure.
  if (err instanceof AiBudgetExceededError) {
    res.status(429).json({
      ok: false,
      error: 'Your organisation has reached its monthly AI usage limit. Please contact your admin.',
      code: 'ai_budget_exceeded',
      details: {
        used: err.usedTokens,
        budget: err.budgetTokens,
      },
    });
    return;
  }

  // Loud diagnostic for trx-poison cascades. The 25P02 the user sees
  // is ALWAYS the second error — the first error (the one that
  // actually broke the transaction) is somewhere earlier in this
  // request and may have been silently swallowed by a `.catch(() => …)`.
  // Tag the log at FATAL level so it shows up unmistakably in App
  // Insights, and include a hint in the admin response.
  const trxAborted = isPostgresTrxAborted(err);
  if (trxAborted) {
    log.fatal({
      err:       sanitizeForLog(err),
      requestId: (req as Request & { id?: string }).id,
      url:       req.url,
      method:    req.method,
      userId:    req.user?.sub,
      tenantId:  req.user?.tenantId,
      hint:      'Postgres 25P02 reached the error handler — an EARLIER query in this request failed and was silently absorbed (likely `.catch(() => …)` on a non-savepointed query). Search backend logs for this requestId; the real failure is the FIRST Postgres error stamped with the same id.',
    }, 'request failed with poisoned transaction (25P02)');
  } else {
    // Log structured, not the raw object. Pino with `err: err` would emit
    // every enumerable property including driver internals or interpolated
    // SQL. We pick a narrow allowlist so log telemetry stays clean and we
    // don't accidentally ship secrets / customer data into App Insights.
    log.error({
      err:       sanitizeForLog(err),
      requestId: (req as Request & { id?: string }).id,
      url:       req.url,
      method:    req.method,
      userId:    req.user?.sub,
      tenantId:  req.user?.tenantId,
    }, 'request failed');
  }

  // Admins (in any environment) get the real message — they're trusted
  // operators of their own tenant and need diagnostics in prod too.
  // Non-admins see a generic message. 25P02 gets a special admin hint
  // pointing them at the upstream cause so the next debugging session
  // doesn't chase a phantom.
  const isAdmin = req.user?.role === 'admin';
  let message: string;
  if (isAdmin && trxAborted) {
    message = 'Postgres reported "current transaction is aborted" — an earlier query in this request failed and was hidden. Check backend logs for the FIRST Postgres error in this requestId.';
  } else if (isAdmin && err instanceof Error) {
    message = err.message;
  } else {
    message = 'Something went wrong. Please try again.';
  }

  res.status(500).json({ ok: false, error: message });
}
