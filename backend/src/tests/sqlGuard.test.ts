import { describe, it, expect } from 'vitest';
import {
  assertSelectOnly,
  isSelectOnly,
  assertNoExternalAccess,
  assertSafeReadQuery,
  isSafeReadQuery,
  UnsafeSqlError,
} from '../utils/sqlGuard';

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

describe('assertNoExternalAccess', () => {
  it('accepts plain queries over registered views', () => {
    expect(() => assertNoExternalAccess('SELECT * FROM orders')).not.toThrow();
    expect(() => assertNoExternalAccess('WITH t AS (SELECT 1 AS n) SELECT n FROM t')).not.toThrow();
    // A column/alias merely containing "read" or "glob" is fine.
    expect(() => assertNoExternalAccess('SELECT read_count, global_id FROM t')).not.toThrow();
  });

  it('rejects path/URI-reading table functions', () => {
    for (const q of [
      "SELECT * FROM read_parquet('az://warehouse/tenant_99/conn_1/orders/data.parquet')",
      "SELECT * FROM read_csv('/etc/passwd')",
      "SELECT read_text('/proc/self/environ')",
      "SELECT * FROM delta_scan('az://warehouse/tenant_99/x')",
      "SELECT * FROM glob('/app/**')",
      "SELECT * FROM parquet_scan('x.parquet')",
      "SELECT * FROM read_json('s3://bucket/x.json')",
      "SELECT * FROM postgres_scan('host=x', 'public', 't')",
    ]) {
      expect(() => assertNoExternalAccess(q), q).toThrow(UnsafeSqlError);
    }
  });

  it('rejects object-storage URI literals even without a known function', () => {
    for (const q of [
      "SELECT * FROM foo WHERE path = 'az://warehouse/tenant_2/secret'",
      "SELECT * FROM t WHERE u = 'abfss://c@acct.dfs.core.windows.net/x'",
      "SELECT * FROM t WHERE u = 's3://bucket/key'",
    ]) {
      expect(() => assertNoExternalAccess(q), q).toThrow(/external path\/URI literal/);
    }
  });

  it('rejects bare-path replacement scans in FROM/JOIN position', () => {
    for (const q of [
      "SELECT * FROM '/warehouse/tenant_9/conn_1/orders/part-0.parquet'",
      "SELECT * FROM 'data.parquet'",
      "SELECT * FROM 'az://warehouse/tenant_9/x.parquet'",
      "SELECT a.* FROM orders a JOIN '/etc/other.csv' b ON a.id = b.id",
      "select * from '/proc/self/environ'",
    ]) {
      expect(() => assertNoExternalAccess(q), q).toThrow(/replacement scan|external path/);
    }
  });

  it('does NOT false-positive on legitimate URL/file data literals (M2)', () => {
    // http(s)/file are ordinary data — must not be refused when used as values.
    for (const q of [
      "SELECT * FROM events WHERE referrer = 'https://example.com'",
      "SELECT COUNT(*) FROM docs WHERE path LIKE 'file://%'",
      'SELECT * FROM "my table" WHERE x = 1', // double-quoted identifier, not a path
    ]) {
      expect(() => assertNoExternalAccess(q), q).not.toThrow();
    }
  });
});

describe('assertSafeReadQuery / isSafeReadQuery', () => {
  it('accepts a safe read-only query over views', () => {
    expect(isSafeReadQuery('SELECT a, SUM(b) FROM fact_sales GROUP BY a')).toBe(true);
    expect(assertSafeReadQuery('SELECT 1 ;')).toBe('SELECT 1');
  });

  it('rejects the cross-tenant read vector that SELECT-only alone misses', () => {
    // This IS a single SELECT — the old guard passed it; the new one must not.
    const attack = "SELECT * FROM read_parquet('az://warehouse/tenant_OTHER/conn_1/orders/data.parquet')";
    expect(isSelectOnly(attack)).toBe(true);
    expect(isSafeReadQuery(attack)).toBe(false);
  });

  it('rejects the local-file exfiltration vector', () => {
    expect(isSafeReadQuery("SELECT read_text('/proc/self/environ') AS env")).toBe(false);
  });

  it('still rejects writes / DDL / side-channels', () => {
    expect(isSafeReadQuery("COPY (SELECT 1) TO 'az://warehouse/tenant_x/leak.parquet'")).toBe(false);
    expect(isSafeReadQuery('DROP TABLE t')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P0-1 of the 2026-09-05 market-readiness assessment: the external-function
// scan ran on literal-stripped SQL, and stripLiterals() also erases
// double-quoted IDENTIFIERS — so `"read_text"(...)`, which DuckDB resolves to
// the same function, walked straight past it. Reproduced against this module
// before the fix: the unquoted form was refused, the quoted form was ALLOWED.
// ---------------------------------------------------------------------------
describe('assertNoExternalAccess — quoted function names (P0-1)', () => {
  it('refuses a double-quoted external function exactly like the bare one', () => {
    for (const q of [
      `SELECT * FROM "read_text"('/proc/self/environ')`,
      `SELECT * FROM "READ_TEXT"('/proc/self/environ')`,
      `SELECT * FROM "read_parquet"('https://evil.example/x.parquet')`,
      `SELECT * FROM main."read_csv"('/etc/passwd')`,
      `SELECT * FROM "read_blob" ('/etc/shadow')`,
      `SELECT * FROM "glob"('/**')`,
      `SELECT * FROM "delta_scan"('/warehouse/tenant_9/x')`,
    ]) {
      expect(() => assertNoExternalAccess(q)).toThrow(UnsafeSqlError);
      expect(isSafeReadQuery(q)).toBe(false);
    }
  });

  it('refuses the indirection functions that execute a string as SQL', () => {
    // A denylisted call hidden INSIDE the string literal is invisible to every
    // literal-stripping scan, so the indirection itself is refused.
    for (const q of [
      `SELECT * FROM query('SELECT * FROM read_text(''/proc/self/environ'')')`,
      `SELECT * FROM "query"('SELECT 1')`,
      `SELECT * FROM query_table('orders')`,
    ]) {
      expect(isSafeReadQuery(q)).toBe(false);
    }
  });

  it('refuses secret introspection', () => {
    expect(isSafeReadQuery(`SELECT * FROM duckdb_secrets(redact := false)`)).toBe(false);
    expect(isSafeReadQuery(`SELECT * FROM "duckdb_secrets"()`)).toBe(false);
  });

  it('still allows a column or table whose name merely CONTAINS a denylisted word', () => {
    for (const q of [
      `SELECT "my_read_text" FROM t`,
      `SELECT * FROM "read_text_log"`,
      `SELECT count(*) AS query_count FROM t`,
      `SELECT * FROM t WHERE note = 'read_text(x)'`,
      `SELECT "query" FROM t`,
      `SELECT glob_pattern FROM t`,
    ]) {
      expect(isSafeReadQuery(q)).toBe(true);
    }
  });

  it('refuses a comment-split or whitespace-split quoted call', () => {
    expect(isSafeReadQuery(`SELECT * FROM "read_text"/* x */('/proc/self/environ')`)).toBe(false);
    expect(isSafeReadQuery(`SELECT * FROM "read_text"\n\t('/proc/self/environ')`)).toBe(false);
  });
});
