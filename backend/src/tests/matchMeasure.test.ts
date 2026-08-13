import { describe, it, expect, vi } from 'vitest';
import { measureMatch } from '../services/matchMeasure';

/**
 * A connector that answers the two statements a match measurement issues, told
 * apart by whether they select the `side` marker the sample query uses.
 */
function fakeConnector(opts: {
  counts?: { a_total: number; b_total: number; a_matched: number; b_matched: number };
  samples?: Array<{ side: string; v: string }>;
  throwOn?: 'counts' | 'samples';
  delayMs?: number;
}) {
  const queries: string[] = [];
  return {
    queries,
    async executeQuery(sql: string) {
      queries.push(sql);
      const isSamples = sql.includes("'a' AS side");
      if (opts.throwOn === 'counts' && !isSamples) throw new Error('no such table');
      if (opts.throwOn === 'samples' && isSamples) throw new Error('conversion error');
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { rows: isSamples ? (opts.samples ?? []) : [opts.counts ?? {}] };
    },
  };
}

const COUNTS = { a_total: 900, b_total: 850, a_matched: 812, b_matched: 812 };
const SAMPLES = [
  { side: 'a', v: 'BE0999888777' },
  { side: 'a', v: 'BE0111222333' },
  { side: 'b', v: 'NL812345678B01' },
];

describe('measureMatch', () => {
  it('reports the match rate from the left side', async () => {
    const conn = fakeConnector({ counts: COUNTS, samples: SAMPLES });
    const m = await measureMatch(conn, 'vat_number', 'vat');

    expect(m.ok).toBe(true);
    expect(m.left).toMatchObject({ total: 900, matched: 812 });
    expect(m.right).toMatchObject({ total: 850, matched: 812 });
    expect(m.matchRate).toBeCloseTo(812 / 900, 5);
  });

  it('splits the unmatched samples by side', async () => {
    // The samples are the useful part: seeing WHICH values missed is what tells
    // the user whether it is a formatting problem or a data problem.
    const conn = fakeConnector({ counts: COUNTS, samples: SAMPLES });
    const m = await measureMatch(conn, 'vat_number', 'vat');

    expect(m.left!.unmatchedSample).toEqual(['BE0999888777', 'BE0111222333']);
    expect(m.right!.unmatchedSample).toEqual(['NL812345678B01']);
  });

  it('strips punctuation and case by default', async () => {
    // Two systems almost never format a VAT number the same way. Comparing raw
    // strings understates the real overlap, and understating it is what makes
    // someone conclude their data cannot be joined when it can.
    const conn = fakeConnector({ counts: COUNTS });
    await measureMatch(conn, 'vat_number', 'vat', 'loose');

    expect(conn.queries[0]).toContain('REGEXP_REPLACE');
    expect(conn.queries[0]).toContain('UPPER');
  });

  it('compares verbatim when asked for an exact match', async () => {
    const conn = fakeConnector({ counts: COUNTS });
    await measureMatch(conn, 'code', 'code', 'exact');

    expect(conn.queries[0]).not.toContain('REGEXP_REPLACE');
    expect(conn.queries[0]).toContain('TRIM');
  });

  it('returns no rate rather than dividing by zero on an empty side', async () => {
    const conn = fakeConnector({
      counts: { a_total: 0, b_total: 10, a_matched: 0, b_matched: 0 },
    });
    const m = await measureMatch(conn, 'vat_number', 'vat');
    expect(m.matchRate).toBeNull();
  });

  it('degrades instead of throwing when a query fails', async () => {
    const conn = fakeConnector({ throwOn: 'counts' });
    const m = await measureMatch(conn, 'vat_number', 'vat');
    expect(m.ok).toBe(false);
    expect(m.reason).toBe('query-failed');
  });

  it('refuses an unsafe identifier without issuing any query', async () => {
    const conn = fakeConnector({ counts: COUNTS });
    const m = await measureMatch(conn, 'vat"number', 'vat');
    expect(m.ok).toBe(false);
    expect(conn.queries).toHaveLength(0);
  });

  it('gives up on the clock rather than holding the panel open', async () => {
    vi.stubEnv('RELATIONSHIP_MATCH_TIMEOUT_MS', '10');
    vi.resetModules();
    const { measureMatch: fresh } = await import('../services/matchMeasure');

    const conn = fakeConnector({ counts: COUNTS, delayMs: 200 });
    const m = await fresh(conn, 'vat_number', 'vat');

    expect(m.ok).toBe(false);
    expect(m.reason).toBe('timeout');
    vi.unstubAllEnvs();
  });
});
