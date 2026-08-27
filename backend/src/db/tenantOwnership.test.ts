/**
 * The ownership gate is an AUTHORISATION check, so these tests assert the two
 * properties that make it one:
 *
 *  1. it refuses by default — a missing tenant or a malformed id is never
 *     "allowed", because Neo4j has no tenant predicate to fall back on;
 *  2. it puts `tenant_id` in the WHERE clause instead of relying on RLS, so it
 *     cannot be defeated by the documented connection-pool race on the
 *     session-level `SET app.current_tenant`.
 *
 * Property 2 is checked by inspecting the query the helper builds — a test that
 * only mocked "row found / not found" would still pass if the tenant filter were
 * dropped, which is exactly the regression worth catching.
 */
import { describe, it, expect } from 'vitest';
import { owns, ownedIds } from './tenantOwnership';

/** Minimal Knex stand-in that records how it was queried. */
type Nested = { op: 'where' | 'orWhere'; col: string; val: unknown } | { op: 'whereIn' | 'orWhereIn'; col: string; ids: unknown[] };
type CallRecord = {
  table: string;
  where?: Record<string, unknown>;
  whereIn?: unknown[];
  andWhere?: Record<string, unknown>;
  /** Clauses recorded inside a grouped where/andWhere callback. */
  nested?: Nested[];
};
function fakeDb(rows: Array<Record<string, unknown>> = []) {
  const calls: CallRecord[] = [];
  const db = ((table: string) => {
    const record: CallRecord = { table };
    calls.push(record);
    const groupRecorder = () => {
      const qb = {
        where(col: string, val: unknown) { (record.nested ??= []).push({ op: 'where', col, val }); return qb; },
        orWhere(col: string, val: unknown) { (record.nested ??= []).push({ op: 'orWhere', col, val }); return qb; },
        whereIn(col: string, ids: unknown[]) { (record.nested ??= []).push({ op: 'whereIn', col, ids }); return qb; },
        orWhereIn(col: string, ids: unknown[]) { (record.nested ??= []).push({ op: 'orWhereIn', col, ids }); return qb; },
      };
      return qb;
    };
    const builder = {
      where(criteria: Record<string, unknown>) { record.where = criteria; return builder; },
      whereIn(_col: string, ids: unknown[]) { record.whereIn = ids; return builder; },
      andWhere(criteria: Record<string, unknown> | ((qb: unknown) => void)) {
        if (typeof criteria === 'function') { criteria(groupRecorder()); return builder; }
        record.andWhere = criteria;
        return builder;
      },
      first() { return Promise.resolve(rows[0]); },
      select() { return Promise.resolve(rows); },
    };
    return builder;
  }) as never;
  return { db, calls };
}

