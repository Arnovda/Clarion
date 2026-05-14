import { Request, Response, NextFunction } from 'express';
import { AiBudgetExceededError } from '../services/aiBudget';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'error-handler' });

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

  // Admins (in any environment) get the real message — they're trusted
  // operators of their own tenant and need diagnostics in prod too.
  // Non-admins see a generic message.
  const isAdmin = req.user?.role === 'admin';
  const message = (isAdmin && err instanceof Error)
    ? err.message
    : 'Something went wrong. Please try again.';

  res.status(500).json({ ok: false, error: message });
}
