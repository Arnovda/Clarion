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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { hasOpenedRecently, pickInvestigationTarget } from '../services/morningBriefService';
import { registerUser } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
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

// ─── The wiring ─────────────────────────────────────────────────────────────
//
// `pickInvestigationTarget` being correct is worth nothing if nobody calls
// it. Every test above would still pass with the overnight run deleted from
// `generateBriefForUser` — the feature would simply stop existing, silently.
//
// A SOURCE-level assertion is the cheap way to close that: driving the real
// thing would need a warehouse, an AI client and a full agent loop, which is
// a live-tenant check (see the doc), not a unit test. This at least makes
// removing the call a red build rather than a quiet regression. It is the
// same trick `authoring-surface-guard.test.ts` uses for the SQL guard.

describe('the overnight investigation is actually wired in', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'morningBriefService.ts'),
    'utf8',
  );

  /**
   * The BODY of generateBriefForUser, bounded at the next top-level export.
   *
   * Bounding matters: slicing to end-of-file also swallows the definition of
   * `runOvernightInvestigation` itself, so every assertion below would match
   * the declaration instead of the call and could never fail. The first
   * version of this file did exactly that — three of these four tests passed
   * with the call deleted.
   */
  const body = (() => {
    const start = src.indexOf('export async function generateBriefForUser');
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nexport ', start + 1);
    return src.slice(start, next > -1 ? next : undefined);
  })();

  it('generateBriefForUser calls runOvernightInvestigation', () => {
    expect(body).toContain('runOvernightInvestigation(');
  });

  it('the brief is persisted BEFORE the investigation runs', () => {
    // Order matters: the agent loop can take a minute and can throw. If it
    // ran first, a failure would cost the user their brief entirely.
    const insertAt = body.indexOf("trx('morning_briefs').insert");
    const investigateAt = body.indexOf('runOvernightInvestigation(');
    expect(insertAt).toBeGreaterThan(-1);
    expect(investigateAt).toBeGreaterThan(insertAt);
  });

  it('the call is wrapped so a failure cannot take the brief down with it', () => {
    const around = body.slice(
      Math.max(0, body.indexOf('runOvernightInvestigation(') - 200),
      body.indexOf('runOvernightInvestigation(') + 300,
    );
    expect(around).toContain('try {');
    expect(around).toContain('catch');
  });

  it('both cost gates are present in the runner and neither can be dropped silently', () => {
    const start = src.indexOf('export async function runOvernightInvestigation');
    const next = src.indexOf('\nexport ', start + 1);
    const fn = src.slice(start, next > -1 ? next : undefined);
    expect(fn).toContain('pickInvestigationTarget(');   // quiet night → no run
    expect(fn).toContain('hasOpenedRecently(');          // dormant reader → no run
  });
});

// ─── The second cost gate: is anyone reading? ───────────────────────────────
//
// `triggered` stops us paying on a quiet morning. This gate stops us paying
// every morning for a dormant account, which would otherwise accrue
// ~$2/user/month for an answer nobody opens — the "standing charge" failure
// the whole design is trying to avoid.

describe('hasOpenedRecently — the dormancy gate', () => {
  let tenantId: number;
  let userId: number;

  beforeAll(async () => {
    await cleanTestDb();
    const admin = await registerUser({ email: 'overnight@test.com', companyName: 'OvernightCo' });
    tenantId = admin.user.tenantId;
    userId = admin.user.id;
  });

  afterAll(async () => { await closeTestDb(); });

  const seed = async (rows: Array<{ daysAgo: number; opened: boolean }>) => {
    const db = getTestDb();
    await db('morning_briefs').where({ tenant_id: tenantId, user_id: userId }).del();
    for (const r of rows) {
      const d = new Date(Date.now() - r.daysAgo * 86_400_000);
      await db('morning_briefs').insert({
        tenant_id: tenantId, user_id: userId,
        brief_date: d.toISOString().slice(0, 10),
        content: JSON.stringify({ summary: '', bullets: [], suggested_focus: '', confidence: 'low' }),
        opened_at: r.opened ? d : null,
        created_at: d,
      });
    }
  };

  it('a brand-new user with no history counts as active', async () => {
    await seed([]);
    // Their first morning is the one that decides whether they come back.
    // Withholding the good version of it to save four cents is the wrong
    // trade, so no history means investigate.
    expect(await hasOpenedRecently(tenantId, userId, 7)).toBe(true);
  });

  it('someone who opened a brief inside the window is active', async () => {
    await seed([{ daysAgo: 2, opened: true }, { daysAgo: 1, opened: false }]);
    expect(await hasOpenedRecently(tenantId, userId, 7)).toBe(true);
  });

  it('someone whose last open is outside the window is dormant', async () => {
    await seed([{ daysAgo: 30, opened: true }, { daysAgo: 1, opened: false }]);
    expect(await hasOpenedRecently(tenantId, userId, 7)).toBe(false);
  });

  it('gives a user who has never opened one the window’s worth of chances', async () => {
    // Three briefs, never opened — still inside the grace period.
    await seed([{ daysAgo: 3, opened: false }, { daysAgo: 2, opened: false }, { daysAgo: 1, opened: false }]);
    expect(await hasOpenedRecently(tenantId, userId, 7)).toBe(true);

    // Ten briefs, never opened once. Stop paying.
    await seed(Array.from({ length: 10 }, (_, i) => ({ daysAgo: i + 1, opened: false })));
    expect(await hasOpenedRecently(tenantId, userId, 7)).toBe(false);
  });

  it('days = 0 disables the gate entirely', async () => {
    await seed([{ daysAgo: 90, opened: true }]);
    expect(await hasOpenedRecently(tenantId, userId, 0)).toBe(true);
  });
});
