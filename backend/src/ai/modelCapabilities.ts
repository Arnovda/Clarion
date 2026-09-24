/**
 * What each Claude model accepts, and how a request must be shaped for it.
 *
 * The request surface changed between generations, and the change is not
 * cosmetic — a request shaped for one generation is REJECTED by the next:
 *
 *   - Sonnet 5 / Opus 4.7+ / Opus 5 / Fable refuse `temperature`, `top_p`
 *     and `top_k` (400). Sonnet 4.6 and Haiku 4.5 still accept them.
 *   - Sonnet 5 / Opus 4.7+ refuse `thinking: {type:'enabled', budget_tokens}`
 *     (400). The replacement is `thinking: {type:'adaptive'}` + an effort
 *     level in `output_config`. Sonnet 4.6 accepts both; Haiku 4.5 only the
 *     budget form.
 *   - Sonnet 5 / Opus 5 / Fable THINK when `thinking` is omitted (Sonnet 4.6
 *     does not), and the thinking counts against `max_tokens` — so a call
 *     tuned to a tight output budget on 4.6 can come back truncated, or with
 *     a thinking block first and no text at all.
 *   - On those same models `thinking.display` defaults to "omitted": the
 *     thinking blocks stream with empty text. A surface that shows the
 *     reasoning live has to ask for "summarized".
 *
 * This module is the ONE place those rules live, so switching the model
 * (CLAUDE_MODEL, `.ops/claude-model`, or a per-category override on
 * /admin/ai-usage) cannot turn into a 400 on some call site nobody
 * remembered. Pure — no I/O — and pinned by modelCapabilities.test.ts.
 */

export type Effort = 'low' | 'medium' | 'high';

/** The main model: SQL generation, dashboards, subject design, investigations. */
export function mainModel(): string {
  return process.env.CLAUDE_MODEL || 'claude-sonnet-5';
}

/** The light model: formatting, result checks, briefs, drafts. */
export function lightModel(): string {
  return process.env.CLAUDE_MODEL_HAIKU || 'claude-haiku-4-5-20251001';
}

// Model families by the generation that changed the rules. Matched on the
// id prefix so a dated snapshot (`claude-haiku-4-5-20251001`) and a Bedrock
// style id without the date both land in the right family.
const NEW_SURFACE = /^claude-(sonnet-5|opus-4-7|opus-4-8|opus-5|fable|mythos)/;
const THINKS_BY_DEFAULT = /^claude-(sonnet-5|opus-5|fable|mythos)/;
const ADAPTIVE = /^claude-(sonnet-5|sonnet-4-6|opus-4-6|opus-4-7|opus-4-8|opus-5|fable|mythos)/;
const EFFORT = /^claude-(sonnet-5|sonnet-4-6|opus-4-5|opus-4-6|opus-4-7|opus-4-8|opus-5|fable|mythos)/;
/** Models whose thinking.display defaults to "omitted" (empty thinking text). */
const DISPLAY_OMITTED_BY_DEFAULT = NEW_SURFACE;

/** Does the model accept `temperature` (and top_p / top_k)? */
export function acceptsSampling(model: string): boolean {
  return !NEW_SURFACE.test(model);
}

/** Does the model support `thinking: {type:'adaptive'}`? */
export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE.test(model);
}

/** Does the model think when the request says nothing about thinking? */
export function thinksByDefault(model: string): boolean {
  return THINKS_BY_DEFAULT.test(model);
}

/** Does the model accept `output_config.effort`? (Haiku 4.5 does not.) */
export function supportsEffort(model: string): boolean {
  return EFFORT.test(model);
}

/**
 * Room added to `max_tokens` when the model may think before it answers.
 * `max_tokens` is a cap, not a charge: a call that thinks little pays for
 * little. Without the headroom a call tuned to 600 output tokens on Sonnet
 * 4.6 can spend them all thinking on Sonnet 5 and return nothing.
 */
export const THINKING_HEADROOM_TOKENS = 8000;

/**
 * The SDK refuses a NON-streaming request whose max_tokens implies more
 * than ten minutes of generation (60·60·max/128000 > 600 → max > 21 333).
 * Stay under it; the calls that need more stream.
 */
export const NON_STREAMING_MAX_TOKENS = 21000;

export interface ShapeInput {
  model: string;
  /** The output budget the call site was tuned for. */
  maxTokens: number;
  /** The caller's temperature, if any — dropped where the model refuses it. */
  temperature?: number;
  /**
   * How hard to think where the model thinks. Defaults: 'low' for ordinary
   * calls (on Sonnet 5, 'low' still thinks when the task needs it, and
   * 'medium' is roughly Sonnet 4.6 at its default), 'medium' for the
   * visible-reasoning calls.
   */
  effort?: Effort;
  streaming: boolean;
  /**
   * 'visible' — the reasoning is part of the product (Ask AI's live
   *   thinking, the build page's "Show the working"): think on every model
   *   that can, and stream it summarized.
   * 'auto' (default) — behave as the call always did: no thinking on a model
   *   that does not think unprompted; adaptive + effort on one that does.
   */
  thinking?: 'visible' | 'auto';
}

export interface ShapedParams {
  max_tokens: number;
  temperature?: number;
  thinking?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
}

/**
 * The model-dependent part of a Messages request. The caller spreads it
 * into its params alongside model/system/messages.
 */
export function shapeRequest(input: ShapeInput): ShapedParams {
  const { model, maxTokens, streaming } = input;
  const mode = input.thinking ?? 'auto';
  const out: ShapedParams = { max_tokens: maxTokens };

  if (input.temperature !== undefined && acceptsSampling(model)) {
    out.temperature = input.temperature;
  }

  const ceiling = streaming ? 128000 : NON_STREAMING_MAX_TOKENS;
  const withHeadroom = (base: number) => Math.max(base, Math.min(base + THINKING_HEADROOM_TOKENS, ceiling));

  if (mode === 'visible') {
    if (supportsAdaptiveThinking(model)) {
      out.thinking = DISPLAY_OMITTED_BY_DEFAULT.test(model)
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'adaptive' };
      if (supportsEffort(model)) out.output_config = { effort: input.effort ?? 'medium' };
      out.max_tokens = withHeadroom(maxTokens);
    } else if (!NEW_SURFACE.test(model)) {
      // Older models (Haiku 4.5 via an override): the budget form, which
      // must leave room for the answer itself.
      const budget = Math.min(8000, Math.max(1024, maxTokens - 1024));
      out.thinking = { type: 'enabled', budget_tokens: budget };
      out.max_tokens = Math.max(maxTokens, budget + 1024);
    }
    return out;
  }

  if (thinksByDefault(model)) {
    out.thinking = { type: 'adaptive' };
    if (supportsEffort(model)) out.output_config = { effort: input.effort ?? 'low' };
    out.max_tokens = withHeadroom(maxTokens);
  }
  return out;
}

/**
 * The answer text of a Messages response: every text block, in order.
 * Thinking blocks come FIRST on a model that thinks, so `content[0]` is not
 * the answer any more — reading it was how a Sonnet 5 reply would have
 * surfaced as "unexpected non-text response".
 */
export function responseText(message: {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}): string {
  const text = message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (text) return text;
  if (message.stop_reason === 'refusal') {
    throw new Error('AIService: the model declined this request');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('AIService: the model used its whole output budget before answering');
  }
  throw new Error('AIService: unexpected non-text response from Claude');
}
