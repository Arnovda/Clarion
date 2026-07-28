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
function fakeDb(rows: Array<{ id: number }> = []) {
  const calls: Array<{ table: string; where?: Record<string, unknown>; whereIn?: unknown[]; andWhere?: Record<string, unknown> }> = [];
  const db = ((table: string) => {
    const record: { table: string; where?: Record<string, unknown>; whereIn?: unknown[]; andWhere?: Record<string, unknown> } = { table };
    calls.push(record);
    const builder = {
      where(criteria: Record<string, unknown>) { record.where = criteria; return builder; },
      whereIn(_col: string, ids: unknown[]) { record.whereIn = ids; return builder; },
      andWhere(criteria: Record<string, unknown>) { record.andWhere = criteria; return builder; },
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
});
