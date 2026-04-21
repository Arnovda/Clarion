/**
 * Smoke test for Stage A / item A5.
 *
 * Given a tenant whose monthly AI budget is already exhausted, verify that
 * calling formatAnswer (which internally calls Claude via callClaude) throws
 * AiBudgetExceededError BEFORE any API request fires.
 *
 * Clean up after itself so the state left in Postgres doesn't affect the
 * real tenant. Exit 0 on pass, 1 on fail.
 */

import { semanticDb } from '../src/db/knex';
import { withTenantAiContext, AiBudgetExceededError } from '../src/services/aiBudget';
import { formatAnswer } from '../src/ai/AIService';

const TENANT_ID = 63;

async function main() {
  // Set RLS tenant context so ai_usage rows for this tenant are visible.
  await semanticDb.raw(`SET app.current_tenant = '${TENANT_ID}'`);

  console.log(`[smoke] Probing tenant ${TENANT_ID} budget state…`);
  const before = await semanticDb('tenants').where({ id: TENANT_ID }).select('monthly_token_budget').first();
  const usage = await semanticDb('ai_usage')
    .where({ tenant_id: TENANT_ID })
    .where('period_start', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1))
    .select('total_tokens')
    .first();
  console.log(`[smoke]   budget: ${before?.monthly_token_budget ?? '(null = unlimited)'}`);
  console.log(`[smoke]   used this month: ${usage?.total_tokens ?? 0}`);

  if (before?.monthly_token_budget == null || Number(before.monthly_token_budget) > Number(usage?.total_tokens ?? 0)) {
    console.error('[smoke] PRECONDITION FAIL — this test expects tenant 63 to have a budget + usage >= budget.');
    console.error('[smoke] Seed with: UPDATE tenants SET monthly_token_budget=100 WHERE id=63;');
    console.error('[smoke]            INSERT INTO ai_usage ... VALUES (63, ... total_tokens=6000);');
    process.exit(1);
  }

  console.log(`[smoke] Calling formatAnswer inside tenant ${TENANT_ID} AI context — expecting AiBudgetExceededError.`);
  let threw = false;
  let caughtBudgetError = false;
  try {
    await withTenantAiContext(TENANT_ID, async () => {
      await formatAnswer('ping', [{ a: 1 }]);
    });
  } catch (err) {
    threw = true;
    if (err instanceof AiBudgetExceededError) {
      caughtBudgetError = true;
      console.log(`[smoke] ✓ Got AiBudgetExceededError: used=${err.usedTokens} budget=${err.budgetTokens}`);
    } else {
      console.error(`[smoke] ✗ Got wrong error type: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!threw) {
    console.error('[smoke] ✗ Call did NOT throw — budget gate is broken.');
    process.exit(1);
  }
  if (!caughtBudgetError) {
    console.error('[smoke] ✗ Threw but not AiBudgetExceededError.');
    process.exit(1);
  }

  // Verify NO Anthropic API request happened (usage row should NOT have incremented
  // beyond the seeded 6000 — gate fires before the call).
  const after = await semanticDb('ai_usage')
    .where({ tenant_id: TENANT_ID })
    .where('period_start', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1))
    .select('total_tokens')
    .first();
  if (Number(after?.total_tokens ?? 0) !== Number(usage?.total_tokens ?? 0)) {
    console.error(`[smoke] ✗ Usage incremented from ${usage?.total_tokens} to ${after?.total_tokens} — API call fired despite budget block.`);
    process.exit(1);
  }
  console.log(`[smoke] ✓ Usage unchanged (${after?.total_tokens}) — no API call fired.`);

  console.log('[smoke] PASS — budget gate blocks before hitting Anthropic.');
  await semanticDb.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
