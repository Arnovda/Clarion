/**
 * Per-tenant AI token budgets.
 *
 * Wraps every AI call site in an `AsyncLocalStorage` scope carrying the
 * current tenant id. The AIService reads that context to (a) check the
 * tenant's remaining monthly budget before the call, (b) record token
 * usage after success.
 *
 * Design choices:
 *  - Budget is a SOFT cap — we throw `AiBudgetExceededError` BEFORE hitting
 *    Anthropic, so blown budgets don't cost us money. Routes catch it and
 *    return 402 with a clear message.
 *  - Period is the calendar month in UTC. Resets at 00:00 UTC on the 1st.
 *  - `tenants.monthly_token_budget` NULL ⇒ unlimited. Zero ⇒ blocked.
 *  - If tenant context is missing (e.g. CLI scripts, in-process workers
 *    that didn't wrap their handler), we skip the check. This is
 *    deliberate — never block backend-initiated calls just because someone
 *    forgot to wrap them. The cost of uncapped system calls is small; the
 *    cost of a jammed worker would be larger.
 *  - Writes to `ai_usage` are best-effort. Failing to record usage must
 *    never break the call that already succeeded.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'ai-budget' });

interface TenantAiContext {
  tenantId: number;
}

const store = new AsyncLocalStorage<TenantAiContext>();

/** Run `fn` in an async scope carrying the given tenant id for AI budgeting. */
export function withTenantAiContext<T>(tenantId: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ tenantId }, fn);
}

/** Current tenant id from the AsyncLocalStorage scope, if any. */
export function getTenantAiContext(): number | null {
  return store.getStore()?.tenantId ?? null;
}

/** Thrown by callClaude when the caller's tenant has hit its monthly budget. */
export class AiBudgetExceededError extends Error {
  constructor(
    public readonly tenantId: number,
    public readonly usedTokens: number,
    public readonly budgetTokens: number,
  ) {
    super(
      `AI token budget exceeded for tenant ${tenantId}: ${usedTokens.toLocaleString()} / ${budgetTokens.toLocaleString()} tokens this month.`,
    );
    this.name = 'AiBudgetExceededError';
  }
}

function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface BudgetStatus {
  tenantId: number;
  used: number;
  budget: number | null;   // null = unlimited
  remaining: number | null; // null = unlimited
  allowed: boolean;
}

/**
 * Check the tenant's current-period usage against their configured budget.
 *
 * Returns allowed=true and remaining=null when no budget is configured
 * (interpreted as unlimited). Returns allowed=false only when a positive
 * budget is set AND the tenant has met or exceeded it.
 */
export async function checkTenantAiBudget(tenantId: number): Promise<BudgetStatus> {
  try {
    const tenant = await semanticDb('tenants')
      .where({ id: tenantId })
      .select('monthly_token_budget')
      .first();

    const budget = tenant?.monthly_token_budget != null
      ? Number(tenant.monthly_token_budget)
      : null;

    const usageRow = await semanticDb('ai_usage')
      .where({ tenant_id: tenantId, period_start: currentPeriodStart() })
      .select('total_tokens')
      .first();
    const used = usageRow ? Number(usageRow.total_tokens) : 0;

    if (budget == null) {
      return { tenantId, used, budget: null, remaining: null, allowed: true };
    }
    const remaining = Math.max(0, budget - used);
    return { tenantId, used, budget, remaining, allowed: used < budget };
  } catch (err) {
    log.warn({ err, tenantId }, 'checkTenantAiBudget failed — allowing call');
    return { tenantId, used: 0, budget: null, remaining: null, allowed: true };
  }
}

/**
 * Record token usage for the tenant. Upserts into (tenant_id, period_start).
 * Never throws — failures just log.
 */
export async function recordTenantAiUsage(
  tenantId: number,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const total = inputTokens + outputTokens;
  if (total <= 0) return;
  try {
    await semanticDb.raw(
      `INSERT INTO ai_usage (tenant_id, period_start, input_tokens, output_tokens, total_tokens, call_count, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())
       ON CONFLICT (tenant_id, period_start) DO UPDATE SET
         input_tokens  = ai_usage.input_tokens  + EXCLUDED.input_tokens,
         output_tokens = ai_usage.output_tokens + EXCLUDED.output_tokens,
         total_tokens  = ai_usage.total_tokens  + EXCLUDED.total_tokens,
         call_count    = ai_usage.call_count    + 1,
         updated_at    = NOW()`,
      [tenantId, currentPeriodStart(), inputTokens, outputTokens, total],
    );
  } catch (err) {
    log.warn({ err, tenantId, total }, 'recordTenantAiUsage failed');
  }
}

/**
 * Express middleware: sets the AI tenant context for the lifetime of the
 * request so every AIService call kicked off during handler execution
 * sees the right tenant. Mount AFTER requireAuth so req.user is populated.
 */
export function tenantAiContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tenantId = (req as unknown as { user?: { tenantId?: number } }).user?.tenantId;
  if (!tenantId) return next();
  // Run `next` inside the ALS scope — every async call it triggers during
  // this request will inherit the tenantId.
  store.run({ tenantId }, () => next());
}
