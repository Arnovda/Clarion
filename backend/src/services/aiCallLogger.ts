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

import { tenantQuery } from './tenantQuery';
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

  // Fire-and-forget, but through tenantQuery — this used to run on the bare
  // pool, and the comment that stood here had the RLS rule exactly backwards.
  // It argued that setting `tenant_id` explicitly meant we "don't depend on
  // app.current_tenant being set on the connection". The policy's WITH CHECK
  // compares the row's tenant_id AGAINST that session variable, so an explicit
  // value does not satisfy it — it makes the comparison `<value> = NULL`, and
  // the insert is refused with SQLSTATE 42501. The catch below then swallowed
  // it, so `ai_call_log` silently lost rows and the cost dashboard and the
  // monthly usage CSV under-reported. The 2026-09-10 prod-logs run is what
  // caught it; the identical misconception was also written into the
  // bare-pool ratchet's allowlist reason for aiBudget, so read this twice
  // before deciding any RLS table is safe on the root pool.
  void (async () => {
    try {
      await tenantQuery(ctx.tenantId, (trx) => trx('ai_call_log').insert({
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
      }));
    } catch (err) {
      logger.warn({ err, call }, 'aiCallLogger: insert failed (non-fatal)');
    }
  })();
}
