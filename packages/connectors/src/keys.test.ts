import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database } from 'duckdb-async';
import {
  CLARION_KEY_MACRO_SQL,
  keyFormOf,
  keyFormOfExpression,
  keyRuleViolations,
  registerClarionKey,
  selectItemFor,
  changedKeys,
  hashedKeyColumns,
  replaceSelectItem,
  type KeyRuleTable,
} from './keys';

describe('clarion_key (the macro, in real DuckDB)', () => {
  let db: Database;
  beforeAll(async () => { db = await Database.create(':memory:'); await registerClarionKey(db); });
  afterAll(async () => { await db.close(); });
  const one = async (sql: string) => ((await db.all(`SELECT ${sql} AS v`)) as Array<{ v: unknown }>)[0].v;

  it('is a non-negative BIGINT, the same for the same entity and id on every call', async () => {
    const a = await one(`clarion_key('Accounts', '3f2a-guid')`);
    expect(typeof a).toBe('bigint');
    expect((a as bigint) >= 0n).toBe(true);
    expect(await one(`clarion_key('Accounts', '3f2a-guid')`)).toBe(a);
    expect(await one(`typeof(clarion_key('Accounts', 1))`)).toBe('BIGINT');
  });

  it('normalises the sloppiness sources have: case, padding, whole-number doubles', async () => {
    const k = await one(`clarion_key('Accounts', '3f2a-guid')`);
    expect(await one(`clarion_key(' accounts ', '3F2A-GUID  ')`)).toBe(k);
    const five = await one(`clarion_key('res_partner', 5)`);
    expect(await one(`clarion_key('res_partner', 5.0::DOUBLE)`)).toBe(five);
    expect(await one(`clarion_key('res_partner', 5::DECIMAL(18,2))`)).toBe(five);
    expect(await one(`clarion_key('res_partner', '5')`)).toBe(five);
    expect(await one(`clarion_key('res_partner', 5.5)`)).not.toBe(five);
  });

  it('keeps entities apart, and a missing reference is NULL, not a key', async () => {
    expect(await one(`clarion_key('Items', '5')`)).not.toBe(await one(`clarion_key('Accounts', '5')`));
    expect(await one(`clarion_key('Accounts', NULL)`)).toBeNull();
    expect(await one(`clarion_key('Accounts', '  ')`)).toBeNull();
  });

  it('is PINNED: changing the body changes every key in every tenant', async () => {
    // If this fails, someone edited CLARION_KEY_MACRO_SQL. That re-keys every
    // stored dimension and fact at once — ship it as a versioned function and
    // a migration, never as an edit.
    expect(String(await one(`clarion_key('Accounts', '3f2a-guid')`))).toBe('3715884944455664578');
    expect(String(await one(`clarion_key('res_partner', 5)`))).toBe('2506222123867146389');
    expect(CLARION_KEY_MACRO_SQL).toContain('md5_number');
  });

  it('gives a million distinct ids a million distinct keys', async () => {
    const r = await db.all(`SELECT count(DISTINCT clarion_key('x', i)) AS n FROM range(1000000) t(i)`) as Array<{ n: bigint }>;
    expect(Number(r[0].n)).toBe(1000000);
  });
});

