/**
 * The overnight investigation's target picker.
 *
 * This is pinned by test because it is THE COST LEVER. The investigation is
 * ~95% of what a night costs (measured: $0.065 of $0.068 per user per
 * night — docs/backlog/home-experience.md §7), so the rule that decides
 * whether the agent fires at all is the rule that decides the bill.
 *
 * The single most important assertion in this file is the first one: when
 * nothing breached its sensitivity threshold, NOTHING RUNS. A quiet morning
 * has to be free, or the feature becomes a standing charge on every tenant
 * for a page that says "nothing needs you".
 */

import { describe, it, expect } from 'vitest';
import { pickInvestigationTarget } from '../services/morningBriefService';
import type { BriefEntryDelta, MorningBriefOutput } from '../ai/prompts/morningBriefPrompt';

const delta = (over: Partial<BriefEntryDelta> = {}): BriefEntryDelta => ({
  pulse_entry_id: 1,
  label: 'Open receivables',
  kind: 'metric',
  sensitivity: 'medium',
  current_value: 84_200,
  prior_value: 65_000,
  prior_period_label: 'yesterday',
  delta_absolute: 19_200,
  delta_pct: 0.29,
  triggered: true,
  error_message: null,
  ...over,
});

const brief = (bullets: MorningBriefOutput['bullets']): MorningBriefOutput => ({
  summary: 'Scene setting.',
  bullets,
  suggested_focus: 'Look at receivables.',
  confidence: 'high',
});

const bullet = (
  label: string,
  kind: 'movement' | 'steady' | 'warn' = 'movement',
): MorningBriefOutput['bullets'][number] => ({
  kind, label, delta: '+29%', detail: `${label} moved.`,
});

describe('pickInvestigationTarget — the cost lever', () => {
  it('runs NOTHING when nothing breached its sensitivity threshold', () => {
    const target = pickInvestigationTarget(
      brief([bullet('Open receivables', 'steady')]),
      [delta({ triggered: false }), delta({ pulse_entry_id: 2, label: 'Revenue', triggered: false })],
    );
    // A quiet morning must cost zero. If this ever returns an entry, every
    // tenant pays ~$2/user/month for a page that says "nothing needs you".
    expect(target).toBeNull();
  });

  it('returns null when there are no entries at all', () => {
    expect(pickInvestigationTarget(brief([]), [])).toBeNull();
  });

  it('investigates the entry behind the brief’s own headline bullet', () => {
    // The model already ranked "most worth mentioning". Re-ranking here
    // would explain a different thing than the headline the user reads.
    const target = pickInvestigationTarget(
      brief([bullet('Revenue'), bullet('Open receivables')]),
      [
        delta({ pulse_entry_id: 1, label: 'Open receivables', delta_pct: 0.29 }),
        delta({ pulse_entry_id: 2, label: 'Revenue', delta_pct: 0.04 }),
      ],
    );
    expect(target?.label).toBe('Revenue');
    expect(target?.pulse_entry_id).toBe(2);
  });

  it('treats a warn bullet as a headline too', () => {
    const target = pickInvestigationTarget(
      brief([bullet('Cash', 'warn')]),
      [
        delta({ pulse_entry_id: 1, label: 'Open receivables', delta_pct: 0.9 }),
        delta({ pulse_entry_id: 2, label: 'Cash', delta_pct: 0.02 }),
      ],
    );
    expect(target?.label).toBe('Cash');
  });

  it('skips a steady bullet when picking the headline', () => {
    const target = pickInvestigationTarget(
      brief([bullet('Revenue', 'steady'), bullet('Cash')]),
      [
        delta({ pulse_entry_id: 1, label: 'Revenue', delta_pct: 0.5 }),
        delta({ pulse_entry_id: 2, label: 'Cash', delta_pct: 0.1 }),
      ],
    );
    expect(target?.label).toBe('Cash');
  });

  it('matches labels loosely — the brief writes them in the user’s words', () => {
    const target = pickInvestigationTarget(
      brief([bullet('  OPEN   Receivables  ')]),
      [delta({ label: 'Open receivables' })],
    );
    expect(target?.pulse_entry_id).toBe(1);
  });

  it('falls back to the biggest relative move when no bullet matches', () => {
    const target = pickInvestigationTarget(
      brief([bullet('Something else entirely')]),
      [
        delta({ pulse_entry_id: 1, label: 'Open receivables', delta_pct: 0.29 }),
        delta({ pulse_entry_id: 2, label: 'Purchase cost', delta_pct: -0.61 }),
      ],
    );
    // Biggest by MAGNITUDE — a 61% fall matters as much as a 61% rise.
    expect(target?.pulse_entry_id).toBe(2);
  });

  it('never picks an entry whose snapshot failed', () => {
    const target = pickInvestigationTarget(
      brief([bullet('Open receivables')]),
      [
        delta({ pulse_entry_id: 1, label: 'Open receivables', current_value: null, error_message: 'boom' }),
        delta({ pulse_entry_id: 2, label: 'Revenue', delta_pct: 0.07 }),
      ],
    );
    // Investigating a number we could not read wastes a whole agent loop.
    expect(target?.pulse_entry_id).toBe(2);
  });

  it('never picks an entry with no comparison to explain', () => {
    const target = pickInvestigationTarget(
      brief([bullet('Open receivables')]),
      [delta({ label: 'Open receivables', delta_pct: null, prior_value: null })],
    );
    expect(target).toBeNull();
  });

  it('picks exactly one, never one per movement', () => {
    const target = pickInvestigationTarget(
      brief([bullet('A'), bullet('B'), bullet('C')]),
      [
        delta({ pulse_entry_id: 1, label: 'A', delta_pct: 0.2 }),
        delta({ pulse_entry_id: 2, label: 'B', delta_pct: 0.3 }),
        delta({ pulse_entry_id: 3, label: 'C', delta_pct: 0.4 }),
      ],
    );
    expect(target).not.toBeNull();
    expect(target?.label).toBe('A');
  });
});
