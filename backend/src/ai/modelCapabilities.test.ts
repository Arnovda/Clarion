import { describe, it, expect } from 'vitest';
import {
  acceptsSampling, supportsAdaptiveThinking, thinksByDefault, supportsEffort,
  shapeRequest, responseText, THINKING_HEADROOM_TOKENS, NON_STREAMING_MAX_TOKENS,
  APPROVED_ANTHROPIC_MODELS, isApprovedAnthropicModel, mainModel, lightModel,
} from './modelCapabilities';
import { listAllRates } from '../utils/aiPricing';

describe('model capabilities', () => {
  it('knows which generation refuses sampling parameters', () => {
    expect(acceptsSampling('claude-sonnet-4-6')).toBe(true);
    expect(acceptsSampling('claude-haiku-4-5-20251001')).toBe(true);
    expect(acceptsSampling('claude-sonnet-5')).toBe(false);
    expect(acceptsSampling('claude-opus-4-8')).toBe(false);
    expect(acceptsSampling('claude-opus-5')).toBe(false);
  });

  it('knows who thinks unprompted and who takes adaptive thinking and effort', () => {
    expect(thinksByDefault('claude-sonnet-5')).toBe(true);
    expect(thinksByDefault('claude-sonnet-4-6')).toBe(false);
    expect(thinksByDefault('claude-haiku-4-5-20251001')).toBe(false);
    expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    expect(supportsAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false);
    expect(supportsEffort('claude-haiku-4-5-20251001')).toBe(false);
    expect(supportsEffort('claude-sonnet-5')).toBe(true);
  });
});

describe('shapeRequest', () => {
  it('Sonnet 5: drops temperature, thinks adaptively at low effort, adds headroom', () => {
    const p = shapeRequest({ model: 'claude-sonnet-5', maxTokens: 600, temperature: 0, streaming: false });
    expect(p.temperature).toBeUndefined();
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.max_tokens).toBe(600 + THINKING_HEADROOM_TOKENS);
    // Never a fixed budget — Sonnet 5 answers that with a 400.
    expect(JSON.stringify(p)).not.toContain('budget_tokens');
  });

  it('stays under the SDK non-streaming ceiling, but never below what the call needs', () => {
    const p = shapeRequest({ model: 'claude-sonnet-5', maxTokens: 16000, streaming: false });
    expect(p.max_tokens).toBe(NON_STREAMING_MAX_TOKENS);
    const big = shapeRequest({ model: 'claude-sonnet-5', maxTokens: 64000, streaming: true });
    expect(big.max_tokens).toBe(64000 + THINKING_HEADROOM_TOKENS);
  });

  it('Sonnet 4.6 (the rollback target): exactly the old request — temperature kept, no thinking', () => {
    const p = shapeRequest({ model: 'claude-sonnet-4-6', maxTokens: 600, temperature: 0, streaming: false });
    expect(p).toEqual({ max_tokens: 600, temperature: 0 });
  });

  it('Haiku 4.5: temperature kept, no thinking, no effort', () => {
    const p = shapeRequest({ model: 'claude-haiku-4-5-20251001', maxTokens: 300, temperature: 0, streaming: false, effort: 'high' });
    expect(p).toEqual({ max_tokens: 300, temperature: 0 });
  });

  it('visible reasoning: summarized on Sonnet 5 so the stream is not empty', () => {
    const p = shapeRequest({ model: 'claude-sonnet-5', maxTokens: 16000, streaming: true, thinking: 'visible', effort: 'medium' });
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.output_config).toEqual({ effort: 'medium' });
  });

  it('visible reasoning on Sonnet 4.6: adaptive, no display override (it already summarizes)', () => {
    const p = shapeRequest({ model: 'claude-sonnet-4-6', maxTokens: 16000, streaming: true, thinking: 'visible' });
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config).toEqual({ effort: 'medium' });
  });

  it('visible reasoning on Haiku (via an override): the budget form, leaving room to answer', () => {
    const p = shapeRequest({ model: 'claude-haiku-4-5-20251001', maxTokens: 16000, streaming: true, thinking: 'visible' });
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
    expect(p.max_tokens).toBeGreaterThan(8000);
    expect(p.output_config).toBeUndefined();
  });
});

describe('responseText', () => {
  it('reads the text after a thinking block, not content[0]', () => {
    expect(responseText({
      content: [{ type: 'thinking', text: undefined }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }],
      stop_reason: 'end_turn',
    })).toBe('{"a":1}');
  });

  it('says why when there is no answer', () => {
    expect(() => responseText({ content: [{ type: 'thinking' }], stop_reason: 'max_tokens' }))
      .toThrow(/whole output budget/);
    expect(() => responseText({ content: [], stop_reason: 'refusal' })).toThrow(/declined/);
  });
});

describe('the approved model list', () => {
  it('holds the platform defaults, so the default is always choosable', () => {
    expect(isApprovedAnthropicModel(mainModel())).toBe(true);
    expect(isApprovedAnthropicModel(lightModel())).toBe(true);
    expect(isApprovedAnthropicModel('claude-sonnet-4-6')).toBe(true); // the rollback target
    expect(isApprovedAnthropicModel('claude-3-opus-20240229')).toBe(false);
    expect(isApprovedAnthropicModel('')).toBe(false);
  });

  it('only lists models the cost page has a price for', () => {
    // Without a row the cost page falls back to Sonnet 4.6 rates — a model
    // an admin can pick must never be silently mispriced.
    const priced = new Set(listAllRates().map((r) => r.model));
    for (const m of APPROVED_ANTHROPIC_MODELS) expect(priced.has(m.id), m.id).toBe(true);
  });

  it('every approved model gets a request it accepts', () => {
    for (const { id } of APPROVED_ANTHROPIC_MODELS) {
      const p = shapeRequest({ model: id, maxTokens: 16000, temperature: 0, streaming: true, thinking: 'visible' });
      if (!acceptsSampling(id)) expect(p.temperature, id).toBeUndefined();
      if (supportsAdaptiveThinking(id)) expect(JSON.stringify(p), id).not.toContain('budget_tokens');
    }
  });
});
