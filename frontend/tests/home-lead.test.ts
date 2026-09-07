/**
 * The lead is the most important copy in the product — it is the largest
 * type on the landing page and it decides whether anyone opens Clarion
 * tomorrow. It is derived in a pure function precisely so every state can
 * be pinned here rather than only the happy path being exercised by hand.
 *
 * The load-bearing assertions, in order of what would hurt most to lose:
 *   1. The lead is NEVER a number about the platform. (The page this
 *      replaced led with `73 / 100`.)
 *   2. A quiet morning renders as quiet — no cards invented from steady
 *      bullets. A briefing that always finds three things is one nobody
 *      believes.
 *   3. A cold start says what happens tonight instead of rendering empty.
 *   4. When the overnight investigation concluded, its conclusion wins over
 *      the bullet's own detail — that is the whole point of R2.
 */

import { describe, it, expect } from 'vitest';
import { deriveLead, deriveOpsLine, firstSentence, isWorthACard } from '../app/home/lead';
import type { Brief, BriefBullet, PulseTile } from '../app/home/types';

const bullet = (over: Partial<BriefBullet> = {}): BriefBullet => ({
  kind: 'movement', label: 'Open receivables', delta: '+29%',
  detail: 'Overdue receivables rose €19k in nine days.', ...over,
});

const briefWith = (bullets: BriefBullet[], investigation?: Brief['investigation']): Brief => ({
  id: 1, brief_date: '2026-09-07',
  content: { summary: 'Scene setting sentence one. And a second one.', bullets, suggested_focus: 'Check receivables.', confidence: 'high' },
  opened_at: null, emailed_at: null, created_at: '2026-09-07T06:00:00Z',
  investigation,
});

const tile = (over: Partial<PulseTile> = {}): PulseTile => ({
  id: 10, label: 'Open receivables', productName: 'Finance', kind: 'metric',
  sensitivity: 'high', frequency: 'daily', currentValue: 84200,
  currentValueLabel: '€84,200', asOf: '2026-09-07',
  prior: { value: 65000, label: '€65,000', period: 'yesterday', deltaAbs: 19200, deltaPct: 0.29, direction: 'up' },
  priorWeek: null, sparkline: [], latestBriefBullet: null,
  status: 'ok', errorMessage: null, consecutiveFailures: 0, lastErrorAt: null,
  links: { productId: 3, kpiId: 4 }, ...over,
});

const CONNECTED = { sourceCount: 1, newestSyncAt: '2026-09-05T18:00:00Z' };

describe('deriveLead', () => {
  it('leads with a sentence about the business, never a score', () => {
    const lead = deriveLead({ ...CONNECTED, brief: briefWith([bullet()]), tiles: [tile()] });
    expect(lead.tone).toBe('moved');
    expect(lead.headline).toBe('Overdue receivables rose €19k in nine days.');
    // The defect this whole redesign exists to remove: a bare platform score.
    expect(lead.headline).not.toMatch(/\d+\s*\/\s*100/);
    expect(lead.headline).not.toMatch(/health/i);
  });

  it('uses the overnight investigation’s conclusion when it concluded (R2)', () => {
    const lead = deriveLead({
      ...CONNECTED,
      brief: briefWith([bullet()], {
        id: 5, question: 'Why did Open receivables change?', pulseEntryId: 10,
        status: 'concluded', stepCount: 4, conclusionConfidence: 'high',
        conclusion: 'Three invoices are 62% of it, all from one customer. Worth a call.',
      }),
      tiles: [tile()],
    });
    expect(lead.headline).toBe('Three invoices are 62% of it, all from one customer.');
    expect(lead.sub).toContain('Already looked into');
  });

  it('ignores an investigation that has not concluded', () => {
    const lead = deriveLead({
      ...CONNECTED,
      brief: briefWith([bullet()], {
        id: 5, question: 'Why?', pulseEntryId: 10, status: 'running',
        conclusion: null, conclusionConfidence: null, stepCount: 2,
      }),
      tiles: [tile()],
    });
    expect(lead.headline).toBe('Overdue receivables rose €19k in nine days.');
    expect(lead.sub).not.toContain('Already looked into');
  });

  it('a quiet morning is a quiet morning — no cards invented from steady bullets', () => {
    const lead = deriveLead({
      ...CONNECTED,
      brief: briefWith([bullet({ kind: 'steady', delta: '—' }), bullet({ kind: 'steady', label: 'Revenue' })]),
      tiles: [tile()],
    });
    expect(lead.tone).toBe('quiet');
    expect(lead.cards).toHaveLength(0);
    expect(lead.headline).toMatch(/Nothing needs you/);
  });

  it('a warn bullet still earns a card', () => {
    const lead = deriveLead({
      ...CONNECTED,
      brief: briefWith([bullet({ kind: 'steady' }), bullet({ kind: 'warn', label: 'Cash' })]),
      tiles: [],
    });
    expect(lead.tone).toBe('moved');
    expect(lead.cards.map((c) => c.label)).toEqual(['Cash']);
  });

  it('cold start sells the mechanism rather than rendering an empty page', () => {
    const lead = deriveLead({ brief: null, tiles: [], sourceCount: 0, newestSyncAt: null });
    expect(lead.tone).toBe('cold');
    expect(lead.headline).toMatch(/Ask me something/);
    expect(lead.sub).toEqual(['No source connected yet']);
  });

  it('a connected source with no data yet is still cold, and says so differently', () => {
    const lead = deriveLead({ brief: null, tiles: [], sourceCount: 1, newestSyncAt: null });
    expect(lead.tone).toBe('cold');
    expect(lead.sub).toEqual(['Connected — waiting for the first data to land']);
  });

  it('distinguishes "waiting on tonight" from "waiting on you"', () => {
    const nobodyWatching = deriveLead({ ...CONNECTED, brief: null, tiles: [] });
    expect(nobodyWatching.tone).toBe('waiting');
    expect(nobodyWatching.headline).toMatch(/Tell me what to keep an eye on/);

    const watching = deriveLead({ ...CONNECTED, brief: null, tiles: [tile()] });
    expect(watching.tone).toBe('waiting');
    expect(watching.headline).toMatch(/what changed/);
    expect(watching.sub).toContain('Watching 1 thing');
  });

  it('never emphasises a whole clause — only the movement, when there is one', () => {
    const withDelta = deriveLead({ ...CONNECTED, brief: briefWith([bullet()]), tiles: [tile()] });
    expect(withDelta.emphasis).toBe('+29%');
    const withoutDelta = deriveLead({ ...CONNECTED, brief: briefWith([bullet({ delta: '—' })]), tiles: [tile()] });
    expect(withoutDelta.emphasis).toBeNull();
  });
});