describe('reading a key back out of SQL', () => {
  it('finds the select item behind an alias, through CAST and nested calls', () => {
    const sql = `SELECT clarion_key('Accounts', a.ID) AS account_key, a.ID AS account_id, CAST(a.Code AS VARCHAR) AS code FROM Accounts a`;
    expect(selectItemFor(sql, 'account_key')).toBe(`clarion_key('Accounts', a.ID)`);
    expect(selectItemFor(sql, 'code')).toBe('CAST(a.Code AS VARCHAR)');
    expect(selectItemFor(sql, 'nope')).toBeNull();
  });

  it('reads the CTE that made a key when the final SELECT only passes it through', () => {
    const sql = `WITH l AS (SELECT clarion_key('Accounts', TRY_CAST(s.Account AS VARCHAR)) AS account_key, s.Amount FROM SalesInvoiceLines s)
      SELECT l.account_key, SUM(l.Amount) AS amount FROM l GROUP BY 1`;
    expect(keyFormOf(sql, 'account_key')).toEqual({ kind: 'hashed', entity: 'accounts' });
  });

  it('classifies every form a key can take', () => {
    expect(keyFormOfExpression(`clarion_key('Accounts', a.ID)`)).toEqual({ kind: 'hashed', entity: 'accounts' });
    expect(keyFormOfExpression(`COALESCE(clarion_key( 'Items' , l.Item), -1)`)).toEqual({ kind: 'hashed', entity: 'items' });
    expect(keyFormOfExpression(`clarion_key(src, a.ID)`)).toEqual({ kind: 'hashed-dynamic' });
    expect(keyFormOfExpression(`ROW_NUMBER() OVER (ORDER BY a.ID)`)).toEqual({ kind: 'unstable', fn: 'ROW_NUMBER' });
    expect(keyFormOfExpression(`a.ID`)).toEqual({ kind: 'other' });
    expect(keyFormOfExpression(`'clarion_key(''x'', 1)'`)).toEqual({ kind: 'other' }); // inside a string: not a call
    expect(keyFormOfExpression(`-- clarion_key('x', 1)\n a.ID`)).toEqual({ kind: 'other' }); // inside a comment: not a call
    expect(keyFormOfExpression(null)).toEqual({ kind: 'unknown' });
  });

  it('never mistakes an alias inside a string literal', () => {
    const sql = `SELECT 'x AS account_key' AS label, clarion_key('Accounts', a.ID) AS account_key FROM Accounts a`;
    expect(keyFormOf(sql, 'account_key')).toEqual({ kind: 'hashed', entity: 'accounts' });
  });

  it('screenshot shape: ROW_NUMBER() OVER (ORDER BY a.ID) AS account_key', () => {
    const sql = `SELECT\n  ROW_NUMBER() OVER (\n    ORDER BY\n      a.ID\n  ) AS account_key,\n  a.ID AS account_id\nFROM Accounts a`;
    expect(keyFormOf(sql, 'account_key')).toEqual({ kind: 'unstable', fn: 'ROW_NUMBER' });
  });
});

