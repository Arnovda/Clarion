/**
 * AI call logger — fire-and-forget Postgres insert per Anthropic call.
 *
 * Reads tenant + user from AsyncLocalStorage (set by auth middleware
 * for HTTP requests, manually by background jobs). Skips logging when
 * there's no tenant context — script runs / CLI calls don't pollute
 * the dashboard.
 *
 * Design rules:
 *   - Never throws. Logger failures must not break the AI call.
 *   - Async; doesn't block the calling site.
 *   - Cost is computed once at write time using the active pricing
 *     table — historical rows reflect the rate at the time of the
 *     call (no retroactive recomputation).
 */

import { semanticDb } from '../db/knex';
import { getAiUserContext } from './aiBudget';
import { estimateCallCost, categoriseCall } from '../utils/aiPricing';
import { logger } from '../utils/logger';

export interface CallTelemetry {
  callLabel: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationMs: number;
  failed?: boolean;
  errorCode?: string | null;
}

/**
 * Persist one row to ai_call_log. Best-effort; swallows errors.
 *
 * Why not awaited: callers don't care about the insert latency.
 * Returning a promise that's discarded keeps the AI hot-path fast.
 * Logger failures are recorded to the structured logger only.
 */
export function logAiCall(call: CallTelemetry): void {
  const ctx = getAiUserContext();
  if (!ctx) return;   // no tenant context — skip silently (CLI / scripts)

  const cost = estimateCallCost(
    call.model,
    call.inputTokens,
    call.outputTokens,
    call.cacheReadTokens,
    call.cacheCreationTokens,
  );

  const category = categoriseCall(call.callLabel);
  const cacheUsed = call.cacheReadTokens > 0;

  // Fire-and-forget. tenantQuery isn't strictly needed because we set
  // tenant_id explicitly and RLS WITH CHECK happens via the default
  // expression (`current_setting('app.current_tenant', true)::integer`).
  // But we set tenant_id via the explicit value (from context) so we
  // don't depend on `app.current_tenant` being set on the connection.
  void (async () => {
    try {
      await semanticDb('ai_call_log').insert({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        model: call.model,
        call_label: call.callLabel,
        category,
        input_tokens: call.inputTokens,
        output_tokens: call.outputTokens,
        cache_read_tokens: call.cacheReadTokens,
        cache_creation_tokens: call.cacheCreationTokens,
        cost_usd: cost,
        duration_ms: call.durationMs,
        cache_used: cacheUsed,
        failed: !!call.failed,
        error_code: call.errorCode ?? null,
      });
    } catch (err) {
      logger.warn({ err, call }, 'aiCallLogger: insert failed (non-fatal)');
    }
  })();
}
