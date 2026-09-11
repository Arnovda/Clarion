/**
 * Type mapping and value coercion.
 *
 * The headline test is the last one: EVERY type any dialect can produce must
 * be on the warehouse writer's allow-list. A type outside it is not rejected
 * by the writer — the column is silently filtered out of the read — so an
 * unmapped type makes a column disappear with nothing anywhere saying so.
 */

import { describe, expect, it } from 'vitest';
import { isSafeSqlType } from '../parquetOps';
import { baseDuckDbType, isExcludedType, normaliseTypeName, normaliseValue } from './typeMap';
import { postgresDialect } from '../postgres/dialect';
import { mysqlDialect } from '../mysql/dialect';
import { mssqlDialect } from '../mssql/dialect';
import type { RawColumn } from './types';

const c = (type: string, extra: Partial<RawColumn> = {}): RawColumn => ({
  table_name: 't', column_name: 'x', data_type: type, ordinal_position: 1, is_nullable: true, ...extra,
});

describe('normaliseTypeName', () => {
  it('strips the modifiers a catalog view leaves behind', () => {
    expect(normaliseTypeName('varchar(255)')).toBe('varchar');
    expect(normaliseTypeName('numeric(10,2)')).toBe('numeric');
    expect(normaliseTypeName('timestamp(3) with time zone')).toBe('timestamp with time zone');
    expect(normaliseTypeName('  INT  ')).toBe('int');
  });

  it('recognises the array spellings', () => {
    expect(normaliseTypeName('integer[]')).toBe('array');
    expect(normaliseTypeName('_int4')).toBe('array');
    expect(normaliseTypeName('ARRAY')).toBe('array');
  });

  it('drops MySQL column attributes', () => {
    expect(normaliseTypeName('int unsigned')).toBe('int');
    expect(normaliseTypeName('bigint(20) unsigned zerofill')).toBe('bigint');
  });
});

describe('baseDuckDbType', () => {
  it('maps the common families', () => {
    expect(baseDuckDbType(c('bigint'))).toBe('BIGINT');
    expect(baseDuckDbType(c('integer'))).toBe('INTEGER');
    expect(baseDuckDbType(c('boolean'))).toBe('BOOLEAN');
    expect(baseDuckDbType(c('date'))).toBe('DATE');
    expect(baseDuckDbType(c('timestamp with time zone'))).toBe('TIMESTAMPTZ');
    expect(baseDuckDbType(c('uuid'))).toBe('UUID');
    expect(baseDuckDbType(c('text'))).toBe('VARCHAR');
  });

  it('keeps a declared decimal width', () => {
    expect(baseDuckDbType(c('numeric', { numeric_precision: 12, numeric_scale: 2 }))).toBe('DECIMAL(12,2)');
  });

  it('falls back to DOUBLE for an unconstrained numeric', () => {
    // Postgres allows `numeric` with no width, and DuckDB requires one. DOUBLE
    // aggregates correctly; the cost is rounding past 15 significant digits.
    expect(baseDuckDbType(c('numeric'))).toBe('DOUBLE');
  });

  it('clamps a precision DuckDB cannot represent', () => {
    expect(baseDuckDbType(c('numeric', { numeric_precision: 60, numeric_scale: 80 }))).toBe('DECIMAL(38,38)');
  });

  it('sends anything unrecognised to VARCHAR rather than guessing', () => {
    expect(baseDuckDbType(c('some_vendor_extension'))).toBe('VARCHAR');
    expect(baseDuckDbType(c('jsonb'))).toBe('VARCHAR');
    expect(baseDuckDbType(c('time without time zone'))).toBe('VARCHAR');
  });
});

describe('dialect disagreements', () => {
  it('reads `bit` as a bit string on Postgres and a boolean on the others', () => {
    // The one type name the three genuinely disagree about.
    expect(postgresDialect.toDuckDbType(c('bit'))).toBe('VARCHAR');
    expect(mysqlDialect.toDuckDbType(c('bit', { column_type: 'bit(1)' }))).toBe('BOOLEAN');
    expect(mssqlDialect.toDuckDbType(c('bit'))).toBe('BOOLEAN');
  });

  it('treats MySQL tinyint(1) as a boolean and wider tinyint as a number', () => {
    expect(mysqlDialect.toDuckDbType(c('tinyint', { column_type: 'tinyint(1)' }))).toBe('BOOLEAN');
    expect(mysqlDialect.toDuckDbType(c('tinyint', { column_type: 'tinyint(4)' }))).toBe('TINYINT');
  });

  it('widens MySQL unsigned integers so the range still fits', () => {
    expect(mysqlDialect.toDuckDbType(c('tinyint', { column_type: 'tinyint(3) unsigned' }))).toBe('SMALLINT');
    expect(mysqlDialect.toDuckDbType(c('int', { column_type: 'int(10) unsigned' }))).toBe('BIGINT');
    // bigint unsigned cannot widen — kept BIGINT so an impossible value fails
    // the cast loudly instead of being silently rounded by a DOUBLE.
    expect(mysqlDialect.toDuckDbType(c('bigint', { column_type: 'bigint(20) unsigned' }))).toBe('BIGINT');
  });

  it('keeps Postgres money as text and SQL Server money as an exact decimal', () => {
    // The Postgres driver returns '$1,234.56'; a numeric cast would fail and
    // take the whole table's read with it.
    expect(postgresDialect.toDuckDbType(c('money'))).toBe('VARCHAR');
    expect(mssqlDialect.toDuckDbType(c('money'))).toBe('DECIMAL(19,4)');
  });

  it('does not read a SQL Server datetime precision as a decimal width', () => {
    expect(mssqlDialect.toDuckDbType(c('datetime2', { numeric_precision: 27, numeric_scale: 7 }))).toBe('TIMESTAMP');
  });
});

