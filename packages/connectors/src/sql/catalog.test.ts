/**
 * Catalog builder — the part of the SQL kit that turns a customer's schema
 * into something Clarion can sync. Pure, so every case is exercised here
 * rather than discovered against a live database.
 */

import { describe, expect, it } from 'vitest';
import { buildCatalog, toEntityDescriptor } from './catalog';
import { validateEntityCatalog } from '../conformance';
import { postgresDialect } from '../postgres/dialect';
import type { RawColumn, RawForeignKey, RawPrimaryKey, RawTable } from './types';

const col = (
  table: string, name: string, type: string, ord: number,
  extra: Partial<RawColumn> = {},
): RawColumn => ({
  table_name: table, column_name: name, data_type: type, ordinal_position: ord,
  is_nullable: false, ...extra,
});

/** A small but awkward schema: every shape the builder has to handle. */
function fixture(): {
  tables: RawTable[]; columns: RawColumn[]; primaryKeys: RawPrimaryKey[]; foreignKeys: RawForeignKey[];
} {
  const tables: RawTable[] = [
    { table_name: 'customers', table_type: 'table', table_comment: 'People who buy things', estimated_rows: 4200 },
    { table_name: 'orders', table_type: 'table', table_comment: null, estimated_rows: 99000 },
    { table_name: 'Order Items', table_type: 'table', table_comment: null },
    { table_name: 'documents', table_type: 'table', table_comment: null },
    { table_name: 'legacy log', table_type: 'table', table_comment: null },
    { table_name: 'v_revenue', table_type: 'view', table_comment: null },
  ];
  const columns: RawColumn[] = [
    // customers — the good case: single-column key + a NOT NULL updated_at.
    col('customers', 'id', 'bigint', 1),
    col('customers', 'name', 'varchar', 2, { column_comment: 'Legal name' }),
    col('customers', 'created_at', 'timestamp', 3),
    col('customers', 'updated_at', 'timestamp', 4),
    // orders — has a modified column, but it is NULLABLE.
    col('orders', 'id', 'integer', 1),
    col('orders', 'customer_id', 'bigint', 2),
    col('orders', 'total', 'numeric', 3, { numeric_precision: 12, numeric_scale: 2 }),
    col('orders', 'modified', 'timestamp', 4, { is_nullable: true }),
    // Order Items — composite key, and two headings that collide once sanitised.
    col('Order Items', 'order_id', 'integer', 1),
    col('Order Items', 'line_no', 'integer', 2),
    col('Order Items', 'Order Date', 'date', 3),
    col('Order Items', 'Order.Date', 'date', 4),
    col('Order Items', '2nd value', 'integer', 5),
    // documents — a binary column that must not reach the warehouse.
    col('documents', 'id', 'integer', 1),
    col('documents', 'title', 'text', 2),
    col('documents', 'body', 'bytea', 3),
    // legacy log — no primary key at all.
    col('legacy log', 'message', 'text', 1),
    // a view
    col('v_revenue', 'month', 'date', 1),
    col('v_revenue', 'amount', 'numeric', 2, { numeric_precision: 14, numeric_scale: 2 }),
  ];
  const primaryKeys: RawPrimaryKey[] = [
    { table_name: 'customers', column_name: 'id', ordinal: 1 },
    { table_name: 'orders', column_name: 'id', ordinal: 1 },
    { table_name: 'Order Items', column_name: 'order_id', ordinal: 1 },
    { table_name: 'Order Items', column_name: 'line_no', ordinal: 2 },
    { table_name: 'documents', column_name: 'id', ordinal: 1 },
  ];
  const foreignKeys: RawForeignKey[] = [
    { from_table: 'orders', from_column: 'customer_id', to_table: 'customers', to_column: 'id' },
    { from_table: 'Order Items', from_column: 'order_id', to_table: 'orders', to_column: 'id' },
    // An endpoint outside the schema: must be dropped, not half-rendered.
    { from_table: 'orders', from_column: 'region_id', to_table: 'regions', to_column: 'id' },
  ];
  return { tables, columns, primaryKeys, foreignKeys };
}

const build = (over: Partial<Parameters<typeof buildCatalog>[0]> = {}) =>
  buildCatalog({ schema: 'public', dialect: postgresDialect, ...fixture(), ...over });

const byName = (r: ReturnType<typeof buildCatalog>, n: string) => {
  const e = r.entities.find((x) => x.name === n);
  if (!e) throw new Error(`no entity '${n}' in [${r.entities.map((x) => x.name).join(', ')}]`);
  return e;
};

describe('buildCatalog — names', () => {
  it('makes every table and column name warehouse-safe', () => {
    const r = build();
    expect(r.entities.map((e) => e.name).sort()).toEqual(
      ['Order_Items', 'customers', 'documents', 'legacy_log', 'orders', 'v_revenue'].sort(),
    );
    const items = byName(r, 'Order_Items');
    // `Order Date` and `Order.Date` both sanitise to `Order_Date`; the second
    // must not overwrite the first.
    expect(items.columns.map((c) => c.name)).toEqual(
      ['order_id', 'line_no', 'Order_Date', 'Order_Date_2', 'c_2nd_value'],
    );
    // Both names survive: the SELECT needs the real one, the Parquet the safe one.
    expect(items.columns.map((c) => c.sourceName)).toEqual(
      ['order_id', 'line_no', 'Order Date', 'Order.Date', '2nd value'],
    );
  });

  it('is deterministic — the same schema always yields the same names', () => {
    // Names are persisted in `selected_entities` and used as warehouse table
    // names, so a name that moved between syncs would orphan everything built
    // on it. Shuffling the introspection order must change nothing.
    const f = fixture();
    const a = buildCatalog({ schema: 'public', dialect: postgresDialect, ...f });
    const b = buildCatalog({
      schema: 'public', dialect: postgresDialect,
      tables: [...f.tables].reverse(),
      columns: f.columns,
      primaryKeys: f.primaryKeys,
      foreignKeys: f.foreignKeys,
    });
    expect(b.entities.map((e) => e.name)).toEqual(a.entities.map((e) => e.name));
  });
});

