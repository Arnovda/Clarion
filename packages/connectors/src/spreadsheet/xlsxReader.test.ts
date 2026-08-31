/**
 * Reader tests. Every case runs against a REAL .xlsx produced by the fixture
 * builder (correct zip framing, CRC32s, content types) rather than against a
 * hand-written XML string — a parser tested only on input its own author
 * shaped proves very little.
 */

import { describe, expect, it } from 'vitest';
import { readXlsx, SpreadsheetReadError } from './xlsxReader';
import { buildXlsxFixture } from './__fixtures__/xlsxFixture';

describe('readXlsx', () => {
  it('reads strings, numbers and booleans from inline cells', async () => {
    const buf = buildXlsxFixture([
      { name: 'Sheet1', rows: [['Naam', 'Bedrag', 'Actief'], ['Acme', 1234.5, true], ['Globex', 0, false]] },
    ]);
    const wb = await readXlsx(buf);
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].name).toBe('Sheet1');
    expect(wb.sheets[0].rows).toEqual([
      ['Naam', 'Bedrag', 'Actief'],
      ['Acme', 1234.5, true],
      ['Globex', 0, false],
    ]);
    expect(wb.sheets[0].truncated).toBe(false);
  });

  it('resolves shared strings', async () => {
    const buf = buildXlsxFixture(
      [{ name: 'Data', rows: [['Klant', 'Klant'], ['Acme', 'Acme']] }],
      { useSharedStrings: true },
    );
    const wb = await readXlsx(buf);
    // Both cells intern to the same shared entry — resolving by index must
    // still give each cell its own value back.
    expect(wb.sheets[0].rows).toEqual([['Klant', 'Klant'], ['Acme', 'Acme']]);
  });

  it('converts date-styled serials to ISO dates', async () => {
    // 45000 = 2023-03-15 in the 1900 system.
    const buf = buildXlsxFixture(
      [{ name: 'S', rows: [['Datum', 'Bedrag'], [45000, 10]] }],
      { dateColumns: [0] },
    );
    const wb = await readXlsx(buf);
    expect(wb.sheets[0].rows[1][0]).toBe('2023-03-15');
    // The unstyled numeric column stays a number — the style, not the value,
    // is what makes a cell a date.
    expect(wb.sheets[0].rows[1][1]).toBe(10);
  });

  it('honours the 1904 date system', async () => {
    const buf = buildXlsxFixture(
      [{ name: 'S', rows: [['Datum'], [45000]] }],
      { dateColumns: [0], date1904: true },
    );
    const wb = await readXlsx(buf);
    // The two systems are exactly 1462 days apart (Excel's documented
    // offset), so the same serial reads 1462 days later here.
    expect(wb.sheets[0].rows[1][0]).toBe('2027-03-16');
  });

  it('reads stored (uncompressed) zip entries', async () => {
    const buf = buildXlsxFixture([{ name: 'S', rows: [['a'], ['b']] }], { store: true });
    const wb = await readXlsx(buf);
    expect(wb.sheets[0].rows).toEqual([['a'], ['b']]);
  });

  it('keeps every sheet and its name', async () => {
    const buf = buildXlsxFixture([
      { name: 'Budget 2026', rows: [['x'], [1]] },
      { name: 'Mapping', rows: [['y'], [2]] },
    ]);
    const wb = await readXlsx(buf);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Budget 2026', 'Mapping']);
    expect(wb.sheets[1].rows).toEqual([['y'], [2]]);
  });

  it('pads sparse rows and trims trailing empties', async () => {
    const buf = buildXlsxFixture([
      { name: 'S', rows: [['a', null, 'c'], ['x'], [null, null, null]] },
    ]);
    const wb = await readXlsx(buf);
    // The all-empty trailing row is dropped; the short row is padded to width.
    expect(wb.sheets[0].rows).toEqual([['a', null, 'c'], ['x', null, null]]);
  });

  it('REPORTS truncation rather than silently returning a partial sheet', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [i]);
    const buf = buildXlsxFixture([{ name: 'S', rows }]);
    const wb = await readXlsx(buf, { maxRows: 10 });
    expect(wb.sheets[0].truncated).toBe(true);
    expect(wb.sheets[0].rows.length).toBeLessThanOrEqual(10);
  });

  it('does not flag truncation when the sheet fits', async () => {
    const buf = buildXlsxFixture([{ name: 'S', rows: [[1], [2], [3]] }]);
    const wb = await readXlsx(buf, { maxRows: 10 });
    expect(wb.sheets[0].truncated).toBe(false);
  });

  it('rejects a non-xlsx buffer with a user-safe message', async () => {
    const notAZip = new TextEncoder().encode('this is a CSV, not a workbook').buffer;
    await expect(readXlsx(notAZip as ArrayBuffer)).rejects.toBeInstanceOf(SpreadsheetReadError);
    await expect(readXlsx(notAZip as ArrayBuffer)).rejects.toThrow(/not an excel file/i);
  });

  it('escapes round-trip through XML entities', async () => {
    const buf = buildXlsxFixture([
      { name: 'S', rows: [['A & B'], ['<tag>'], ['quote " here']] },
    ]);
    const wb = await readXlsx(buf);
    expect(wb.sheets[0].rows).toEqual([['A & B'], ['<tag>'], ['quote " here']]);
  });
});
