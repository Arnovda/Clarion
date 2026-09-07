/**
 * CSV / delimited text → the same parsed-sheet shape the Excel path produces.
 *
 * The point of returning an `XlsxSheet` is that everything downstream —
 * column naming, dedupe, type inference, row records, the truncation refusal —
 * is the rule that already exists in `tabular.ts`, applied unchanged. A CSV
 * connector that reimplemented any of that would drift from the Excel one, and
 * the same file would land differently depending on which door it came
 * through. So this module does exactly one job the xlsx reader gets for free
 * from its file format: **decide what each cell MEANS.**
 *
 * A worksheet cell carries its type. A CSV cell is text, always, and the
 * conversion back is where every classic CSV bug lives:
 *
 * **The delimiter is not always a comma.** Excel on a Belgian or French
 * Windows writes `;`, because `,` is the decimal separator there. Sniffing it
 * is not optional — a semicolon file read as comma-separated is one very wide
 * column, and nothing downstream can tell.
 *
 * **The bytes are not always UTF-8.** Excel's plain "CSV (comma delimited)"
 * export writes the Windows ANSI code page. Decoded as UTF-8 that is either
 * mojibake or a hard failure, and either way `Café` stops being `Café`.
 *
 * **`1.234` is two different numbers.** In an English file it is one and a
 * bit; in a Belgian one it is one thousand two hundred and thirty-four. No
 * single VALUE settles it, so the decision is made per COLUMN from whatever
 * unambiguous evidence the column contains, and a column whose values
 * disagree is left as text rather than half-converted.
 *
 * **Some digits are not numbers.** `0123` is an article code, `04/09` is not
 * a fraction, and a 16-digit account number does not survive a JS double.
 * Converting those is worse than leaving them alone, because the damage is
 * silent: a leading zero simply disappears.
 *
 * Two standing rules carried over from the xlsx reader:
 *   • Types are committed to only when EVERY non-empty value in the column
 *     agrees. One `n/a` makes the column text, which is right — the
 *     alternative is a silent null where the customer typed something.
 *   • The row cap is REPORTED, never obeyed. `truncated` is a refusal signal
 *     for `assertSheetComplete`, because a partial table looks complete.
 *
 * Runs in Node >=18 with no dependencies and no ICU requirement: the only
 * TextDecoder encodings used are the three every build guarantees, and
 * windows-1252 is a 32-entry table below.
 */

import {
  SpreadsheetReadError,
  XLSX_DEFAULT_MAX_COLS,
  XLSX_DEFAULT_MAX_ROWS,
  type XlsxCellValue,
  type XlsxSheet,
} from './xlsxReader';

/** Delimiters worth sniffing. Order is the tie-break order. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface ReadCsvOptions {
  /** Sheet name to report. The connector derives it from the file name. */
  name?: string;
  /** Force a delimiter instead of sniffing it. */
  delimiter?: string;
  /** Force an encoding instead of detecting it. */
  encoding?: CsvEncoding;
  /** False when the file starts straight into data. Affects type evidence. */
  headerRow?: boolean;
  maxRows?: number;
  maxCols?: number;
}

export interface CsvReadResult {
  sheet: XlsxSheet;
  /** What the reader used, so the wizard can show it and the user can correct it. */
  delimiter: string;
  encoding: CsvEncoding;
}

// ─── Decoding ───────────────────────────────────────────────────────────────

/**
 * Windows-1252 differs from Latin-1 only in 0x80–0x9F, where it puts the
 * punctuation Excel actually emits — the euro sign, curly quotes, the en
 * dash. Every other byte is its own code point. Spelled out here rather than
 * asked of `TextDecoder` because the WHATWG label set beyond UTF-8/16 depends
 * on how Node was built with ICU, and a connector must not decode differently
 * on two machines.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function decodeCp1252(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out[i] = String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
  }
  return out.join('');
}

/**
 * Bytes → text, and say which reading was used.
 *
 * A byte-order mark settles it outright. Without one, UTF-8 is tried in
 * fatal mode: real UTF-8 is a strict enough shape that arbitrary Western
 * European bytes almost never satisfy it by accident, so a failure is strong
 * evidence of the Windows code page rather than a coin flip.
 */
