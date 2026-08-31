/**
 * Worksheet → warehouse table. These rules decide what a customer's
 * spreadsheet becomes in the catalog, so the cases below are mostly about
 * the ways a real workbook is messy: symbols in headers, two headers that
 * reduce to one name, spacer rows, a stray word in a numeric column.
 */

import { describe, expect, it } from 'vitest';
import {
  coerceCell,
  dedupeIdentifiers,
  deriveColumnNames,
  inferSqlType,
  sanitiseEntityName,
  sanitiseIdentifier,
  sheetToTable,
} from './tabular';
import type { XlsxSheet } from './xlsxReader';

const sheet = (rows: XlsxSheet['rows']): XlsxSheet => ({ name: 'S', rows, truncated: false });

describe('sanitiseIdentifier', () => {
  it('folds diacritics instead of dropping the letter', () => {
    // Dropping the accented character would silently rename the column to
    // something the user never wrote.
    expect(sanitiseIdentifier('Fabriqué')).toBe('Fabrique');
    // NFD cannot fold these — they need the transliteration table.
    expect(sanitiseIdentifier('Größe')).toBe('Grosse');
    expect(sanitiseIdentifier('Kærlighed')).toBe('Kaerlighed');
    expect(sanitiseIdentifier('Ø-budget')).toBe('O_budget');
  });

  it('replaces symbols and collapses separators', () => {
    expect(sanitiseIdentifier('Bedrag (EUR)')).toBe('Bedrag_EUR');
    expect(sanitiseIdentifier('  spaced   out  ')).toBe('spaced_out');
  });

  it('prefixes a leading digit so the identifier is valid', () => {
    expect(sanitiseIdentifier('2026 budget')).toBe('c_2026_budget');
  });

  it('returns null when nothing usable survives', () => {
    expect(sanitiseIdentifier('   ')).toBeNull();
    expect(sanitiseIdentifier('€€€')).toBeNull();
  });
});

describe('dedupeIdentifiers', () => {
  it('suffixes duplicates instead of merging them', () => {
    expect(dedupeIdentifiers(['Bedrag', 'Bedrag', 'Bedrag'])).toEqual(['Bedrag', 'Bedrag_2', 'Bedrag_3']);
  });

  it('treats names case-insensitively, as the warehouse does', () => {
    expect(dedupeIdentifiers(['Total', 'total'])).toEqual(['Total', 'total_2']);
  });

  it('does not collide with a suffix that already exists in the source', () => {
    // Naively appending _2 to the second `A` would clash with the literal
    // `A_2` column and lose one of them.
    expect(dedupeIdentifiers(['A', 'A_2', 'A'])).toEqual(['A', 'A_2', 'A_3']);
  });
});

describe('deriveColumnNames', () => {
  it('names empty header cells positionally and keeps the original text', () => {
    const cols = deriveColumnNames(['Klant', null, 'Bedrag (EUR)']);
    expect(cols.map((c) => c.name)).toEqual(['Klant', 'column_2', 'Bedrag_EUR']);
    expect(cols[2].sourceHeader).toBe('Bedrag (EUR)');
    expect(cols[1].sourceHeader).toBe('Column 2');
  });

  it('keeps two headers that sanitise alike as two columns', () => {
    const cols = deriveColumnNames(['Bedrag (EUR)', 'Bedrag %']);
    expect(new Set(cols.map((c) => c.name)).size).toBe(2);
  });
});