describe('excluded types', () => {
  it('drops binary columns', () => {
    for (const t of ['bytea', 'blob', 'varbinary(max)', 'image', 'geometry']) {
      expect(isExcludedType(t)).toBe(true);
    }
  });
  it('keeps everything analysable', () => {
    for (const t of ['text', 'integer', 'jsonb', 'uuid', 'timestamp']) {
      expect(isExcludedType(t)).toBe(false);
    }
  });
});

describe('normaliseValue', () => {
  it('turns a Date into ISO text and nulls an invalid one', () => {
    expect(normaliseValue(new Date('2026-03-04T05:06:07.000Z'), 'TIMESTAMP')).toBe('2026-03-04T05:06:07.000Z');
    expect(normaliseValue(new Date('nope'), 'TIMESTAMP')).toBeNull();
  });

  it('stringifies a BigInt instead of throwing', () => {
    // `JSON.stringify` throws on a BigInt, which would abort the whole write.
    expect(normaliseValue(9007199254740993n, 'BIGINT')).toBe('9007199254740993');
  });

  it('coerces 0/1 to a boolean when that is the column type', () => {
    expect(normaliseValue(1, 'BOOLEAN')).toBe(true);
    expect(normaliseValue(0, 'BOOLEAN')).toBe(false);
    expect(normaliseValue('t', 'BOOLEAN')).toBe(true);
    expect(normaliseValue('false', 'BOOLEAN')).toBe(false);
    // A real boolean passes straight through.
    expect(normaliseValue(false, 'BOOLEAN')).toBe(false);
  });

  it('serialises json and array values as text', () => {
    expect(normaliseValue({ a: 1 }, 'VARCHAR')).toBe('{"a":1}');
    expect(normaliseValue([1, 2], 'VARCHAR')).toBe('[1,2]');
  });

  it('never embeds binary, even if one slips through', () => {
    expect(normaliseValue(Buffer.from('hello'), 'VARCHAR')).toBeNull();
  });

  it('nulls a non-finite number rather than writing NaN', () => {
    expect(normaliseValue(Number.NaN, 'DOUBLE')).toBeNull();
    expect(normaliseValue(Infinity, 'DOUBLE')).toBeNull();
  });
});

describe('the allow-list invariant', () => {
  it('every type any dialect can produce is one the writer accepts', () => {
    // An unlisted type is not rejected by the writer — the column is silently
    // dropped from the read. So this is the test that keeps a column from
    // disappearing without a trace.
    const types = [
      'bigint', 'int8', 'integer', 'int', 'int4', 'smallint', 'int2', 'tinyint', 'mediumint',
      'numeric', 'decimal', 'money', 'smallmoney', 'real', 'float4', 'double precision', 'float', 'float8',
      'boolean', 'bool', 'bit', 'bit varying', 'date', 'time', 'time without time zone',
      'timestamp', 'timestamp with time zone', 'timestamptz', 'datetime', 'datetime2', 'smalldatetime',
      'datetimeoffset', 'uuid', 'uniqueidentifier', 'text', 'varchar(50)', 'nvarchar(max)', 'char(3)',
      'json', 'jsonb', 'xml', 'enum', 'set', 'array', 'integer[]', '_int4', 'inet', 'cidr', 'interval',
      'citext', 'year', 'longtext', 'sql_variant', 'hierarchyid', 'some_unknown_vendor_type',
    ];
    const dialects = [postgresDialect, mysqlDialect, mssqlDialect];
    const bad: string[] = [];
    for (const d of dialects) {
      for (const t of types) {
        for (const extra of [{}, { numeric_precision: 12, numeric_scale: 2 }, { column_type: `${t}(1) unsigned` }]) {
          const mapped = d.toDuckDbType(c(t, extra));
          if (!isSafeSqlType(mapped)) bad.push(`${d.id}: ${t} -> ${mapped}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