describe('owns', () => {
  it('scopes the query by tenant_id, not just id', async () => {
    const { db, calls } = fakeDb([{ id: 7 }]);
    await owns(db, 'source_tables', 7, 42);
    expect(calls[0].table).toBe('source_tables');
    // The whole point: tenant is part of the predicate.
    expect(calls[0].where).toEqual({ id: 7, tenant_id: 42 });
  });

  it('returns true only when a row comes back', async () => {
    const { db: found } = fakeDb([{ id: 7 }]);
    expect(await owns(found, 'source_tables', 7, 42)).toBe(true);

    const { db: missing } = fakeDb([]);
    expect(await owns(missing, 'source_tables', 7, 42)).toBe(false);
  });

  it('refuses without a tenant, and does not query at all', async () => {
    const { db, calls } = fakeDb([{ id: 7 }]);
    expect(await owns(db, 'source_tables', 7, undefined)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses ids that are not positive integers', async () => {
    const { db, calls } = fakeDb([{ id: 1 }]);
    for (const bad of [0, -1, 1.5, NaN, 'abc', null, undefined, {}]) {
      expect(await owns(db, 'source_tables', bad, 42)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('accepts a numeric string id, since ids arrive from URL params', async () => {
    const { db, calls } = fakeDb([{ id: 7 }]);
    expect(await owns(db, 'source_tables', '7', 42)).toBe(true);
    expect(calls[0].where).toEqual({ id: 7, tenant_id: 42 });
  });
});

describe('owns — graph-id-aliased tables (product_tables / product_columns)', () => {
  // The graph mirror mints a separate id (`neo4j_pg_id`) for product entities,
  // and every catalog/product-tree payload surfaces THAT id. The gate must
  // accept both id spaces — checking only `id` made every product-table click
  // 404 as "Table not found" (the 2026-08-27 catalog regression, latent since
  // the gate shipped) — while keeping tenant_id in the predicate.
  it('matches id OR neo4j_pg_id, still scoped by tenant_id', async () => {
    const { db, calls } = fakeDb([{ id: 10 }]);
    expect(await owns(db, 'product_tables', 900, 42)).toBe(true);
    expect(calls[0].table).toBe('product_tables');
    // Tenant is a top-level predicate — it applies whichever column matches.
    expect(calls[0].where).toEqual({ tenant_id: 42 });
    expect(calls[0].nested).toEqual([
      { op: 'where', col: 'id', val: 900 },
      { op: 'orWhere', col: 'neo4j_pg_id', val: 900 },
    ]);
  });

  it('still refuses when no row matches either column for this tenant', async () => {
    const { db } = fakeDb([]);
    expect(await owns(db, 'product_columns', 900, 42)).toBe(false);
  });

  it('non-aliased tables keep the exact single-column predicate', async () => {
    const { db, calls } = fakeDb([{ id: 7 }]);
    await owns(db, 'source_tables', 7, 42);
    expect(calls[0].where).toEqual({ id: 7, tenant_id: 42 });
    expect(calls[0].nested).toBeUndefined();
  });
});

describe('ownedIds', () => {
  it('returns only the ids the tenant owns', async () => {
    // The DB is the authority: it returns 1 and 3, so 2 was someone else's.
    const { db, calls } = fakeDb([{ id: 1 }, { id: 3 }]);
    const result = await ownedIds(db, 'data_products', [1, 2, 3], 42);
    expect([...result].sort()).toEqual([1, 3]);
    expect(calls[0].whereIn).toEqual([1, 2, 3]);
    expect(calls[0].andWhere).toEqual({ tenant_id: 42 });
  });

  it('deduplicates and drops malformed ids before querying', async () => {
    const { db, calls } = fakeDb([{ id: 1 }]);
    await ownedIds(db, 'data_products', [1, 1, 'x', 0, -2, null], 42);
    expect(calls[0].whereIn).toEqual([1]);
  });

  it('returns an empty set without querying when there is nothing to check', async () => {
    const { db, calls } = fakeDb([{ id: 1 }]);
    expect((await ownedIds(db, 'data_products', [], 42)).size).toBe(0);
    expect((await ownedIds(db, 'data_products', [1], undefined)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('aliased tables: returns the INPUT ids that matched, whichever column matched', async () => {
    // Row 10's graph id is 900. A caller holding the graph id must get 900
    // back (that's the id it will test with), not the row's Postgres id.
    const { db, calls } = fakeDb([{ id: 10, neo4j_pg_id: 900 }]);
    const result = await ownedIds(db, 'product_tables', [900, 555], 42);
    expect([...result]).toEqual([900]);
    expect(calls[0].where).toEqual({ tenant_id: 42 });
    expect(calls[0].nested).toEqual([
      { op: 'whereIn', col: 'id', ids: [900, 555] },
      { op: 'orWhereIn', col: 'neo4j_pg_id', ids: [900, 555] },
    ]);
  });

  it('aliased tables: a caller holding the Postgres id also gets it back', async () => {
    const { db } = fakeDb([{ id: 10, neo4j_pg_id: 900 }]);
    const result = await ownedIds(db, 'product_tables', [10], 42);
    expect([...result]).toEqual([10]);
  });
});