describe('buildCatalog — keys and cursors', () => {
  it('takes the single-column primary key as the business key', () => {
    const c = byName(build(), 'customers');
    expect(c.businessKey).toBe('id');
    expect(c.sourceKeyColumn).toBe('id');
  });

  it('refuses a composite primary key as a business key', () => {
    // The warehouse writer merges on ONE column; a composite key has no single
    // value to merge on, so the table is read in full and replaced instead.
    const items = byName(build(), 'Order_Items');
    expect(items.businessKey).toBeUndefined();
    expect(items.pkColumns).toEqual(['order_id', 'line_no']);
    expect(items.supportsIncremental).toBe(false);
  });

  it('detects a NOT NULL modified-timestamp as the cursor', () => {
    const c = byName(build(), 'customers');
    expect(c.supportsIncremental).toBe(true);
    expect(c.incrementalCursor?.field).toBe('updated_at');
    expect(c.sourceCursorColumn).toBe('updated_at');
  });

  it('never picks created_at, even when it is the only timestamp', () => {
    // A creation stamp does not move when a row is updated, so it would sync
    // inserts and silently miss every edit — the table looks fresh and is wrong.
    const f = fixture();
    const r = buildCatalog({
      schema: 'public', dialect: postgresDialect, ...f,
      columns: f.columns.filter((c) => !(c.table_name === 'customers' && c.column_name === 'updated_at')),
    });
    expect(byName(r, 'customers').supportsIncremental).toBe(false);
  });

  it('refuses a NULLABLE cursor column', () => {
    // `WHERE modified >= x` never matches a NULL, so any row inserted without
    // a stamp after the first sync would be invisible to every later one.
    const o = byName(build(), 'orders');
    expect(o.businessKey).toBe('id');
    expect(o.supportsIncremental).toBe(false);
    expect(o.incrementalCursor).toBeUndefined();
  });

  it('honours incrementalDetection: off', () => {
    const r = build({ incrementalDetection: 'off' });
    expect(r.entities.every((e) => !e.supportsIncremental)).toBe(true);
    // Turning incremental off must not cost the business key.
    expect(byName(r, 'customers').businessKey).toBe('id');
  });

  it('leaves a table with no primary key keyless rather than guessing', () => {
    const l = byName(build(), 'legacy_log');
    expect(l.businessKey).toBeUndefined();
    expect(l.pkColumns).toEqual([]);
  });
});

describe('buildCatalog — columns', () => {
  it('drops binary columns and says why', () => {
    const d = byName(build(), 'documents');
    expect(d.columns.map((c) => c.name)).toEqual(['id', 'title']);
    expect(d.excludedColumns).toEqual([
      { name: 'body', reason: expect.stringContaining('binary data') },
    ]);
  });

  it('keeps the database type verbatim alongside the warehouse type', () => {
    const c = byName(build(), 'customers');
    const id = c.columns.find((x) => x.name === 'id')!;
    expect(id.sqlType).toBe('BIGINT');
    // `source_data_type` is what lets the platform later refuse a UUID→code
    // relationship; both ends look like VARCHAR once in the warehouse.
    expect(id.sourceType).toBe('bigint');
  });

  it('carries a column comment through as documentation', () => {
    const name = byName(build(), 'customers').columns.find((c) => c.name === 'name')!;
    expect(name.comment).toBe('Legal name');
  });
});

describe('buildCatalog — relationships', () => {
  it('turns enforced foreign keys into declared relationships', () => {
    const r = build();
    expect(r.relationships).toContainEqual(expect.objectContaining({
      fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id',
      type: 'many_to_one',
    }));
    // Sanitised names on both ends, so the relationship matches the Parquet.
    expect(r.relationships).toContainEqual(expect.objectContaining({
      fromTable: 'Order_Items', fromColumn: 'order_id', toTable: 'orders',
    }));
  });

  it('drops a foreign key whose target is not in the catalog', () => {
    // A relationship pointing at a table nobody synced can never match; it
    // would only clutter the graph with a link that always reads as broken.
    expect(build().relationships.some((x) => x.toTable === 'regions')).toBe(false);
  });
});

describe('buildCatalog — conformance', () => {
  it('produces descriptors that pass the platform entity invariants', () => {
    // The same rules every hand-written catalog is held to. A dynamically
    // introspected catalog gets no exemption: name safety, unique names,
    // `supportsIncremental === !!incrementalCursor`, and the table-wipe
    // invariant `incrementalCursor ⇒ businessKey`.
    const descriptors = build().entities.map(toEntityDescriptor);
    expect(validateEntityCatalog('postgres', descriptors)).toEqual([]);
  });

  it('states its reading in the description so a wrong one can be caught', () => {
    const d = build().entities.map(toEntityDescriptor);
    expect(d.find((x) => x.name === 'customers')!.description)
      .toBe('People who buy things — incremental on updated_at');
    expect(d.find((x) => x.name === 'legacy_log')!.description)
      .toBe('no single-column primary key — read in full each sync');
    expect(d.find((x) => x.name === 'documents')!.description)
      .toContain('1 binary column(s) not synced');
  });
});
