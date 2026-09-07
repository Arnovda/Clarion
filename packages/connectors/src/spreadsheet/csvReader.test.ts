/**
 * CSV reader tests.
 *
 * The cases that matter are the European ones, because that is where a CSV
 * reader written against American files goes quietly wrong: a semicolon
 * separator, `1.234,56` amounts, cp1252 bytes and `07/09/2026` dates all read
 * as something else entirely, and none of the four failures announces itself.
 */

import { describe, expect, it } from 'vitest';
import { SpreadsheetReadError } from './xlsxReader';
import { sheetToTable } from './tabular';
import {
  decodeCsvBytes,
  parseDelimited,
  readCsv,
  sniffDelimiter,
} from './csvReader';

function utf8(s: string): ArrayBuffer {
  const b = Buffer.from(s, 'utf8');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
function bytes(...vals: number[]): ArrayBuffer {
  return new Uint8Array(vals).buffer;
}
/**
 * What the reader made of a single-column file, header excluded.
 *
 * Values are quoted so that a European amount like `1.234,56` reaches the
 * typing rules as one field — the fixture must not do the very splitting the
 * delimiter sniffer exists to get right.
 */
function readColumn(values: string[]): unknown[] {
  const body = values.map((v) => `"${v.replace(/"/g, '""')}"`).join('\n');
  const { sheet } = readCsv(utf8(`Waarde\n${body}`));
  return sheet.rows.slice(1).map((r) => r[0]);
}

describe('decoding', () => {
  it('strips a UTF-8 byte-order mark', () => {
    const { text, encoding } = decodeCsvBytes(bytes(0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62));
    expect(text).toBe('a,b');
    expect(encoding).toBe('utf-8');
  });

  it('falls back to the Windows code page when the bytes are not valid UTF-8', () => {
    // What Excel's plain "CSV (comma delimited)" export writes on a Western
    // European Windows. Read as UTF-8 this is a hard decode failure.
    const { text, encoding } = decodeCsvBytes(bytes(0x43, 0x61, 0x66, 0xe9));
    expect(text).toBe('Café');
    expect(encoding).toBe('windows-1252');
  });

  it('maps the code page range Latin-1 gets wrong', () => {
    // 0x80 is the euro sign in windows-1252 and undefined in Latin-1 — the
    // single most likely byte in a European finance export.
    const { text } = decodeCsvBytes(bytes(0x80, 0x20, 0x31, 0x30, 0x30, 0xe9));
    expect(text).toBe('€ 100é');
  });

  it('reads UTF-16 with a byte-order mark', () => {
    const { text, encoding } = decodeCsvBytes(bytes(0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00));
    expect(text).toBe('a,b');
    expect(encoding).toBe('utf-16le');
  });

  it('says so plainly when UTF-8 was demanded and the bytes are not', () => {
    expect(() => decodeCsvBytes(bytes(0x43, 0xe9), 'utf-8')).toThrow(SpreadsheetReadError);
    expect(() => decodeCsvBytes(bytes(0x43, 0xe9), 'utf-8')).toThrow(/CSV UTF-8/);
  });

  it('refuses an empty file', () => {
    expect(() => decodeCsvBytes(bytes())).toThrow(SpreadsheetReadError);
  });
});

describe('delimiter sniffing', () => {
  it('finds the semicolon Excel writes in a European locale', () => {
    expect(sniffDelimiter('Klant;Bedrag\nAcme;1.234,56\nGlobex;900,00')).toBe(';');
  });

  it('is not fooled by commas inside quoted values', () => {
    // The whole reason sniffing uses the real parser rather than counting
    // characters: this file has more commas than semicolons.
    const text = 'Naam;Adres\nAcme;"Straat 1, Brussel"\nGlobex;"Laan 2, Gent"';
    expect(sniffDelimiter(text)).toBe(';');
  });

  it('finds a tab', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('prefers the separator that makes every row the same width', () => {
    expect(sniffDelimiter('a,b|c\n1,2|3\n4,5|6')).toBe(',');
  });

  it('answers harmlessly for a file with one column', () => {
    expect(sniffDelimiter('Klant\nAcme\nGlobex')).toBe(',');
  });
});

describe('parsing', () => {
  it('keeps a delimiter and a newline inside a quoted value', () => {
    const { rows } = parseDelimited('a,b\n"x,1\ny",2', ',');
    expect(rows).toEqual([['a', 'b'], ['x,1\ny', '2']]);
  });

  it('reads a doubled quote as one quote', () => {
    const { rows } = parseDelimited('"say ""hi""",2', ',');
    expect(rows[0]).toEqual(['say "hi"', '2']);
  });

  it('handles CRLF, LF and a bare CR in the same file', () => {
    const { rows } = parseDelimited('a,1\r\nb,2\nc,3\rd,4', ',');
    expect(rows).toEqual([['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']]);
  });

  it('does not invent a row for the trailing newline', () => {
    expect(parseDelimited('a,1\nb,2\n', ',').rows).toHaveLength(2);
  });

  it('keeps a last row that has no trailing newline', () => {
    expect(parseDelimited('a,1\nb,2', ',').rows).toHaveLength(2);
  });

  it('trims an unquoted value but keeps a quoted one exactly', () => {
    const { rows } = parseDelimited('  a  ,"  b  "', ',');
    expect(rows[0]).toEqual(['a', '  b  ']);
  });

  it('reports the row ceiling instead of obeying it', () => {
    // The signal `assertSheetComplete` turns into a refusal. A partial table
    // looks complete, so this must never be silent.
    const text = Array.from({ length: 10 }, (_, i) => `r${i},${i}`).join('\n');
    const { rows, truncated } = parseDelimited(text, ',', 4);
    expect(rows).toHaveLength(4);
    expect(truncated).toBe(true);
  });

  it('reports no truncation when the file ends exactly at the ceiling', () => {
    expect(parseDelimited('a,1\nb,2\n', ',', 2).truncated).toBe(false);
  });

  it('reports the column ceiling too', () => {
    expect(parseDelimited('a,b,c,d', ',', 100, 2).truncated).toBe(true);
  });
});

describe('numbers', () => {
  it('reads the Belgian convention', () => {
    expect(readColumn(['1.234,56', '900,00', '12'])).toEqual([1234.56, 900, 12]);
  });

  it('reads the English convention', () => {
    expect(readColumn(['1,234.56', '900.00', '12'])).toEqual([1234.56, 900, 12]);
  });

  it('leaves a column that contradicts itself as text', () => {
    // Half European, half English. Neither reading is safe for the other half,
    // and picking one silently would be wrong for it.
    expect(readColumn(['1.234,56', '2,345.67'])).toEqual(['1.234,56', '2,345.67']);
  });

  it('reads a lone three-digit group as thousands', () => {
    expect(readColumn(['1.234', '2.500'])).toEqual([1234, 2500]);
  });

  it('lets one unambiguous value settle the whole column', () => {
    // `1.5` can only be a decimal, so `1.234` in the same column is one and a
    // bit, not one thousand.
    expect(readColumn(['1.5', '1.234'])).toEqual([1.5, 1.234]);
  });

  it('treats a leading zero as an identifier, never a quantity', () => {
    // Converting drops the zero, and nothing downstream can tell it was there.
    expect(readColumn(['0123', '0456'])).toEqual(['0123', '0456']);
  });

  it('still reads a decimal that starts with zero', () => {
    expect(readColumn(['0,5', '0,25'])).toEqual([0.5, 0.25]);
  });

  it('leaves a number too long for a double as text', () => {
    expect(readColumn(['1234567890123456', '2'])).toEqual(['1234567890123456', '2']);
  });

  it('makes the whole column text for one non-numeric value', () => {
    expect(readColumn(['100', 'n/a', '300'])).toEqual(['100', 'n/a', '300']);
  });

  it('reads the accounting convention for a negative', () => {
    expect(readColumn(['(1.234,56)', '900,00'])).toEqual([-1234.56, 900]);
  });

  it('reads an amount that carries its currency symbol', () => {
    expect(readColumn(['€ 1.234,56', '€ 900,00'])).toEqual([1234.56, 900]);
  });

  it('reads a non-breaking space as digit grouping', () => {
    expect(readColumn(['1 234,56', '2 000,00'])).toEqual([1234.56, 2000]);
  });

  it('leaves a percentage alone', () => {
    // `50%` and `50` are different quantities; guessing which was meant is how
    // a column silently becomes a hundred times wrong.
    expect(readColumn(['50%', '25%'])).toEqual(['50%', '25%']);
  });

  it('refuses a badly grouped number rather than reading past it', () => {
    expect(readColumn(['1.23.456', '2'])).toEqual(['1.23.456', '2']);
  });
});

describe('dates', () => {
  it('defaults to day-first', () => {
    expect(readColumn(['07/09/2026', '01/02/2026'])).toEqual(['2026-09-07', '2026-02-01']);
  });

  it('lets one value above twelve settle the order for the column', () => {
    expect(readColumn(['13/01/2026', '01/02/2026'])).toEqual(['2026-01-13', '2026-02-01']);
  });

  it('reads an American export as month-first on its own evidence', () => {
    expect(readColumn(['01/13/2026', '02/01/2026'])).toEqual(['2026-01-13', '2026-02-01']);
  });

  it('leaves a column whose evidence conflicts as text', () => {
    expect(readColumn(['13/01/2026', '01/13/2026'])).toEqual(['13/01/2026', '01/13/2026']);
  });

  it('leaves a date that does not exist as text', () => {
    expect(readColumn(['31/02/2026', '01/03/2026'])).toEqual(['31/02/2026', '01/03/2026']);
  });

  it('normalises dots and dashes the same way', () => {
    expect(readColumn(['07.09.2026', '08.09.2026'])).toEqual(['2026-09-07', '2026-09-08']);
  });

  it('passes ISO dates straight through', () => {
    expect(readColumn(['2026-09-07', '2026-02-01'])).toEqual(['2026-09-07', '2026-02-01']);
  });

  it('refuses a two-digit year rather than inventing a century', () => {
    expect(readColumn(['07/09/26', '08/09/26'])).toEqual(['07/09/26', '08/09/26']);
  });

  it('leaves a timestamp as text', () => {
    expect(readColumn(['2026-09-07 14:30:00'])).toEqual(['2026-09-07 14:30:00']);
  });
});

describe('booleans', () => {
  it('reads true and false in any casing', () => {
    expect(readColumn(['TRUE', 'false', 'True'])).toEqual([true, false, true]);
  });

  it('keeps ones and zeros numeric', () => {
    // `1`/`0` is ambiguous where `true`/`false` is not, and a number is the
    // safer of the two readings.
    expect(readColumn(['1', '0', '1'])).toEqual([1, 0, 1]);
  });
});

describe('the header row', () => {
  it('is never evidence about a column type', () => {
    const { sheet } = readCsv(utf8('Bedrag\n1.234,56\n900,00'), { delimiter: ';' });
    expect(sheet.rows[0][0]).toBe('Bedrag');
    expect(sheet.rows.slice(1).map((r) => r[0])).toEqual([1234.56, 900]);
  });

  it('is typed with the rest when the file has no header', () => {
    const { sheet } = readCsv(utf8('1.234,56\n900,00'), { headerRow: false, delimiter: ';' });
    expect(sheet.rows.map((r) => r[0])).toEqual([1234.56, 900]);
  });
});

describe('end to end, through the shared tabular rules', () => {
  it('lands a European export as typed warehouse columns', () => {
    const csv = 'Klant;Bedrag;Datum;Actief\nAcme;1.234,56;07/09/2026;TRUE\nGlobex;900,00;08/09/2026;FALSE';
    const { sheet, delimiter, encoding } = readCsv(utf8(csv), { name: 'Verkoop' });
    expect(delimiter).toBe(';');
    expect(encoding).toBe('utf-8');

    const table = sheetToTable(sheet);
    expect(table.columns).toEqual([
      { name: 'Klant', sourceHeader: 'Klant', sqlType: 'VARCHAR' },
      { name: 'Bedrag', sourceHeader: 'Bedrag', sqlType: 'DOUBLE' },
      { name: 'Datum', sourceHeader: 'Datum', sqlType: 'DATE' },
      { name: 'Actief', sourceHeader: 'Actief', sqlType: 'BOOLEAN' },
    ]);
    expect(table.rows).toEqual([
      { Klant: 'Acme', Bedrag: 1234.56, Datum: '2026-09-07', Actief: true },
      { Klant: 'Globex', Bedrag: 900, Datum: '2026-09-08', Actief: false },
    ]);
  });

  it('pads a short row so the columns after it do not shift', () => {
    const { sheet } = readCsv(utf8('a,b,c\n1,2\n3,4,5'));
    expect(sheet.rows[1]).toEqual([1, 2, null]);
  });

  it('keeps a heading the user wrote, however they wrote it', () => {
    // Two headings that reduce to the same identifier must stay two columns —
    // merging them would drop a column of the customer's data in silence.
    const { sheet } = readCsv(utf8('Bedrag (EUR),Bedrag [EUR]\n1,2'));
    const table = sheetToTable(sheet);
    expect(table.columns.map((c) => c.name)).toEqual(['Bedrag_EUR', 'Bedrag_EUR_2']);
    expect(table.columns.map((c) => c.sourceHeader)).toEqual(['Bedrag (EUR)', 'Bedrag [EUR]']);
  });

  it('refuses a file with nothing in it', () => {
    expect(() => readCsv(utf8('   \n  '))).toThrow(SpreadsheetReadError);
  });
});
