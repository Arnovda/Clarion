/**
 * Anthropic pricing table — used to estimate cost from token counts.
 *
 * Prices are USD per 1M tokens. Subject to change; update when
 * Anthropic publishes new rates. Historical rows in `ai_call_log`
 * keep the cost computed at the time of the call (audit trail), so
 * updating these constants doesn't retroactively change past totals.
 *
 * Cache pricing convention (Anthropic Sonnet/Haiku 4.x):
 *   Regular input  → 1.00× input rate
 *   Cache write    → 1.25× input rate (premium for the first miss)
 *   Cache read     → 0.10× input rate (90% discount on hits)
 *   Output         → output rate (no cache pricing)
 */

interface ModelRates {
  /** USD per 1M regular input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

const RATES: Record<string, ModelRates> = {
  // Sonnet family — heavyweight reasoning + SQL gen
  'claude-sonnet-4-6':           { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5-20250929':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5':           { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-20241022':  { input: 3.00, output: 15.00 },

  // Haiku family — fast / cheap classifier + summariser
  'claude-haiku-4-5-20251001':   { input: 1.00, output: 5.00 },
  'claude-haiku-4-5':            { input: 1.00, output: 5.00 },
  'claude-3-5-haiku-20241022':   { input: 0.80, output: 4.00 },

  // Opus — heaviest reasoning, used rarely
  'claude-opus-4':               { input: 15.00, output: 75.00 },
};

/** Rates we apply when the model name doesn't match — defensive default
 *  set at Sonnet-tier so we never under-bill ourselves. */
const FALLBACK_RATES: ModelRates = { input: 3.00, output: 15.00 };

const CACHE_WRITE_MULTIPLIER = 1.25;   // 25% premium on first cache write
const CACHE_READ_MULTIPLIER  = 0.10;   // 90% discount on cache hits

/**
 * Compute the cost in USD for one Anthropic call.
 *
 * inputTokens = fresh input (full price)
 * cacheCreationTokens = portion that was written to cache (1.25× rate)
 * cacheReadTokens = portion served from cache (0.10× rate)
 * outputTokens = the model's output (output rate)
 *
 * Returns 0 for failed calls (where token counts are zero).
 */
export function estimateCallCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const rates = RATES[model] ?? FALLBACK_RATES;

  // Anthropic's `input_tokens` excludes the cached portions. So we
  // sum each pool at its own rate.
  const cost =
    (inputTokens          * rates.input)                                / 1_000_000 +
    (cacheCreationTokens  * rates.input * CACHE_WRITE_MULTIPLIER)       / 1_000_000 +
    (cacheReadTokens      * rates.input * CACHE_READ_MULTIPLIER)        / 1_000_000 +
    (outputTokens         * rates.output)                               / 1_000_000;

  return Math.max(0, cost);
}

/**
 * Map the call_label (which AIService passes through) to a higher-level
 * category for the cost dashboard. Categories let the UI group a
 * dozen distinct labels into "Ask AI questions" / "Investigations" /
 * etc., which is what users actually want to see.
 */
export function categoriseCall(label: string): string {
  const l = label.toLowerCase();

  // Investigate agent (the new multi-step "why?" flow)
  if (l.startsWith('investigate_plan_next') || l.startsWith('investigate_summarise') ||
      l.startsWith('investigate_conclude')) {
    return 'investigate';
  }
  // Legacy one-shot widget investigation — also "investigate" for the user.
  if (l === 'investigate_plan' || l === 'investigate_summary') return 'investigate';

  // Refine chat + product refinement
  if (l.startsWith('refine_')) return 'refine';

  // Dashboards
  if (l.startsWith('dashboard_') || l.startsWith('widget_') ||
      l === 'generate_dashboard_spec' || l === 'refine_dashboard' ||
      l === 'validate_dashboard_spec' || l === 'widget_semantic_check' ||
      l === 'narrate_dashboard') {
    return 'dashboard';
  }

  // Background features built on the new pulse
  if (l === 'morning_brief') return 'brief';
  if (l === 'query_starters') return 'starters';
  if (l === 'pulse_suggest') return 'pulse';

  // KPIs (manual + AI-assisted)
  if (l === 'kpi_draft') return 'kpi';

  // Tenant onboarding / schema design
  if (l.startsWith('schema_') || l.startsWith('table_context') ||
      l.startsWith('column_descriptions') || l.startsWith('relationship') ||
      l.startsWith('fk_') || l.startsWith('bus_matrix') || l.startsWith('star_schema') ||
      l === 'product_icon' || l === 'edit_column_expression') {
    return 'setup';
  }

  // Quality alerts
  if (l === 'quality_alert_context') return 'quality';

  // Forecasts + insights (less common features)
  if (l.startsWith('forecast_') || l.startsWith('insights_') || l === 'narrate') {
    return 'other';
  }

  // Default bucket: NL→SQL question chain (entity extraction, SQL gen,
  // result validation, answer formatting, repair). These are the
  // "question" calls that drive ~70% of cost.
  return 'question';
}

/** Public rate lookup — used by the admin dashboard to display the
 *  active pricing table so users understand where the numbers come from. */
export function getRatesForModel(model: string): ModelRates {
  return RATES[model] ?? FALLBACK_RATES;
}

export function listAllRates(): Array<{ model: string; rates: ModelRates }> {
  return Object.entries(RATES).map(([model, rates]) => ({ model, rates }));
}