export function decodeCsvBytes(buf: ArrayBuffer, forced?: CsvEncoding): { text: string; encoding: CsvEncoding } {
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) throw new SpreadsheetReadError('This file is empty.');

  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const hasUtf16Le = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const hasUtf16Be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;

  const encoding: CsvEncoding = forced
    ?? (hasUtf16Le ? 'utf-16le' : hasUtf16Be ? 'utf-16be' : 'utf-8');

  if (encoding === 'windows-1252') {
    return { text: decodeCp1252(bytes), encoding };
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const body = hasUtf16Le || hasUtf16Be ? bytes.subarray(2) : bytes;
    return { text: new TextDecoder(encoding).decode(body), encoding };
  }

  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' };
  } catch {
    if (forced === 'utf-8') {
      throw new SpreadsheetReadError(
        'This file is not valid UTF-8 text. Re-save it as "CSV UTF-8" from Excel, or let Clarion detect the encoding.',
      );
    }
    return { text: decodeCp1252(body), encoding: 'windows-1252' };
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────────

interface ParsedGrid {
  rows: string[][];
  truncated: boolean;
}

/**
 * RFC 4180 with the leniencies real files need.
 *
 * Quoted fields may contain the delimiter, newlines and `""` for a literal
 * quote. A stray quote in the middle of an unquoted field is kept as a
 * character rather than treated as an error — refusing the file over one
 * apostrophe would be worse than reading it. Line endings may be CRLF, LF or
 * bare CR, mixed, because exports from three operating systems end up in the
 * same folder.
 */
export function parseDelimited(
  text: string,
  delim: string,
  maxRows = XLSX_DEFAULT_MAX_ROWS,
  maxCols = XLSX_DEFAULT_MAX_COLS,
): ParsedGrid {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let truncated = false;
  let stopped = false;
  let i = 0;

  const endField = () => {
    // Only an unquoted field is trimmed: a quoted one meant its spaces.
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = (): boolean => {
    endField();
    if (row.length > maxCols) {
      row = row.slice(0, maxCols);
      truncated = true;
    }
    rows.push(row);
    row = [];
    return rows.length < maxRows;
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"' && field.trim() === '') {
      // A quote opens a field only at its start; leading spaces before it are
      // padding some exporters add, not content.
      field = ''; fieldWasQuoted = true; inQuotes = true; i += 1; continue;
    }
    if (ch === delim) { endField(); i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      const consumed = ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      i += consumed;
      if (!endRow()) { truncated = i < text.length; stopped = true; break; }
      continue;
    }
    field += ch; i += 1;
  }

  // A file that ends with a newline must not produce a phantom empty record;
  // one that ends mid-row must not lose it.
  if (!stopped && (inQuotes || field !== '' || row.length > 0)) endRow();

  return { rows, truncated };
}

/**
 * Pick the delimiter by parsing a prefix with each candidate and asking which
 * one produces a consistent table.
 *
 * Counting raw characters would be fooled by a comma inside a quoted address,
 * so the real parser does the counting. The prefix may end mid-record, so the
 * last row of each trial is discarded.
 */
const SNIFF_ROWS = 40;

export function sniffDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, 64 * 1024);
  const clipped = sample.length < text.length;
  let best: { delim: CsvDelimiter; agreement: number; width: number } | null = null;

  for (const delim of CSV_DELIMITERS) {
    const { rows } = parseDelimited(sample, delim, SNIFF_ROWS, XLSX_DEFAULT_MAX_COLS);
    // Only drop the last row when it might be a fragment — either the sample
    // was cut off mid-record, or the row cap stopped us early. Dropping it
    // unconditionally would judge a two-line file on its header alone.
    const maybeFragment = clipped || rows.length >= SNIFF_ROWS;
    const usable = (maybeFragment && rows.length > 1 ? rows.slice(0, -1) : rows)
      .filter((r) => r.some((c) => c !== ''));
    if (usable.length === 0) continue;

    const counts = new Map<number, number>();
    for (const r of usable) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let width = 0;
    let agreement = 0;
    for (const [w, n] of counts) {
      if (n > agreement || (n === agreement && w > width)) { width = w; agreement = n; }
    }
    if (width < 2) continue;

    // Agreement first — a delimiter that splits every row into the same number
    // of fields is the one the file was written with. Width breaks ties, since
    // a file separated by `;` also "works" as one 1-column comma file.
    if (!best || agreement > best.agreement || (agreement === best.agreement && width > best.width)) {
      best = { delim, agreement, width };
    }
  }

  // A genuinely single-column file has no delimiter to find; comma is the
  // harmless answer, since nothing will split on it.
  return best?.delim ?? ',';
}

