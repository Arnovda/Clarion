import { describe, it, expect } from 'vitest';
import {
  compareColumnValues, shapeSides, VALUE_LIMIT, type QueryableConnector,
} from '../services/columnValues';

const SIDES = {
  left: { table: 'TransactionLines', column: 'JournalCode' },
  right: { table: 'Journals', column: 'ID' },
};

function fakeConnector(opts: {
  values?: { side: string; v: unknown }[];
  counts?: { l: number; r: number };
  throws?: boolean;
  delayMs?: number;
}): QueryableConnector & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async executeQuery(sql: string) {
      queries.push(sql);
      if (opts.throws) throw new Error('no such table');
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (sql.includes('COUNT(DISTINCT')) return { rows: [opts.counts ?? { l: 0, r: 0 }] };
      return { rows: opts.values ?? [] };
    },
  };
}

describe('shapeSides', () => {
  it('splits the two sides and keeps each one sorted', () => {
    // Re-sorted in JS on purpose: the UI merges the two lists against each
    // other, and a merge is only correct when both sides use the SAME
    // comparison. The database's collation is not guaranteed to be JS's.
    const out = shapeSides(
      [
        { side: 'l', v: 'B' }, { side: 'r', v: 'b' },
        { side: 'l', v: 'A' }, { side: 'r', v: 'a' },
      ],
      { l: 2, r: 2 },
      SIDES.left, SIDES.right,
    );
    expect(out.left.values).toEqual(['A', 'B']);
    expect(out.right.values).toEqual(['a', 'b']);
    expect(out.left.column).toBe('JournalCode');
  });

  it('reports the REAL distinct count, not the number returned', () => {
    // The cap has to be honest or "showing first 300" becomes a claim that the
    // column only has 300 values.
    const out = shapeSides(
      [{ side: 'l', v: 'x' }],
      { l: 9_000, r: 12 },
      SIDES.left, SIDES.right,
    );
    expect(out.left.values).toHaveLength(1);
    expect(out.left.distinct).toBe(9_000);
  });

  it('renders a numeric key as the string it was compared as', () => {
    const out = shapeSides([{ side: 'l', v: 42 }], { l: 1, r: 0 }, SIDES.left, SIDES.right);
    expect(out.left.values).toEqual(['42']);
  });
});

describe('compareColumnValues', () => {
  it('caps each side and says so', async () => {
    const c = fakeConnector({ counts: { l: 5000, r: 5000 } });
    const res = await compareColumnValues(c, 'a', 'x', 'b', 'y');
    expect(res.ok).toBe(true);
    expect(res.limit).toBe(VALUE_LIMIT);
    expect(c.queries[0]).toContain(`LIMIT ${VALUE_LIMIT}`);
  });

  it('refuses an unsafe identifier rather than composing it into SQL', async () => {
    const c = fakeConnector({});
    const res = await compareColumnValues(c, 'ok', 'bad"name', 'b', 'y');
    expect(res).toMatchObject({ ok: false, reason: 'query-failed' });
    expect(c.queries).toHaveLength(0);
  });

  it('never throws at the caller when the query fails', async () => {
    // Same contract as the measurement: a dialog needs a sentence, not a 500.
    const res = await compareColumnValues(fakeConnector({ throws: true }), 'a', 'x', 'b', 'y');
    expect(res).toMatchObject({ ok: false, reason: 'query-failed', left: null });
  });
});
