/**
 * Tests the structural reliability guarantee that protects the
 * three "Ask" surfaces from the May 23 2026 trx-poison cascade.
 *
 * If these tests pass, the failure pattern that ate /query that day
 * (one bad query → all subsequent queries fail with 25P02) can't
 * happen again at this layer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { safeQuery } from '../db/safeQuery';
import { getTestDb, migrateTestDb, cleanTestDb, closeTestDb } from './db-helpers';

beforeAll(async () => {
  await migrateTestDb();
  await cleanTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('safeQuery — SAVEPOINT isolation', () => {
  it('returns the query result on success', async () => {
    const db = getTestDb();
    await db.transaction(async (trx) => {
      const result = await safeQuery(
        trx,
        (t) => t.raw<{ rows: { ok: number }[] }>('SELECT 1 as ok'),
        { rows: [] as { ok: number }[] },
      );
      expect(result.rows[0].ok).toBe(1);
    });
  });

  it('returns the fallback on query failure WITHOUT poisoning the outer trx', async () => {
    const db = getTestDb();
    await db.transaction(async (trx) => {
      // Run a deliberately-broken query — Postgres will raise an error.
      const result = await safeQuery(
        trx,
        (t) => t.raw('SELECT * FROM nonexistent_table_zzzzzz'),
        { rows: [] as unknown[] },
      );
      expect(result).toEqual({ rows: [] });

      // CRITICAL: the outer trx must still be usable. Without
      // safeQuery's SAVEPOINT, this next query would fail with
      // Postgres 25P02 ("current transaction is aborted").
      const after = await trx.raw<{ rows: { ok: number }[] }>('SELECT 1 as ok');
      expect(after.rows[0].ok).toBe(1);
    });
  });

  it('handles a real Knex query builder (not just raw SQL)', async () => {
    const db = getTestDb();
    await db.transaction(async (trx) => {
      // Reference a real table — knex_migrations always exists after migrateTestDb.
      const rows = await safeQuery(
        trx,
        (t) => t('knex_migrations').limit(1),
        [],
      );
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  it('supports multiple safeQuery calls in the same transaction (unique savepoint names)', async () => {
    const db = getTestDb();
    await db.transaction(async (trx) => {
      // Three safeQuery calls in a row, all failing. Each should
      // roll back to its own savepoint without affecting the others.
      const r1 = await safeQuery(trx, (t) => t.raw('SELECT * FROM nope_1'), 'fallback1');
      const r2 = await safeQuery(trx, (t) => t.raw('SELECT * FROM nope_2'), 'fallback2');
      const r3 = await safeQuery(trx, (t) => t.raw('SELECT * FROM nope_3'), 'fallback3');
      expect(r1).toBe('fallback1');
      expect(r2).toBe('fallback2');
      expect(r3).toBe('fallback3');

      // Outer trx still usable after three failed defensive queries.
      const after = await trx.raw<{ rows: { ok: number }[] }>('SELECT 1 as ok');
      expect(after.rows[0].ok).toBe(1);
    });
  });

  it('handles nested-style success-after-failure correctly', async () => {
    const db = getTestDb();
    await db.transaction(async (trx) => {
      // First safeQuery fails → savepoint rolled back, fallback returned.
      const failed = await safeQuery(trx, (t) => t.raw('SELECT * FROM nope_4'), null);
      expect(failed).toBeNull();

      // Second safeQuery succeeds → savepoint released, real result returned.
      const succeeded = await safeQuery(
        trx,
        (t) => t.raw<{ rows: { ok: number }[] }>('SELECT 2 as ok'),
        { rows: [] as { ok: number }[] },
      );
      expect(succeeded.rows[0].ok).toBe(2);

      // Direct query on the outer trx still works.
      const after = await trx.raw<{ rows: { ok: number }[] }>('SELECT 3 as ok');
      expect(after.rows[0].ok).toBe(3);
    });
  });

  it('regression: WITHOUT safeQuery, the trx-poison cascade still exists', async () => {
    // This test documents the bug class we're protecting against —
    // by demonstrating it's a real Postgres behaviour, not a Knex
    // quirk. If this ever stops failing-then-throwing, Postgres has
    // changed its semantics and the whole safeQuery argument may
    // need re-evaluation.
    const db = getTestDb();
    await expect(
      db.transaction(async (trx) => {
        // Failing query, JS catch swallows it (the dangerous pattern).
        await trx.raw('SELECT * FROM nope_5').catch(() => null);

        // Next query on the same trx — without safeQuery, this MUST
        // throw 25P02 because Postgres considers the transaction
        // failed and rejects all further statements until ROLLBACK.
        await trx.raw('SELECT 1 as ok');
      }),
    ).rejects.toThrow(/current transaction is aborted|25P02/i);
  });
});
