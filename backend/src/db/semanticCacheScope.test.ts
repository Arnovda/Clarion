/**
 * The resolver's contract has two halves, and the second one is the important
 * one: it must return null rather than a WRONG connection, because callers turn
 * null into a global cache wipe (slow but correct) and a wrong id into a scoped
 * wipe that leaves stale semantic context served for the whole TTL.
 */
import { describe, it, expect } from 'vitest';
import { connectionIdForEntity } from './semanticCacheScope';

/** Knex stand-in that records the table and join chain it was asked to build. */
function fakeDb(result?: { connection_id?: unknown }) {
  const calls: Array<{ table: string; joins: string[] }> = [];
  const db = ((table: string) => {
    const record = { table, joins: [] as string[] };
    calls.push(record);
    const builder = {
      join(t: string) { record.joins.push(t); return builder; },
      where() { return builder; },
      first() { return Promise.resolve(result); },
    };
    return builder;
  }) as never;
  return { db, calls };
}

describe('connectionIdForEntity', () => {
  it('reads connection_id directly where the row has one', async () => {
    const { db, calls } = fakeDb({ connection_id: 12 });
    expect(await connectionIdForEntity(db, 'source_tables', 5)).toBe(12);
    expect(calls[0]).toEqual({ table: 'source_tables', joins: [] });
  });

  it('joins through source_tables for a column', async () => {
    const { db, calls } = fakeDb({ connection_id: 12 });
    expect(await connectionIdForEntity(db, 'source_columns', 5)).toBe(12);
    expect(calls[0].joins).toEqual(['source_tables']);
  });

  it('joins through the FROM table for a relationship, which has no connection_id', async () => {
    const { db, calls } = fakeDb({ connection_id: 12 });
    expect(await connectionIdForEntity(db, 'table_relationships', 5)).toBe(12);
    expect(calls[0].joins).toEqual(['source_tables']);
  });

  it('walks the full product chain to reach a connection', async () => {
    const { db, calls } = fakeDb({ connection_id: 12 });
    expect(await connectionIdForEntity(db, 'product_columns', 5)).toBe(12);
    expect(calls[0].joins).toEqual(['product_tables', 'star_schemas', 'data_products']);
  });

  it('echoes a connection id back so callers can treat every type uniformly', async () => {
    const { db } = fakeDb({ connection_id: 7 });
    expect(await connectionIdForEntity(db, 'connections', 7)).toBe(7);
  });

  it('returns null when the row is gone, so the caller wipes globally', async () => {
    const { db } = fakeDb(undefined);
    expect(await connectionIdForEntity(db, 'source_tables', 5)).toBeNull();
  });

  it('returns null for a null FK rather than coercing it to a connection', async () => {
    // Number(null) is 0 and Number(undefined) is NaN — neither may pass as an id.
    for (const bad of [null, undefined, 0, -1, 'abc']) {
      const { db } = fakeDb({ connection_id: bad });
      expect(await connectionIdForEntity(db, 'source_tables', 5)).toBeNull();
    }
  });

  it('rejects a malformed entity id without querying', async () => {
    const { db, calls } = fakeDb({ connection_id: 12 });
    for (const bad of [0, -3, 1.5, NaN, 'x', null, undefined]) {
      expect(await connectionIdForEntity(db, 'source_tables', bad)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });
});