describe('inferSqlType', () => {
  it('commits to a type only when every non-empty value fits', () => {
    expect(inferSqlType([1, 2, 3])).toBe('BIGINT');
    expect(inferSqlType([1, 2.5])).toBe('DOUBLE');
    expect(inferSqlType([true, false])).toBe('BOOLEAN');
    expect(inferSqlType(['2026-01-01', '2026-02-01'])).toBe('DATE');
  });

  it('falls back to text on one non-conforming value', () => {
    // The alternative is a silent null where the customer typed something.
    expect(inferSqlType([1, 2, 'n.v.t.'])).toBe('VARCHAR');
    expect(inferSqlType(['2026-01-01', 'onbekend'])).toBe('VARCHAR');
  });

  it('ignores empties when deciding', () => {
    expect(inferSqlType([1, null, '', 3])).toBe('BIGINT');
  });

  it('does not guess from no evidence', () => {
    expect(inferSqlType([])).toBe('VARCHAR');
    expect(inferSqlType([null, '', null])).toBe('VARCHAR');
  });

  it('uses DOUBLE for integers beyond exact representation', () => {
    expect(inferSqlType([Number.MAX_SAFE_INTEGER + 2])).toBe('DOUBLE');
  });
});

describe('coerceCell', () => {
  it('stringifies non-strings for a text column', () => {
    expect(coerceCell(42, 'VARCHAR')).toBe('42');
    expect(coerceCell(true, 'VARCHAR')).toBe('true');
  });

  it('maps empties to null', () => {
    expect(coerceCell('', 'VARCHAR')).toBeNull();
    expect(coerceCell(null, 'BIGINT')).toBeNull();
  });

  it('leaves typed values alone', () => {
    expect(coerceCell(42, 'BIGINT')).toBe(42);
  });
});

describe('sheetToTable', () => {
  it('builds columns and records from a header row', () => {
    const t = sheetToTable(sheet([
      ['Klant', 'Bedrag'],
      ['Acme', 100],
      ['Globex', 250],
    ]));
    expect(t.columns.map((c) => [c.name, c.sqlType])).toEqual([['Klant', 'VARCHAR'], ['Bedrag', 'BIGINT']]);
    expect(t.rows).toEqual([
      { Klant: 'Acme', Bedrag: 100 },
      { Klant: 'Globex', Bedrag: 250 },
    ]);
  });

  it('skips spacer rows above the header', () => {
    const t = sheetToTable(sheet([
      [null, null],
      ['Klant', 'Bedrag'],
      ['Acme', 100],
    ]));
    expect(t.columns.map((c) => c.name)).toEqual(['Klant', 'Bedrag']);
    expect(t.rows).toEqual([{ Klant: 'Acme', Bedrag: 100 }]);
  });

  it('drops blank rows between data', () => {
    const t = sheetToTable(sheet([
      ['Klant'],
      ['Acme'],
      [null],
      ['Globex'],
    ]));
    expect(t.rows).toEqual([{ Klant: 'Acme' }, { Klant: 'Globex' }]);
  });

  it('gives every record every key, even where the row was short', () => {
    const t = sheetToTable(sheet([
      ['A', 'B'],
      ['x', 'y'],
      ['z', null],
    ]));
    expect(t.rows[1]).toEqual({ A: 'z', B: null });
  });

  it('uses positional columns when the sheet has no header', () => {
    const t = sheetToTable(sheet([['Acme', 100], ['Globex', 250]]), { headerRow: false });
    expect(t.columns.map((c) => c.name)).toEqual(['column_1', 'column_2']);
    expect(t.rows).toHaveLength(2);
  });

  it('returns nothing for an empty sheet rather than a phantom column', () => {
    expect(sheetToTable(sheet([]))).toEqual({ columns: [], rows: [] });
    expect(sheetToTable(sheet([[null, null]]))).toEqual({ columns: [], rows: [] });
  });
});

describe('sanitiseEntityName', () => {
  it('keeps hyphens, which table names allow and column names do not', () => {
    expect(sanitiseEntityName('Budget-2026')).toBe('Budget-2026');
  });

  it('reduces spaces and symbols', () => {
    expect(sanitiseEntityName('Budget 2026 (concept)')).toBe('Budget_2026_concept');
  });

  it('returns null when nothing usable survives', () => {
    expect(sanitiseEntityName('📊')).toBeNull();
  });
});
