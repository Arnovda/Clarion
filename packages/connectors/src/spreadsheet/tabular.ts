/**
 * Worksheet → warehouse table.
 *
 * A spreadsheet is not a database, so the gap between the two has to be
 * closed explicitly and the same way every time. This module is that rule,
 * shared by every spreadsheet-backed connector (Excel upload, SharePoint) so
 * the SAME file lands identically whichever door it came through.
 *
 * Three jobs:
 *   1. Turn a header row into warehouse-safe column identifiers.
 *   2. Infer a SQL type per column CONSERVATIVELY.
 *   3. Turn value rows into records the warehouse writer accepts.
 *
 * Two decisions worth knowing before changing anything here:
 *
 * **Sanitising names may never silently merge two columns.** `Bedrag (EUR)`
 * and `Bedrag %` both reduce to `Bedrag`. Merging them would drop a column of
 * the customer's data without a word — so collisions get a numeric suffix and
 * the original header is kept on the column for the docs channel, where the
 * user sees their own wording again.
 *
 * **A type is only committed to when EVERY non-empty value fits it.** One
 * `n/a` in a column of numbers makes the whole column text, which is right:
 * the alternative is a silent null where the customer typed something. This
 * mirrors the conservative guesser the in-product grid importer already uses.
 */

import type { XlsxCellValue, XlsxSheet } from './xlsxReader';

/** Warehouse column derived from a spreadsheet header. */
export interface TabularColumn {
  /** Warehouse-safe identifier. Matches the writer's allow-list. */
  name: string;
  /** DuckDB type, from the writer's allow-list. */
  sqlType: string;
  /** The header text exactly as the user wrote it. Feeds the docs channel. */
  sourceHeader: string;
}

export interface SheetTable {
  columns: TabularColumn[];
  rows: Record<string, unknown>[];
}

export interface SheetTableOptions {
  /** When true (default) the first non-empty row names the columns. */
  headerRow?: boolean;
}

// The warehouse writer interpolates column names into SQL and validates them
// against exactly this shape; entity names have their own, wider shape.
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENT = 128;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Letters Unicode normalisation cannot fold, because they are not an ASCII
 * letter plus a combining mark — `ß` does not decompose at all. Without this
 * table they become `_` and `Größe` reads as `Gro_e` in the catalog, which
 * looks like a bug in Clarion rather than a transliteration.
 */
const TRANSLITERATE: ReadonlyArray<readonly [RegExp, string]> = [
  [/ß/g, 'ss'], [/æ/g, 'ae'], [/Æ/g, 'AE'], [/œ/g, 'oe'], [/Œ/g, 'OE'],
  [/ø/g, 'o'], [/Ø/g, 'O'], [/å/g, 'a'], [/Å/g, 'A'],
  [/đ/g, 'd'], [/Đ/g, 'D'], [/ł/g, 'l'], [/Ł/g, 'L'], [/ð/g, 'd'], [/þ/g, 'th'],
];

function transliterate(s: string): string {
  let out = s;
  for (const [re, to] of TRANSLITERATE) out = out.replace(re, to);
  return out;
}

/**
 * Reduce arbitrary text to a warehouse-safe identifier.
 *
 * Diacritics are folded rather than stripped (`Fabriqué` → `Fabrique`, not
 * `Fabriqu`) because dropping a letter changes the word, and these names are
 * what a business user will later read in the catalog.
 *
 * Returns null when nothing usable survives — the caller substitutes a
 * positional name rather than inventing one.
 */
export function sanitiseIdentifier(raw: string): string | null {
  const folded = transliterate(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (folded === '') return null;
  const prefixed = /^[0-9]/.test(folded) ? `c_${folded}` : folded;
  const capped = prefixed.slice(0, MAX_IDENT);
  return SAFE_COLUMN.test(capped) ? capped : null;
}

/**
 * Make every name in `names` unique, in order, by appending `_2`, `_3`, …
 * to later duplicates. Comparison is case-insensitive because the warehouse
 * treats `Total` and `total` as one column.
 */
export function dedupeIdentifiers(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const seen = used.get(key);
    if (seen === undefined) {
      used.set(key, 1);
      return n;
    }
    // Keep bumping until the suffixed form is itself unused — `A`, `A_2` and a
    // second `A_2` in the source must still produce three distinct names.
    let next = seen + 1;
    let candidate = `${n}_${next}`;
    while (used.has(candidate.toLowerCase())) {
      next += 1;
      candidate = `${n}_${next}`;
    }
    used.set(key, next);
    used.set(candidate.toLowerCase(), 1);
    return candidate;
  });
}

/** Header cells → column identifiers, with positional fallbacks and dedupe. */
export function deriveColumnNames(header: readonly XlsxCellValue[]): { name: string; sourceHeader: string }[] {
  const sourceHeaders = header.map((h) => (h === null || h === undefined ? '' : String(h).trim()));
  const raw = sourceHeaders.map((h, i) => sanitiseIdentifier(h) ?? `column_${i + 1}`);
  const unique = dedupeIdentifiers(raw);
  return unique.map((name, i) => ({ name, sourceHeader: sourceHeaders[i] || `Column ${i + 1}` }));
}

