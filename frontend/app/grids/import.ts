/**
 * Excel-import helpers for managed grids — pure functions between the xlsx
 * reader (`lib/xlsxRead`) and the grid editor/create flow.
 *
 * The server contract is untouched by imports: everything here produces the
 * same rows/columns payloads the editor already sends, so an imported file
 * passes through the exact validation and coercion a typed-in row does.
 */

import type { XlsxCellValue, XlsxSheet } from '@/lib/xlsxRead';
import type { GridColumn, GridColumnType } from './types';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Split a sheet into headers + data rows, honouring the header toggle. */
export function splitSheet(
  sheet: XlsxSheet,
  hasHeader: boolean,
): { headers: string[]; rows: XlsxCellValue[][] } {
  const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    const h = hasHeader ? sheet.rows[0]?.[c] : null;
    headers.push(h !== null && h !== undefined && String(h).trim() !== '' ? String(h).trim() : `Column ${c + 1}`);
  }
  return { headers, rows: hasHeader ? sheet.rows.slice(1) : sheet.rows };
}

/**
 * Guess a grid column type from a file column's values. Conservative: only
 * commits to number/date/boolean when ~every non-empty value agrees, else
 * text — a wrong "text" is editable, a wrong "number" rejects rows.
 */
export function guessColumnType(values: ReadonlyArray<XlsxCellValue>): GridColumnType {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  if (nonEmpty.length === 0) return 'text';
  const all = (pred: (v: XlsxCellValue) => boolean) => nonEmpty.every(pred);
  if (all((v) => typeof v === 'boolean')) return 'boolean';
  if (all((v) => typeof v === 'string' && ISO_DATE_RE.test(v))) return 'date';
  if (all((v) => typeof v === 'number')) return 'number';
  return 'text';
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Propose, per grid column, which file column feeds it (index into
 * `headers`, or null for no match). Exact normalized-name match first, then
 * containment — and a file column is never used twice.
 */
export function matchColumns(
  headers: ReadonlyArray<string>,
  gridColumns: ReadonlyArray<GridColumn>,
): Array<number | null> {
  const normHeaders = headers.map(normalizeName);
  const used = new Set<number>();
  const claim = (idx: number | null): number | null => {
    if (idx === null || used.has(idx)) return null;
    used.add(idx);
    return idx;
  };
  return gridColumns.map((col) => {
    const target = normalizeName(col.name);
    const targetKey = normalizeName(col.key);
    let idx = normHeaders.findIndex((h, i) => !used.has(i) && h !== '' && (h === target || h === targetKey));
    if (idx === -1) {
      idx = normHeaders.findIndex(
        (h, i) => !used.has(i) && h !== '' && target !== '' && (h.includes(target) || target.includes(h)),
      );
    }
    return claim(idx === -1 ? null : idx);
  });
}

/**
 * Convert one file cell into the value the grid's save payload expects for
 * the target column type. An unstyled Excel date arrives as a raw serial
 * number — when the target column is a date and the number sits in a
 * plausible serial range (1970–2100), convert it.
 */
export function convertCell(value: XlsxCellValue, type: GridColumnType): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    return ['true', 'yes', 'ja', 'oui', '1', 'x'].includes(s);
  }
  if (type === 'date' && typeof value === 'number' && value >= 25_569 && value <= 73_415) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  if (type === 'number' && typeof value === 'number') return value;
  return String(value);
}