describe('firstSentence', () => {
  it('takes the first sentence when the model ran two together', () => {
    expect(firstSentence('Revenue fell 4%. It is one customer.')).toBe('Revenue fell 4%.');
  });
  it('leaves a single sentence alone, decimals and all', () => {
    expect(firstSentence('Margin slipped to 31.2% on Beverages')).toBe('Margin slipped to 31.2% on Beverages');
  });
  it('survives empty input', () => {
    expect(firstSentence('   ')).toBe('');
  });
});

describe('isWorthACard', () => {
  it('admits movement and warn, refuses steady', () => {
    expect(isWorthACard(bullet({ kind: 'movement' }))).toBe(true);
    expect(isWorthACard(bullet({ kind: 'warn' }))).toBe(true);
    expect(isWorthACard(bullet({ kind: 'steady' }))).toBe(false);
  });
});

describe('deriveOpsLine', () => {
  it('says what staleness costs the reader, never a score about us', () => {
    const ops = deriveOpsLine({
      newestSyncAt: '2026-09-05T18:00:00Z',
      staleSources: [{ id: 1, name: 'Exact Online' }],
      staleProductCount: 5, sourceCount: 1,
    });
    expect(ops?.problem).toBe("Exact Online hasn't sent anything in over a day.");
    // The thing the health ring said instead, which read as catastrophic
    // during the entirely normal state of a monthly-close dataset.
    expect(JSON.stringify(ops)).not.toMatch(/0\s*\/\s*100|Freshness \d/);
  });

  it('falls back to subjects when every source is fresh', () => {
    const ops = deriveOpsLine({
      newestSyncAt: '2026-09-07T06:00:00Z', staleSources: [], staleProductCount: 2, sourceCount: 1,
    });
    expect(ops?.problem).toBe('2 subjects are waiting on a refresh.');
  });

  it('says nothing when there is nothing to say', () => {
    const ops = deriveOpsLine({
      newestSyncAt: '2026-09-07T06:00:00Z', staleSources: [], staleProductCount: 0, sourceCount: 1,
    });
    expect(ops?.problem).toBeNull();
    expect(ops?.asOf).toBe('2026-09-07T06:00:00Z');
  });

  it('renders nothing at all before a source exists', () => {
    expect(deriveOpsLine({ newestSyncAt: null, staleSources: [], staleProductCount: 0, sourceCount: 0 })).toBeNull();
  });

  it('names the count, not every source, once more than one is stale', () => {
    const ops = deriveOpsLine({
      newestSyncAt: '2026-09-01T00:00:00Z',
      staleSources: [{ id: 1, name: 'Exact' }, { id: 2, name: 'Odoo' }],
      staleProductCount: 0, sourceCount: 2,
    });
    expect(ops?.problem).toBe("2 sources haven't sent anything in over a day.");
  });
});