/**
 * Infer one column's SQL type from its values.
 *
 * Commits only on unanimity among non-empty values; anything mixed is
 * VARCHAR. An all-empty column is VARCHAR too — declaring a type from no
 * evidence is how a column ends up typed wrong for the next file.
 */
export function inferSqlType(values: readonly XlsxCellValue[]): string {
  let sawValue = false;
  let allBoolean = true;
  let allNumber = true;
  let allInteger = true;
  let allIsoDate = true;

  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    sawValue = true;
    if (typeof v !== 'boolean') allBoolean = false;
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) allInteger = false;
    } else {
      allNumber = false;
      allInteger = false;
    }
    if (!(typeof v === 'string' && ISO_DATE.test(v))) allIsoDate = false;
    if (!allBoolean && !allNumber && !allIsoDate) break;
  }

  if (!sawValue) return 'VARCHAR';
  if (allBoolean) return 'BOOLEAN';
  if (allNumber) return allInteger ? 'BIGINT' : 'DOUBLE';
  if (allIsoDate) return 'DATE';
  return 'VARCHAR';
}

/**
 * Coerce one cell to the JSON shape the writer's declared type expects.
 *
 * VARCHAR columns stringify numbers and booleans rather than letting mixed
 * JSON types reach DuckDB — the declared type would win anyway, and doing it
 * here keeps what lands in Parquet predictable from the TypeScript side.
 */
export function coerceCell(v: XlsxCellValue, sqlType: string): unknown {
  if (v === null || v === undefined || v === '') return null;
  if (sqlType === 'VARCHAR') return typeof v === 'string' ? v : String(v);
  return v;
}

/**
 * Turn one parsed worksheet into columns + records.
 *
 * Rows that are entirely empty are dropped — spreadsheets are full of spacer
 * rows and they are not data. A row that is short (Excel omits trailing empty
 * cells) is padded with nulls so every record has every key.
 */
export function sheetToTable(sheet: XlsxSheet, opts: SheetTableOptions = {}): SheetTable {
  const headerRow = opts.headerRow ?? true;
  const all = sheet.rows;
  if (all.length === 0) return { columns: [], rows: [] };

  const width = all.reduce((w, r) => Math.max(w, r.length), 0);
  if (width === 0) return { columns: [], rows: [] };

  let headerCells: XlsxCellValue[];
  let dataRows: XlsxCellValue[][];
  if (headerRow) {
    // The first row that carries anything is the header; leading spacer rows
    // above a table are common in hand-made workbooks.
    const firstUsed = all.findIndex((r) => r.some((c) => c !== null && c !== ''));
    if (firstUsed === -1) return { columns: [], rows: [] };
    headerCells = all[firstUsed];
    dataRows = all.slice(firstUsed + 1);
  } else {
    headerCells = new Array(width).fill(null);
    dataRows = all;
  }

  const padded = new Array(width).fill(null).map((_, i) => headerCells[i] ?? null);
  const named = deriveColumnNames(padded);

  const kept = dataRows.filter((r) => r.some((c) => c !== null && c !== ''));

  const columns: TabularColumn[] = named.map((n, i) => ({
    name: n.name,
    sourceHeader: n.sourceHeader,
    sqlType: inferSqlType(kept.map((r) => r[i] ?? null)),
  }));

  const rows = kept.map((r) => {
    const rec: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      rec[columns[i].name] = coerceCell(r[i] ?? null, columns[i].sqlType);
    }
    return rec;
  });

  return { columns, rows };
}

/**
 * Refuse a worksheet the reader could not read in full.
 *
 * The reader reports its row cap rather than obeying it, and this is the guard
 * that turns that report into a refusal. Both spreadsheet connectors call it
 * before writing anything, so the rule — and its wording — exists once.
 *
 * Why a refusal and not a truncated table: a partial table looks complete.
 * Nothing downstream can tell that rows are missing, so every dashboard and
 * every answer built on it is quietly wrong. Losing the table is recoverable
 * and visible; losing rows is neither.
 */
export function assertSheetComplete(sheet: XlsxSheet): void {
  if (!sheet.truncated) return;
  throw new SheetTooLargeError(
    'the worksheet has more rows than a spreadsheet source can carry. '
    + 'Nothing was written, so no partial data is in your warehouse. '
    + 'Split the sheet, or load this data from a database instead.',
  );
}

/** A worksheet exceeded the reader's row ceiling and was refused whole. */
export class SheetTooLargeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SheetTooLargeError';
  }
}

// ─── Entity naming ────────────────────────────────────────────────────────
// Entity names become warehouse TABLE names, whose allow-list is wider than
// the column one (hyphens are permitted). Kept separate from
// `sanitiseIdentifier` so the two allow-lists can never drift into each other.
const SAFE_TABLE = /^[A-Za-z0-9_-]+$/;

/**
 * Reduce a sheet or file name to a warehouse-safe entity name.
 * Returns null when nothing usable survives; callers substitute a positional
 * name so a sheet called `📊` still syncs instead of failing the workbook.
 */
export function sanitiseEntityName(raw: string): string | null {
  const folded = transliterate(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  if (folded === '') return null;
  const capped = folded.slice(0, MAX_IDENT);
  return SAFE_TABLE.test(capped) ? capped : null;
}
