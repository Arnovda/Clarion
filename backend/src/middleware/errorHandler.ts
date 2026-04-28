import { Request, Response, NextFunction } from 'express';
import { AiBudgetExceededError } from '../services/aiBudget';

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

  // Log full error server-side — never expose internals to the client
  console.error('[ErrorHandler]', err);

  // Admins (in any environment) get the real message — they're trusted
  // operators of their own tenant and need diagnostics in prod too.
  const isAdmin = req.user?.role === 'admin';
  const message = (isAdmin && err instanceof Error)
    ? err.message
    : 'Something went wrong. Please try again.';

  res.status(500).json({ ok: false, error: message });
}
