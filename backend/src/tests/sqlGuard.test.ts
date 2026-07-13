import { describe, it, expect } from 'vitest';
import { assertSelectOnly, isSelectOnly, UnsafeSqlError } from '../utils/sqlGuard';

describe('assertSelectOnly', () => {
  it('accepts a plain SELECT', () => {
    expect(isSelectOnly('SELECT * FROM orders')).toBe(true);
  });

  it('accepts a WITH ... SELECT', () => {
    expect(isSelectOnly('WITH t AS (SELECT 1 AS n) SELECT n FROM t')).toBe(true);
  });

  it('accepts a lowercase / whitespace-led query and strips a trailing semicolon', () => {
    expect(assertSelectOnly('  \n select 1 ; ')).toBe('select 1');
  });

  it('accepts forbidden words INSIDE string literals and identifiers', () => {
    expect(isSelectOnly(`SELECT 'delete this row' AS note FROM t`)).toBe(true);
    expect(isSelectOnly('SELECT "update" FROM t')).toBe(true);
    expect(isSelectOnly(`SELECT * FROM t WHERE label = 'a;b'`)).toBe(true);
  });

  it('rejects INSERT/UPDATE/DELETE/DROP/etc.', () => {
    for (const q of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'DELETE FROM t',
      'DROP TABLE t',
      'ALTER TABLE t ADD c INT',
      'TRUNCATE t',
      'CREATE TABLE t (id INT)',
      'GRANT SELECT ON t TO x',
    ]) {
      expect(isSelectOnly(q), q).toBe(false);
    }
  });

  it('rejects DuckDB side-channels (COPY/ATTACH/INSTALL/LOAD/PRAGMA/SET)', () => {
    for (const q of [
      "COPY (SELECT 1) TO '/tmp/x.parquet'",
      "ATTACH 'other.db' AS o",
      'INSTALL azure',
      'LOAD azure',
      'PRAGMA database_list',
      "SET memory_limit='16GB'",
    ]) {
      expect(isSelectOnly(q), q).toBe(false);
    }
  });

  it('rejects a data-modifying CTE hidden in a WITH', () => {
    expect(isSelectOnly(
      'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
    )).toBe(false);
  });

  it('rejects stacked statements', () => {
    expect(isSelectOnly('SELECT 1; DROP TABLE t')).toBe(false);
    expect(isSelectOnly('SELECT 1; SELECT 2')).toBe(false);
  });

  it('rejects a statement smuggled after a comment', () => {
    expect(isSelectOnly('SELECT 1 -- ok\n; DELETE FROM t')).toBe(false);
  });

  it('rejects empty / non-string input', () => {
    expect(isSelectOnly('')).toBe(false);
    expect(isSelectOnly('   ')).toBe(false);
    // @ts-expect-error runtime guard
    expect(isSelectOnly(null)).toBe(false);
  });

  it('throws UnsafeSqlError with a reason', () => {
    expect(() => assertSelectOnly('DROP TABLE t')).toThrow(UnsafeSqlError);
    expect(() => assertSelectOnly('DROP TABLE t')).toThrow(/not a SELECT\/WITH query/);
    // A denylist keyword reachable past the start-check (data-modifying CTE).
    expect(() => assertSelectOnly('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'))
      .toThrow(/forbidden keyword "DELETE"/);
  });
});
