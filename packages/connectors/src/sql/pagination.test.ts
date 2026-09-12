/**
 * Page SQL. Pure string building, and the place the three dialects are most
 * likely to drift apart — so each one is pinned here rather than checked by
 * eye against a live server.
 */

import { describe, expect, it } from 'vitest';
import { buildKeyPageQuery, buildPageQuery } from './pagination';
import { postgresDialect } from '../postgres/dialect';
import { mysqlDialect } from '../mysql/dialect';
import { mssqlDialect } from '../mssql/dialect';
import type { SqlSyntax } from './pagination';

const PG: SqlSyntax = { quoteIdent: (n) => `"${n.replace(/"/g, '""')}"`, placeholder: (i) => `$${i}`, limitStyle: 'limit' };
const MY: SqlSyntax = { quoteIdent: (n) => `\`${n.replace(/`/g, '``')}\``, placeholder: () => '?', limitStyle: 'limit' };
const MS: SqlSyntax = { quoteIdent: (n) => `[${n.replace(/]/g, ']]')}]`, placeholder: (i) => `@p${i}`, limitStyle: 'fetch' };

const base = { schema: 'public', table: 'orders', columns: ['id', 'total'], limit: 500 };

describe('keyset-cursor paging', () => {
  it('orders by (cursor, key) with no filter on the first full load', () => {
    // Cursor-ordered from the very first page, so even the initial load of a
    // large table is resumable rather than restarting at the worker ceiling.
    const q = buildPageQuery(PG, { ...base, plan: { mode: 'keyset-cursor', cursorColumn: 'updated_at', keyColumn: 'id' } });
    expect(q.sql).toBe('SELECT "id", "total" FROM "public"."orders" ORDER BY "updated_at" ASC, "id" ASC LIMIT 500');
    expect(q.params).toEqual([]);
  });

  it('applies the incremental lower bound INCLUSIVELY', () => {
    // `>=` not `>`: a second-precision stamp can be shared by several rows,
    // and `>` skips the ones that lost the race. Re-reading is free because
    // the writer merges by business key.
    const d = new Date('2026-01-01T00:00:00.000Z');
    const q = buildPageQuery(PG, {
      ...base, plan: { mode: 'keyset-cursor', cursorColumn: 'updated_at', keyColumn: 'id', lowerBound: d },
    });
    expect(q.sql).toContain('WHERE "updated_at" >= $1');
    expect(q.sql).not.toContain('> $1');
    expect(q.params).toEqual([d]);
  });

  it('expands the tuple comparison rather than using a row value', () => {
    // `(cursor, key) > (?, ?)` is not available on SQL Server, so one shape is
    // used everywhere.
    const q = buildPageQuery(PG, {
      ...base,
      plan: {
        mode: 'keyset-cursor', cursorColumn: 'updated_at', keyColumn: 'id',
        lowerBound: 'x', after: { cursor: 'c', key: 42 },
      },
    });
    expect(q.sql).toContain('AND ("updated_at" > $2 OR ("updated_at" = $3 AND "id" > $4))');
    expect(q.params).toEqual(['x', 'c', 'c', 42]);
  });
});

describe('keyset-key and offset paging', () => {
  it('pages by the primary key when there is no cursor', () => {
    const q = buildPageQuery(PG, { ...base, plan: { mode: 'keyset-key', keyColumn: 'id', after: 99 } });
    expect(q.sql).toBe('SELECT "id", "total" FROM "public"."orders" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 500');
    expect(q.params).toEqual([99]);
  });

  it('falls back to offset with a stable order for a composite key', () => {
    const q = buildPageQuery(PG, {
      ...base, plan: { mode: 'offset', orderBy: ['order_id', 'line_no'], offset: 1000 },
    });
    expect(q.sql).toBe(
      'SELECT "id", "total" FROM "public"."orders" ORDER BY "order_id" ASC, "line_no" ASC LIMIT 500 OFFSET 1000',
    );
  });

  it('still reads a table with nothing to order by', () => {
    const q = buildPageQuery(PG, { ...base, plan: { mode: 'offset', orderBy: [], offset: 0 } });
    expect(q.sql).toBe('SELECT "id", "total" FROM "public"."orders" LIMIT 500');
  });
});

describe('dialect spellings', () => {
  it('quotes and binds the MySQL way', () => {
    const q = buildPageQuery(MY, { ...base, plan: { mode: 'keyset-key', keyColumn: 'id', after: 5 } });
    expect(q.sql).toBe('SELECT `id`, `total` FROM `public`.`orders` WHERE `id` > ? ORDER BY `id` ASC LIMIT 500');
  });

  it('uses OFFSET/FETCH on SQL Server', () => {
    const q = buildPageQuery(MS, { ...base, plan: { mode: 'keyset-key', keyColumn: 'id', after: 5 } });
    expect(q.sql).toBe(
      'SELECT [id], [total] FROM [public].[orders] WHERE [id] > @p1 ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY',
    );
  });

  it('supplies SQL Server an ORDER BY even when there is nothing to sort on', () => {
    // OFFSET/FETCH is only legal after an ORDER BY, and a keyless table still
    // has to be readable.
    const q = buildPageQuery(MS, { ...base, plan: { mode: 'offset', orderBy: [], offset: 0 } });
    expect(q.sql).toContain('ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY');
  });

  it('escapes a quote character hiding in an identifier', () => {
    expect(PG.quoteIdent('we"ird')).toBe('"we""ird"');
    expect(MY.quoteIdent('we`ird')).toBe('`we``ird`');
    expect(MS.quoteIdent('we]ird')).toBe('[we]]ird]');
  });

  it('every dialect exposes the same quoting its page builder uses', () => {
    for (const [d, syntax] of [[postgresDialect, PG], [mysqlDialect, MY], [mssqlDialect, MS]] as const) {
      expect(d.quoteIdent('x')).toBe(syntax.quoteIdent('x'));
    }
  });
});

describe('key paging for reconcile', () => {
  it('selects only the key', () => {
    const q = buildKeyPageQuery(PG, { schema: 's', table: 't', keyColumn: 'id', limit: 50_000, after: 7 });
    expect(q.sql).toBe('SELECT "id" FROM "s"."t" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 50000');
    expect(q.params).toEqual([7]);
  });
});
