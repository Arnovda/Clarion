/**
 * One-shot live verification of Anthropic structured outputs for dashboards.
 *
 * There is no staging environment — this script is the safe substitute.
 * It makes ONE real Claude call (~a cent) using the exact mechanism the
 * AI_STRUCTURED_OUTPUTS=1 flag activates in AIService.callClaude:
 *   - the pinned @anthropic-ai/sdk (params passed via cast, since the SDK
 *     version predates the feature),
 *   - the `structured-outputs-2025-11-13` beta header,
 *   - `output_format: { type: 'json_schema', schema: DASHBOARD_SPEC_JSON_SCHEMA }`,
 *   - the REAL dashboard system prompt.
 *
 * Run it anywhere with the API key available (your machine, or the prod
 * container via a shell):
 *
 *   cd backend && npx tsx scripts/verify-structured-outputs.ts
 *
 * PASS  → flip AI_STRUCTURED_OUTPUTS=1 on the live backend with confidence.
 * FAIL  → leave the flag unset (live behaviour is unchanged) and report the
 *         printed error — the likely fix is an SDK version bump.
 *
 * It does NOT touch the database, the warehouse, or any tenant data.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { getDashboardSystem } from '../src/ai/prompts/dashboardPrompt';
import { DASHBOARD_SPEC_JSON_SCHEMA, AI_OUTPUT_SCHEMAS } from '../src/ai/outputSchemas';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    console.error('FAIL: ANTHROPIC_API_KEY is not set (checked env + backend/.env).');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const userPrompt = `User request: "revenue overview"

━━━ Schema context ━━━
Table orders (fact, grain: one row per order)
  Columns:
    order_date (DATE): Order date
    amount (DECIMAL) [m,additive]: Order amount in EUR
    customer_name (VARCHAR): Customer name
    status (VARCHAR): Order status

━━━ Relationships ━━━
(none)

Generate a SMALL dashboard: exactly 1 filter and 2 widgets (one kpi_card, one bar_chart).`;

  console.log(`Calling ${MODEL} with output_format + beta header…`);
  const start = Date.now();

  let message: Anthropic.Message;
  try {
    message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        temperature: 0,
        system: getDashboardSystem('duckdb'),
        messages: [{ role: 'user', content: userPrompt }],
        output_format: { type: 'json_schema', schema: DASHBOARD_SPEC_JSON_SCHEMA },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { headers: { 'anthropic-beta': 'structured-outputs-2025-11-13' } },
    );
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error(`\nFAIL: API rejected the structured-outputs request (HTTP ${status ?? '?'}).`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\nLeave AI_STRUCTURED_OUTPUTS unset. Likely fix: bump @anthropic-ai/sdk.');
    process.exit(1);
  }

  const block = message.content[0];
  if (!block || block.type !== 'text') {
    console.error(`\nFAIL: unexpected response block type: ${block?.type ?? 'none'}`);
    process.exit(1);
  }

  // The whole point of structured outputs: this parse can no longer fail.
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    console.error('\nFAIL: response text is not valid JSON — constrained decoding did not apply.');
    console.error(block.text.slice(0, 400));
    process.exit(1);
  }

  const result = AI_OUTPUT_SCHEMAS.dashboardSpec.safeParse(parsed);
  if (!result.success) {
    console.error('\nFAIL: JSON parsed but did not match the dashboard Zod schema:');
    console.error(result.error.issues.slice(0, 5));
    process.exit(1);
  }

  const spec = result.data;
  console.log(`\nPASS  (${((Date.now() - start) / 1000).toFixed(1)}s, ` +
    `${message.usage?.input_tokens ?? '?'} in / ${message.usage?.output_tokens ?? '?'} out tokens)`);
  console.log(`  title:   ${spec.title}`);
  console.log(`  filters: ${spec.filters.length}  widgets: ${spec.widgets.map((w) => w.type).join(', ')}`);
  console.log('\nSafe to set AI_STRUCTURED_OUTPUTS=1 on the live backend.');
}

main().catch((err) => {
  console.error('FAIL (unexpected):', err);
  process.exit(1);
});
