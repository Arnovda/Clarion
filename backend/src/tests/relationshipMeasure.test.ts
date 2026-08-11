import { describe, it, expect, vi } from 'vitest';
import {
  measureRelationship,
  classifyCardinality,
  verdictFromFk,
  assertSafeIdentifier,
  type QueryableConnector,
} from '../services/relationshipMeasure';

/**
 * A connector that answers the two queries a measurement issues. They are told
 * apart by their leading CTE: `verifyFkCandidate` opens `WITH src AS`, the
 * cardinality query opens `WITH g AS`. Keeping the discrimination on real SQL
 * shape (rather than call order) means a future reordering does not silently
 * feed the wrong rows to the wrong reader.
 */
function fakeConnector(opts: {
  fk?: { sampled: number; matched: number; target_rows: number; target_distinct: number };
  card?: { distinct_vals: number; total_rows: number; avg_children: number; max_children: number; orphan_rows: number };
  throwOn?: 'fk' | 'card';
  delayMs?: number;
}): QueryableConnector & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async executeQuery(sql: string) {
      queries.push(sql);
      const isFk = sql.includes('WITH src AS');
      if (opts.throwOn === 'fk' && isFk) throw new Error('no such table');
      if (opts.throwOn === 'card' && !isFk) throw new Error('conversion error');
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { rows: [isFk ? opts.fk ?? {} : opts.card ?? {}] };
    },
  };
}

const HEALTHY_FK = { sampled: 100, matched: 100, target_rows: 500, target_distinct: 500 };
const HEALTHY_CARD = { distinct_vals: 100, total_rows: 320, avg_children: 3.2, max_children: 47, orphan_rows: 23 };

describe('classifyCardinality', () => {
  it('reads a foreign key as many-to-one', () => {
    // The child column repeats, the parent key does not. This is the case that
    // must come out right — it is what an FK is.
    expect(classifyCardinality(false, true)).toBe('many_to_one');
  });

  it('distinguishes the other three combinations', () => {
    expect(classifyCardinality(true, true)).toBe('one_to_one');
    expect(classifyCardinality(true, false)).toBe('one_to_many');
    expect(classifyCardinality(false, false)).toBe('many_to_many');
  });
});

describe('verdictFromFk', () => {
  const base = { sampled: 100, containment: 1, targetRows: 10, targetDistinct: 10 };

  it('calls a passing candidate strong', () => {
    expect(verdictFromFk({ ...base, ok: true, reason: 'ok' }))
      .toEqual({ verdict: 'strong', reason: 'ok' });
  });

  it('calls too-few-distinct weak, not broken', () => {
    // Not enough evidence is not the same as evidence against. A code table
    // with six values may well be a real relationship.
    expect(verdictFromFk({ ...base, ok: false, reason: 'too-few-distinct', sampled: 6 }).verdict)
      .toBe('weak');
  });

  it('calls a non-key target weak', () => {
    expect(verdictFromFk({ ...base, ok: false, reason: 'target-not-key' }).verdict).toBe('weak');
  });

  it('splits low containment at half', () => {
    // Above half: unconfirmed — a partially-synced source looks exactly like this.
    expect(verdictFromFk({ ...base, ok: false, reason: 'low-containment', containment: 0.7 }).verdict)
      .toBe('weak');
    // Below half: almost certainly not a relationship, and it should look it.
    expect(verdictFromFk({ ...base, ok: false, reason: 'low-containment', containment: 0.2 }).verdict)
      .toBe('broken');
  });

  it('reports an empty source as unmeasurable rather than broken', () => {
    // Nothing to measure is not a judgement on the relationship. Showing a red
    // "broken" for a table that simply has not synced yet would be a lie.
    expect(verdictFromFk({ ...base, ok: false, reason: 'low-containment', sampled: 0, containment: 0 }))
      .toEqual({ verdict: 'unmeasurable', reason: 'no-values' });
  });
});

describe('assertSafeIdentifier', () => {
  it('rejects anything that could break out of the quoting', () => {
    expect(() => assertSafeIdentifier('inv"oices', 'table name')).toThrow();
    expect(() => assertSafeIdentifier('a\\b', 'table name')).toThrow();
    expect(() => assertSafeIdentifier('', 'table name')).toThrow();
    expect(() => assertSafeIdentifier('x'.repeat(200), 'table name')).toThrow();
  });

  it('accepts the shapes real catalogs produce', () => {
    expect(() => assertSafeIdentifier('SalesInvoiceLines', 'table name')).not.toThrow();
    expect(() => assertSafeIdentifier('account_move_line', 'table name')).not.toThrow();
    expect(() => assertSafeIdentifier('Order Lines', 'table name')).not.toThrow();
  });
});

