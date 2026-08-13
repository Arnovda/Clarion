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
  it('carries the matched flag through, because it is the only honest count', () => {
    // The flag is measured against the WHOLE parent column. Deriving "found"
    // from whether a value has a neighbour in the fetched window is what
    // reported 458 mismatches on a relationship measuring a true 100%.
    const out = shapeSides(
      [
        { side: 'l', v: 'ff6', matched: true },
        { side: 'l', v: 'e8a', matched: false },
      ],
      { l: 2, r: 2589 },
      SIDES.left, SIDES.right,
    );
    expect(out.left.values).toEqual([
      { v: 'e8a', matched: false },
      { v: 'ff6', matched: true },
    ]);
  });

  it('marks the parent side as range-limited when it could not be shown whole', () => {
    // The right list is the stretch that lines up with the left window, not
    // the first N of the column — and calling it "first 300" would be both
    // wrong and misleading.
    const out = shapeSides(
      [{ side: 'r', v: 'e8a', matched: true }],
      { l: 218, r: 2589 },
      SIDES.left, SIDES.right,
    );
    expect(out.right.rangeLimited).toBe(true);
    expect(out.right.distinct).toBe(2589);
    expect(out.right.shown).toBe(1);
  });

  it('does not claim truncation when the whole column fits', () => {
    const out = shapeSides(
      [{ side: 'l', v: 'a', matched: true }, { side: 'r', v: 'a', matched: true }],
      { l: 1, r: 1 },
      SIDES.left, SIDES.right,
    );
    expect(out.left.truncated).toBe(false);
    expect(out.right.truncated).toBe(false);
    expect(out.right.rangeLimited).toBe(false);
  });

  it('splits the two sides and keeps each one sorted', () => {
    // Re-sorted in JS on purpose: the UI merges the two lists against each
    // other, and a merge is only correct when both sides use the SAME
    // comparison. The database's collation is not guaranteed to be JS's.
    const out = shapeSides(
      [
        { side: 'l', v: 'B', matched: true }, { side: 'r', v: 'b' },
        { side: 'l', v: 'A', matched: true }, { side: 'r', v: 'a' },
      ],
      { l: 2, r: 2 },
      SIDES.left, SIDES.right,
    );
    expect(out.left.values.map((x) => x.v)).toEqual(['A', 'B']);
    expect(out.right.values).toEqual(['a', 'b']);
    expect(out.left.column).toBe('JournalCode');
  });

  it('reports the REAL distinct count, not the number returned', () => {
    // The cap has to be honest or "showing first 300" becomes a claim that the
    // column only has 300 values.
    const out = shapeSides(
      [{ side: 'l', v: 'x', matched: true }],
      { l: 9_000, r: 12 },
      SIDES.left, SIDES.right,
    );
    expect(out.left.values).toHaveLength(1);
    expect(out.left.distinct).toBe(9_000);
    expect(out.left.truncated).toBe(true);
  });

  it('renders a numeric key as the string it was compared as', () => {
    const out = shapeSides(
      [{ side: 'l', v: 42, matched: false }], { l: 1, r: 0 }, SIDES.left, SIDES.right,
    );
    expect(out.left.values).toEqual([{ v: '42', matched: false }]);
  });
});

describe('compareColumnValues', () => {
  it('caps each side and says so', async () => {
    const c = fakeConnector({ counts: { l: 5000, r: 5000 } });
    const res = await compareColumnValues(c, 'a', 'x', 'b', 'y');
    expect(res.ok).toBe(true);
    expect(res.limit).toBe(VALUE_LIMIT);
    expect(c.queries[0]).toContain(`LIMIT ${VALUE_LIMIT}`);
    // The parent side is bounded by the child window's range, not fetched
    // independently — otherwise the two columns describe different stretches
    // of the value space and the gaps between them mean nothing.
    expect(c.queries[0]).toContain('bounds.lo');
    expect(c.queries[0]).toContain('bounds.hi');
    // Paired values survive the cap first. Without this the cap eats the tail
    // of the range, and a value ticked as found sits opposite an empty cell —
    // which reads as a contradiction of its own tick.
    expect(c.queries[0]).toContain('ORDER BY (v IN (SELECT v FROM l)) DESC');
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