// ─── Typing a column ────────────────────────────────────────────────────────

const BOOL_TRUE = new Set(['true']);
const BOOL_FALSE = new Set(['false']);

/** Spaces used as digit grouping, including the ones Excel actually emits. */
const GROUP_SPACES = /[\u0020\u00a0\u202f\u2009]/g;
const CURRENCY = /^[€$£¥]\s*|\s*[€$£¥]$/g;

interface NumericBody {
  /** Digits and separators only. */
  body: string;
  negative: boolean;
}

/**
 * Strip everything that decorates a number without changing it: currency
 * symbols, sign, grouping spaces, and the accounting convention of wrapping a
 * negative in parentheses. A trailing `%` is deliberately NOT handled — `50%`
 * and `50` are different quantities and guessing which the user meant is how
 * a column silently becomes a hundred times wrong.
 */
function numericBody(raw: string): NumericBody | null {
  let s = raw.trim();
  if (s === '') return null;

  let negative = false;
  if (s.length > 2 && s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(CURRENCY, '').trim();
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) { s = s.slice(1).trim(); }

  s = s.replace(GROUP_SPACES, '');
  if (s === '' || !/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;
  return { body: s, negative };
}

/** True when `parts` are valid thousands groups: 1–3 digits, then all 3. */
function validGrouping(parts: string[]): boolean {
  if (parts.length < 2) return false;
  if (parts[0].length < 1 || parts[0].length > 3) return false;
  return parts.slice(1).every((p) => p.length === 3);
}

type DecimalSep = '.' | ',';

interface NumericReading {
  /**
   * Which char this value PROVES is the decimal separator. `null` covers both
   * "no separators at all" and "one lone three-digit group", which the column
   * resolves the same way: every separator present is grouping.
   */
  proves: DecimalSep | null;
  integerDigits: string;
  totalDigits: number;
}

/**
 * What one value tells us about the column's number format.
 *
 * Returns null when the value is not a number at all under any reading —
 * which immediately makes the whole column text.
 */
function readNumeric(body: string): NumericReading | null {
  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;
  const totalDigits = (body.match(/[0-9]/g) ?? []).length;

  const finish = (proves: DecimalSep | null, intPart: string): NumericReading =>
    ({ proves, integerDigits: intPart.replace(/[^0-9]/g, ''), totalDigits });

  if (dots > 0 && commas > 0) {
    // Both present: the one that appears LAST is the decimal separator, and
    // the other must be grouping the integer part properly.
    const decimal: DecimalSep = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    if ((decimal === '.' ? dots : commas) !== 1) return null;
    const [intPart, frac] = splitLast(body, decimal);
    if (frac === '' || /[.,]/.test(frac)) return null;
    if (!validGrouping(intPart.split(group))) return null;
    return finish(decimal, intPart);
  }

  if (dots === 0 && commas === 0) return finish(null, body);

  const sep: DecimalSep = dots > 0 ? '.' : ',';
  const count = dots > 0 ? dots : commas;
  const parts = body.split(sep);

  if (count > 1) {
    // Repeated, so it can only be grouping — which proves the OTHER char is
    // the decimal separator for this column.
    if (!validGrouping(parts)) return null;
    return finish(sep === '.' ? ',' : '.', body);
  }

  const [intPart, tail] = [parts[0], parts[1]];
  if (tail === '') return null;
  if (tail.length !== 3) return finish(sep, intPart);
  // Exactly three trailing digits: `1.234` is unresolvable on its own — unless
  // the integer part is 0 or starts with one, which nobody writes for a
  // thousands group.
  if (intPart === '' || intPart === '0' || /^0\d/.test(intPart)) return finish(sep, intPart);
  return finish(null, intPart);
}

function splitLast(s: string, ch: string): [string, string] {
  const at = s.lastIndexOf(ch);
  return [s.slice(0, at), s.slice(at + 1)];
}

/**
 * Convert a whole column of text to numbers, or refuse the column.
 *
 * Refusal is the common, correct outcome: one non-numeric value, disagreeing
 * separator conventions, a leading zero, or more digits than a double can
 * hold all mean the column stays exactly as the user wrote it.
 */
function asNumberColumn(values: readonly string[]): number[] | null {
  const readings: { reading: NumericReading; negative: boolean; body: string }[] = [];
  const proven = new Set<DecimalSep>();

  for (const raw of values) {
    const cleaned = numericBody(raw);
    if (!cleaned) return null;
    const reading = readNumeric(cleaned.body);
    if (!reading) return null;

    // A leading zero is an identifier, not a quantity. Converting drops it,
    // and nothing downstream can tell it was ever there.
    if (reading.integerDigits.length > 1 && reading.integerDigits.startsWith('0')) return null;
    // Past 15 digits a JS double starts rounding, so the value we store would
    // differ from the one in the file.
    if (reading.totalDigits > 15) return null;

    if (reading.proves) proven.add(reading.proves);
    readings.push({ reading, negative: cleaned.negative, body: cleaned.body });
  }

  if (readings.length === 0) return null;
  // The column contradicts itself — half English, half European. Neither
  // reading is safe, and picking one silently would be wrong for the rest.
  if (proven.size > 1) return null;

  // With nothing proved, every separator present is grouping: either the
  // column is plain integers, or its only separators are lone three-digit
  // groups, where thousands is the overwhelmingly likelier reading. `null`
  // means exactly that — no decimal separator in this column.
  const decimal: DecimalSep | null = proven.size === 1 ? [...proven][0] : null;

  const out: number[] = [];
  for (const { negative, body } of readings) {
    let normalised: string;
    if (decimal) {
      const group = decimal === '.' ? ',' : '.';
      const stripped = body.split(group).join('');
      normalised = decimal === ',' ? stripped.replace(',', '.') : stripped;
    } else {
      // Every separator here is grouping (proved, or the ambiguous three-digit
      // case resolved that way).
      normalised = body.replace(/[.,]/g, '');
    }
    if (!/^\d*\.?\d*$/.test(normalised) || normalised === '' || normalised === '.') return null;
    const n = Number(normalised);
    if (!Number.isFinite(n)) return null;
    out.push(negative ? -n : n);
  }
  return out;
}

const DATE_PARTS = /^(\d{1,4})([\/\-.])(\d{1,2})\2(\d{1,4})$/;

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 9999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Convert a whole column of text to ISO dates, or refuse it.
 *
 * `07/09/2026` is the 7th of September here and the 9th of July in an
 * American export, and only the column can tell you which: a single value
 * with a first part above 12 settles it for every other value. With no such
 * value the default is day-first, matching the locale this product is built
 * for and the flexible date parser the in-product grid importer already uses.
 *
 * Two-digit years are deliberately not accepted. Excel's own short date in
 * the locales that matter here writes four, and inventing a century for
 * `12/11/10` is a guess with no evidence behind it.
 */
function asDateColumn(values: readonly string[]): string[] | null {
  interface Parsed { a: number; b: number; y: number; isoOrder: boolean; }
  const parsed: Parsed[] = [];
  let sawIsoOrder = false;
  let sawFieldOrder = false;
  let dayFirst: boolean | null = null;

  for (const raw of values) {
    const m = DATE_PARTS.exec(raw.trim());
    if (!m) return null;
    const first = Number(m[1]);
    const mid = Number(m[3]);
    const last = Number(m[4]);

    if (m[1].length === 4) {
      sawIsoOrder = true;
      if (!isRealDate(first, mid, last)) return null;
      parsed.push({ a: mid, b: last, y: first, isoOrder: true });
      continue;
    }
    if (m[4].length !== 4) return null;
    sawFieldOrder = true;
    if (first > 12 && mid > 12) return null;
    if (first > 12) {
      if (dayFirst === false) return null;
      dayFirst = true;
    } else if (mid > 12) {
      if (dayFirst === true) return null;
      dayFirst = false;
    }
    parsed.push({ a: first, b: mid, y: last, isoOrder: false });
  }

  // One column, one shape. A mix of `2026-09-07` and `07/09/2026` is a file
  // problem the user should see, not something to paper over.
  if (parsed.length === 0 || (sawIsoOrder && sawFieldOrder)) return null;

  const useDayFirst = dayFirst ?? true;
  const out: string[] = [];
  for (const p of parsed) {
    if (p.isoOrder) { out.push(iso(p.y, p.a, p.b)); continue; }
    const d = useDayFirst ? p.a : p.b;
    const mo = useDayFirst ? p.b : p.a;
    if (!isRealDate(p.y, mo, d)) return null;
    out.push(iso(p.y, mo, d));
  }
  return out;
}

function asBooleanColumn(values: readonly string[]): boolean[] | null {
  const out: boolean[] = [];
  for (const raw of values) {
    const t = raw.trim().toLowerCase();
    if (BOOL_TRUE.has(t)) out.push(true);
    else if (BOOL_FALSE.has(t)) out.push(false);
    else return null;
  }
  return out;
}

/**
 * Decide one column's meaning and rewrite it in place.
 *
 * Order matters: numbers are tried before dates so a column of plain integers
 * stays numeric, and booleans first because `true`/`false` is unambiguous
 * where `1`/`0` is not — the latter stays a number, which is the safer of the
 * two readings.
 */
function convertColumn(cells: XlsxCellValue[][], col: number, firstDataRow: number): void {
  const idx: number[] = [];
  const raw: string[] = [];
  for (let r = firstDataRow; r < cells.length; r++) {
    const v = cells[r][col];
    if (typeof v !== 'string' || v === '') continue;
    idx.push(r);
    raw.push(v);
  }
  if (raw.length === 0) return;

  const converted: XlsxCellValue[] | null =
    asBooleanColumn(raw) ?? asNumberColumn(raw) ?? asDateColumn(raw);
  if (!converted) return;

  for (let k = 0; k < idx.length; k++) cells[idx[k]][col] = converted[k];
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Read delimited text into the shared sheet shape.
 *
 * Everything after this returns is the Excel path's rules, unchanged.
 */
export function readCsv(buf: ArrayBuffer, opts: ReadCsvOptions = {}): CsvReadResult {
  const maxRows = opts.maxRows ?? XLSX_DEFAULT_MAX_ROWS;
  const maxCols = opts.maxCols ?? XLSX_DEFAULT_MAX_COLS;
  const headerRow = opts.headerRow ?? true;

  const { text, encoding } = decodeCsvBytes(buf, opts.encoding);
  if (text.trim() === '') throw new SpreadsheetReadError('This file has no rows.');
  // A NUL is the clearest possible sign this is not delimited text. The
  // likeliest cause by far is UTF-16 saved without a byte-order mark, where
  // every second byte is zero — worth naming, because the fix is a re-save
  // rather than anything the user can do in Clarion.
  if (text.includes('\u0000')) {
    throw new SpreadsheetReadError(
      'This file is not plain text — it contains binary data. If it was saved as UTF-16, '
      + 're-save it from Excel as "CSV UTF-8".',
    );
  }

  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  if (delimiter.length !== 1) {
    throw new SpreadsheetReadError('The column separator must be a single character.');
  }

  const { rows: grid, truncated } = parseDelimited(text, delimiter, maxRows, maxCols);
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (width === 0) throw new SpreadsheetReadError('No columns could be read from this file.');

  // Dense and rectangular, so a short row (a trailing field the exporter
  // omitted) does not shift the columns after it.
  const cells: XlsxCellValue[][] = grid.map((r) => {
    const out: XlsxCellValue[] = new Array(width).fill(null);
    for (let i = 0; i < r.length; i++) out[i] = r[i] === '' ? null : r[i];
    return out;
  });

  // The header row names the columns; it is never evidence about their type.
  const firstDataRow = headerRow && cells.length > 0 ? 1 : 0;
  for (let c = 0; c < width; c++) convertColumn(cells, c, firstDataRow);

  return {
    sheet: { name: opts.name ?? 'Sheet1', rows: cells, truncated },
    delimiter,
    encoding,
  };
}