describe('keyRuleViolations', () => {
  const dim = (key: string): KeyRuleTable => ({
    table_name: 'dim_account', table_role: 'dimension',
    transformation_sql: `SELECT ${key} AS account_key, a.ID AS account_id, a.Name FROM Accounts a`,
    columns: [{ column_name: 'account_key', column_role: 'surrogate_key' }, { column_name: 'account_id', column_role: 'natural_key' }],
  });
  const fact = (fk: string): KeyRuleTable => ({
    table_name: 'fact_sales', table_role: 'fact',
    transformation_sql: `SELECT ${fk} AS account_key, TRY_CAST(l.InvoiceDate AS DATE) AS d, l.Amount FROM SalesInvoiceLines l`,
    columns: [{ column_name: 'account_key', column_role: 'foreign_key' }],
  });
  const join = [{ from_table: 'fact_sales', from_column: 'account_key', to_table: 'dim_account', to_column: 'account_key' }];

  it('passes the rule: both ends hash the same entity', () => {
    expect(keyRuleViolations([dim(`clarion_key('Accounts', a.ID)`), fact(`clarion_key('Accounts', l.Account)`)], join, { mode: 'strict' })).toEqual([]);
  });

  it('refuses the two ends hashing different entities — they would never match', () => {
    const v = keyRuleViolations([dim(`clarion_key('Accounts', a.ID)`), fact(`clarion_key('Account', l.Account)`)], join, { mode: 'strict' });
    expect(v.join('\n')).toMatch(/different entities/);
  });

  it('refuses a key renumbered per build, in both modes', () => {
    for (const mode of ['strict', 'consistent'] as const) {
      expect(keyRuleViolations([dim('ROW_NUMBER() OVER (ORDER BY a.ID)')], [], { mode }).join('\n')).toMatch(/renumbered/);
    }
  });

  it('strict: a raw id key and a looked-up FK are refused; consistent: a legacy pair still saves', () => {
    const legacy = [dim('a.ID'), fact('l.Account')];
    expect(keyRuleViolations(legacy, join, { mode: 'strict' }).length).toBeGreaterThan(0);
    expect(keyRuleViolations(legacy, join, { mode: 'consistent' })).toEqual([]);
  });

  it('consistent: switching ONE end of a join is refused, whichever end', () => {
    expect(keyRuleViolations([dim(`clarion_key('Accounts', a.ID)`), fact('l.Account')], join, { mode: 'consistent' }).join('\n'))
      .toMatch(/this column is not/);
    expect(keyRuleViolations([dim('a.ID'), fact(`clarion_key('Accounts', l.Account)`)], join, { mode: 'consistent' }).join('\n'))
      .toMatch(/lookup's key is not/);
  });

  it('dim_date keeps its YYYYMMDD key', () => {
    const date: KeyRuleTable = {
      table_name: 'dim_date', transformation_sql: `SELECT CAST(strftime(d, '%Y%m%d') AS INTEGER) AS date_key FROM x`,
      columns: [{ column_name: 'date_key', column_role: 'surrogate_key' }],
    };
    expect(keyRuleViolations([date], [{ from_table: 'fact_sales', from_column: 'date_key', to_table: 'dim_date', to_column: 'date_key' }], { mode: 'strict' })).toEqual([]);
  });

  it('onlyTables limits the report to the table being edited', () => {
    const tables = [dim('ROW_NUMBER() OVER (ORDER BY a.ID)'), fact('l.Account')];
    expect(keyRuleViolations(tables, join, { mode: 'consistent', onlyTables: ['fact_sales'] })).toEqual([]);
    expect(keyRuleViolations(tables, join, { mode: 'consistent', onlyTables: ['dim_account'] }).length).toBe(1);
  });
});

describe('changedKeys (the runner refuses an AI repair that re-keys a table)', () => {
  const before = `SELECT clarion_key('Accounts', a.ID) AS account_key, CAST(a.Code AS VARCHAR) AS code, clarion_key('Accounts', a.Parent) AS "parent_key" FROM Accounts a`;
  it('finds every hashed column, quoted aliases included', () => {
    expect([...hashedKeyColumns(before).entries()]).toEqual([['account_key', 'accounts'], ['parent_key', 'accounts']]);
  });
  it('lets a repair that keeps the keys through, and names the ones it changes', () => {
    expect(changedKeys(before, before.replace('CAST(a.Code AS VARCHAR)', 'TRY_CAST(a.Code AS VARCHAR)'))).toEqual([]);
    expect(changedKeys(before, before.replace("clarion_key('Accounts', a.ID)", 'a.ID'))).toEqual([`account_key is no longer clarion_key('accounts', …)`]);
    expect(changedKeys(before, before.replace("clarion_key('Accounts', a.ID)", "clarion_key('Account', a.ID)"))).toEqual([`account_key now hashes 'account' instead of 'accounts'`]);
    expect(changedKeys(before, before.replace("clarion_key('Accounts', a.ID)", 'ROW_NUMBER() OVER (ORDER BY a.ID)'))).toHaveLength(1);
  });
});

describe('replaceSelectItem (the key upgrade rewrites one select item, nothing else)', () => {
  it('replaces the screenshot key in place, keeping layout and every other column', () => {
    const sql = `SELECT\n  ROW_NUMBER() OVER (\n    ORDER BY\n      a.ID\n  ) AS account_key,\n  a.ID AS account_id,\n  a.Code\nFROM Accounts a`;
    expect(replaceSelectItem(sql, 'account_key', "clarion_key('Accounts', a.ID)"))
      .toBe(`SELECT\n  clarion_key('Accounts', a.ID) AS account_key,\n  a.ID AS account_id,\n  a.Code\nFROM Accounts a`);
  });
  it('handles a first item after DISTINCT, a CTE, and returns null for an unknown column', () => {
    expect(replaceSelectItem(`SELECT DISTINCT a.ID AS k, a.Name FROM A a`, 'k', "clarion_key('A', a.ID)"))
      .toBe(`SELECT DISTINCT clarion_key('A', a.ID) AS k, a.Name FROM A a`);
    expect(replaceSelectItem(`WITH x AS (SELECT l.Account AS account_key FROM L l) SELECT x.account_key FROM x`, 'account_key', "clarion_key('Accounts', l.Account)"))
      .toBe(`WITH x AS (SELECT clarion_key('Accounts', l.Account) AS account_key FROM L l) SELECT x.account_key FROM x`);
    expect(replaceSelectItem(`SELECT 1 AS a`, 'nope', 'x')).toBeNull();
  });
});