describe('measureRelationship', () => {
  it('returns containment, cardinality and orphans for a healthy key', async () => {
    const conn = fakeConnector({ fk: HEALTHY_FK, card: HEALTHY_CARD });
    const m = await measureRelationship(conn, 'invoices', 'customer_id', 'customers', 'id');

    expect(m.verdict).toBe('strong');
    expect(m.containment).toMatchObject({ matchedDistinct: 100, sampledDistinct: 100, ratio: 1 });
    expect(m.target).toMatchObject({ rows: 500, distinct: 500, isKey: true });
    expect(m.cardinality).toMatchObject({ type: 'many_to_one', avgChildren: 3.2, maxChildren: 47 });
    expect(m.orphans).toEqual({ rows: 23, basis: 'full' });
  });

  it('keeps containment and cardinality on separate bases', async () => {
    // The 2026-08-03 production defect was a ratio built from a sampled
    // numerator and a whole-column denominator. Containment must stay sampled,
    // cardinality must stay full-table, and the payload must say which is which
    // so the UI can never present them as one number.
    const conn = fakeConnector({ fk: HEALTHY_FK, card: HEALTHY_CARD });
    const m = await measureRelationship(conn, 'invoices', 'customer_id', 'customers', 'id');

    expect(m.containment!.sampledDistinct).toBe(100);
    expect(m.containment!.sampleSize).toBeGreaterThan(0);
    expect(m.cardinality!.basis).toBe('full');
    expect(m.orphans!.basis).toBe('full');
  });

  it('echoes the detector thresholds so the UI need not hardcode them', async () => {
    const conn = fakeConnector({ fk: HEALTHY_FK, card: HEALTHY_CARD });
    const m = await measureRelationship(conn, 'invoices', 'customer_id', 'customers', 'id');

    expect(m.thresholds.minContainment).toBeGreaterThan(0);
    expect(m.thresholds.minDistinct).toBeGreaterThan(0);
    expect(m.thresholds.targetUniqueness).toBeGreaterThan(0);
  });

  it('degrades to unmeasurable instead of throwing when a query fails', async () => {
    // The user is mid-gesture with a popover open. A 500 leaves them with
    // nothing to act on; a reason renders as a sentence.
    const conn = fakeConnector({ throwOn: 'fk' });
    const m = await measureRelationship(conn, 'invoices', 'customer_id', 'customers', 'id');

    expect(m.verdict).toBe('unmeasurable');
    expect(m.reason).toBe('query-failed');
    expect(m.containment).toBeNull();
  });

  it('survives the second query failing after the first succeeded', async () => {
    const conn = fakeConnector({ fk: HEALTHY_FK, throwOn: 'card' });
    const m = await measureRelationship(conn, 'invoices', 'customer_id', 'customers', 'id');
    expect(m.verdict).toBe('unmeasurable');
  });

  it('refuses an unsafe identifier without issuing any query', async () => {
    const conn = fakeConnector({ fk: HEALTHY_FK, card: HEALTHY_CARD });
    const m = await measureRelationship(conn, 'inv"oices', 'customer_id', 'customers', 'id');

    expect(m.verdict).toBe('unmeasurable');
    expect(conn.queries).toHaveLength(0);
  });

  it('gives up on the clock rather than leaving the popover spinning', async () => {
    vi.stubEnv('RELATIONSHIP_MEASURE_TIMEOUT_MS', '10');
    vi.resetModules();
    const { measureRelationship: fresh } = await import('../services/relationshipMeasure');

    const conn = fakeConnector({ fk: HEALTHY_FK, card: HEALTHY_CARD, delayMs: 200 });
    const m = await fresh(conn, 'invoices', 'customer_id', 'customers', 'id');

    expect(m.verdict).toBe('unmeasurable');
    expect(m.reason).toBe('timeout');
    vi.unstubAllEnvs();
  });

  it('does not report a cardinality when the source column is entirely null', async () => {
    const conn = fakeConnector({
      fk: { sampled: 0, matched: 0, target_rows: 10, target_distinct: 10 },
      card: { distinct_vals: 0, total_rows: 0, avg_children: 0, max_children: 0, orphan_rows: 0 },
    });
    const m = await measureRelationship(conn, 'invoices', 'customer_id', 'customers', 'id');

    expect(m.verdict).toBe('unmeasurable');
    expect(m.cardinality).toBeNull();
  });
});
