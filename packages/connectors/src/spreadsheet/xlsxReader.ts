/**
 * Dependency-free .xlsx reader for spreadsheet-backed source connectors.
 *
 * PORTED from `frontend/lib/xlsxRead.ts`, which does the same job for the
 * in-product grid importer. The two are deliberate duplicates: this package
 * is consumed by the isolated sync worker and the frontend cannot import it
 * (the package entry point pulls in DuckDB), the same reason
 * `writeRowsParquet` was ported into the backend rather than shared. Keep
 * them in step — a fix to the zip/spreadsheetML handling in one belongs in
 * the other.
 *
 * Why hand-rolled rather than the npm `xlsx` package: that package carries
 * unfixed high-severity advisories and would trip the audit gate. An .xlsx is
 * a zip of small XML files with a rigid shape, so a scoped reader is ~300
 * lines. Same house decision that produced `xlsxBuilder.ts` (the writer).
 *
 * Deliberately NOT handled: formulas (only their cached values are read),
 * merged-cell spans, styling, charts. Dates ARE handled: a numeric cell whose
 * style resolves to a date format becomes `YYYY-MM-DD` (1900 and 1904 systems).
 *
 * ONE BEHAVIOURAL DIFFERENCE FROM THE GRID READER, AND IT IS THE IMPORTANT
 * ONE. The grid importer truncates at its cap, which is right for a
 * hand-maintained mapping table. A SOURCE must never do that: silently
 * ingesting the first N rows of a spreadsheet produces a warehouse table that
 * looks complete and answers questions with wrong numbers. So this reader
 * REPORTS the cap hit (`truncated`) and the connector turns that into a
 * failed entity with an explicit message. Losing the table is recoverable;
 * quietly losing rows is not.
 *
 * Runs in Node >=18 (DecompressionStream / Blob / Response are globals there);
 * no DOM APIs, which is what makes it unit-testable in CI.
 */

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  /** Dense row-major values; trailing empty rows/columns trimmed. */
  rows: XlsxCellValue[][];
  /**
   * True when the sheet has more rows than `maxRows` allowed. The rows array
   * holds only what fitted — callers MUST treat this as an error rather than
   * ingest a partial table. See the header note.
   */
  truncated: boolean;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

export interface ReadXlsxOptions {
  /**
   * Row ceiling per sheet. Bounded because the reader materialises the sheet
   * before the connector streams it, and the sync worker runs in a 1 GiB
   * container. 250k rows of a typical finance export is roughly 150 MB of JS
   * values — past that a spreadsheet is the wrong transport and the user
   * wants a database connector.
   */
  maxRows?: number;
  /** Column ceiling per sheet. Excel's own practical limit for tabular data. */
  maxCols?: number;
}

export const XLSX_DEFAULT_MAX_ROWS = 250_000;
export const XLSX_DEFAULT_MAX_COLS = 256;

// ─── Zip container ──────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

function u16(view: DataView, off: number): number { return view.getUint16(off, true); }
function u32(view: DataView, off: number): number { return view.getUint32(off, true); }

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 65_557);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (u32(view, i) === 0x06054b50) return i;
  }
  throw new SpreadsheetReadError('Not an Excel file (.xlsx) — no zip directory found.');
}

function readCentralDirectory(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  const count = u16(view, eocd + 10);
  let off = u32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  const nameDecoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (u32(view, off) !== 0x02014b50) break;
    const method = u16(view, off + 10);
    const compSize = u32(view, off + 20);
    const nameLen = u16(view, off + 28);
    const extraLen = u16(view, off + 30);
    const commentLen = u16(view, off + 32);
    const localOffset = u32(view, off + 42);
    const name = nameDecoder.decode(new Uint8Array(buf, off + 46, nameLen));
    entries.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const view = new DataView(buf);
  const lo = entry.localOffset;
  if (u32(view, lo) !== 0x04034b50) throw new SpreadsheetReadError('Corrupt Excel file (bad zip entry).');
  const nameLen = u16(view, lo + 26);
  const extraLen = u16(view, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  // Sizes from the CENTRAL directory — the local header may carry zeros when
  // the writer used a data descriptor (Excel itself does).
  const slice = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return new TextDecoder('utf-8').decode(slice);
  if (entry.method !== 8) throw new SpreadsheetReadError('Unsupported Excel file compression.');
  const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

// ─── Minimal XML helpers (spreadsheetML's constrained shapes only) ──────────

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]] = decodeXml(m[2]);
  return out;
}

/** Concatenate every `<t>` run inside a fragment (shared/inline strings). */
function textRuns(fragment: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out += m[1] !== undefined ? decodeXml(m[1]) : '';
  return out;
}

// ─── Date formats ───────────────────────────────────────────────────────────

const BUILTIN_DATE_FMT = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormatCode(code: string): boolean {
  // Strip quoted literals and [..] modifiers, then look for date/time tokens.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(bare);
}

function excelSerialToIso(serial: number, date1904: boolean): string {
  const days = Math.floor(serial);
  // 1899-12-30 absorbs Excel's phantom 1900-02-29; 1904 system has no bug.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * 86_400_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// ─── Sheet parsing ──────────────────────────────────────────────────────────

function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSheet(
  xml: string,
  shared: string[],
  dateStyle: boolean[],
  date1904: boolean,
  maxRows: number,
  maxCols: number,
): { rows: XlsxCellValue[][]; truncated: boolean } {
  const rows: XlsxCellValue[][] = [];
  const rowRe = /<row(\s[^>]*)?>([\s\S]*?)<\/row>|<row(\s[^>]*)?\/>/g;
  const cellRe = /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g;
  let rowM: RegExpExecArray | null;
  let rowIdx = -1;
  let truncated = false;
  while ((rowM = rowRe.exec(xml)) !== null) {
    const rowTagAttrs = attrs(`<row ${rowM[1] ?? rowM[3] ?? ''}>`);
    const declared = Number(rowTagAttrs.r);
    rowIdx = Number.isFinite(declared) && declared >= 1 ? declared - 1 : rowIdx + 1;
    if (rowIdx >= maxRows) { truncated = true; break; }
    const body = rowM[2] ?? '';
    if (body === '') continue;
    const row: XlsxCellValue[] = rows[rowIdx] ?? [];
    let cellM: RegExpExecArray | null;
    let cellIdx = -1;
    while ((cellM = cellRe.exec(body)) !== null) {
      const a = attrs(`<c ${cellM[1] ?? cellM[2] ?? ''}>`);
      cellIdx = a.r ? colIndex(a.r) : cellIdx + 1;
      if (cellIdx < 0 || cellIdx >= maxCols) continue;
      const inner = cellM[3] ?? '';
      if (inner === '') continue;
      const t = a.t ?? 'n';
      let value: XlsxCellValue = null;
      if (t === 'inlineStr') {
        value = textRuns(inner);
      } else {
        const vM = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        if (!vM) continue;
        const raw = decodeXml(vM[1]);
        if (t === 's') {
          value = shared[Number(raw)] ?? '';
        } else if (t === 'str') {
          value = raw;
        } else if (t === 'b') {
          value = raw === '1';
        } else if (t === 'e') {
          value = null;
        } else if (t === 'd') {
          value = raw.slice(0, 10);
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n)) continue;
          const styleIdx = Number(a.s ?? -1);
          value = dateStyle[styleIdx] && n >= 1 ? excelSerialToIso(n, date1904) : n;
        }
      }
      if (typeof value === 'string' && value === '') value = null;
      row[cellIdx] = value;
    }
    rows[rowIdx] = row;
  }

  // Densify, then trim trailing empty rows and columns.
  let maxCol = 0;
  for (const r of rows) if (r) maxCol = Math.max(maxCol, r.length);
  const dense: XlsxCellValue[][] = [];
  for (let i = 0; i < rows.length; i++) {
    const src = rows[i] ?? [];
    const r: XlsxCellValue[] = new Array(maxCol).fill(null);
    for (let c = 0; c < maxCol; c++) r[c] = src[c] ?? null;
    dense.push(r);
  }
  while (dense.length > 0 && dense[dense.length - 1].every((v) => v === null)) dense.pop();
  let usedCols = 0;
  for (const r of dense) {
    for (let c = r.length - 1; c >= 0; c--) {
      if (r[c] !== null) { usedCols = Math.max(usedCols, c + 1); break; }
    }
  }
  return { rows: dense.map((r) => r.slice(0, usedCols)), truncated };
}

// ─── Workbook assembly ──────────────────────────────────────────────────────

/**
 * Parse an .xlsx file's bytes into sheets of plain values.
 * Throws `SpreadsheetReadError` with a user-safe message on anything that
 * isn't a readable workbook — never a raw stack trace or a file path.
 */
export async function readXlsx(buf: ArrayBuffer, opts: ReadXlsxOptions = {}): Promise<XlsxWorkbook> {
  const maxRows = opts.maxRows ?? XLSX_DEFAULT_MAX_ROWS;
  const maxCols = opts.maxCols ?? XLSX_DEFAULT_MAX_COLS;

  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const get = async (name: string): Promise<string | null> => {
    const e = byName.get(name);
    return e ? await inflateEntry(buf, e) : null;
  };

  const workbookXml = await get('xl/workbook.xml');
  if (!workbookXml) throw new SpreadsheetReadError('Not an Excel workbook (.xlsx).');
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(workbookXml);

  // Shared strings.
  const shared: string[] = [];
  const sharedXml = await get('xl/sharedStrings.xml');
  if (sharedXml) {
    const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(sharedXml)) !== null) shared.push(textRuns(m[1]));
  }

  // Styles → per-cellXf "is a date format" flags.
  const dateStyle: boolean[] = [];
  const stylesXml = await get('xl/styles.xml');
  if (stylesXml) {
    const customDateFmt = new Set<number>();
    const numFmtRe = /<numFmt\s([^>]*?)\/>/g;
    let nm: RegExpExecArray | null;
    while ((nm = numFmtRe.exec(stylesXml)) !== null) {
      const a = attrs(`<numFmt ${nm[1]}>`);
      const id = Number(a.numFmtId);
      if (Number.isFinite(id) && isDateFormatCode(a.formatCode ?? '')) customDateFmt.add(id);
    }
    const cellXfsM = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (cellXfsM) {
      const xfRe = /<xf\s([^>]*?)(?:\/>|>)/g;
      let xm: RegExpExecArray | null;
      while ((xm = xfRe.exec(cellXfsM[1])) !== null) {
        const a = attrs(`<xf ${xm[1]}>`);
        const id = Number(a.numFmtId ?? 0);
        dateStyle.push(BUILTIN_DATE_FMT.has(id) || customDateFmt.has(id));
      }
    }
  }

  // Sheet name → target file, via the workbook relationships.
  const rels = new Map<string, string>();
  const relsXml = await get('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    const relRe = /<Relationship\s([^>]*?)\/>/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(relsXml)) !== null) {
      const a = attrs(`<Relationship ${rm[1]}>`);
      if (a.Id && a.Target) rels.set(a.Id, a.Target.replace(/^\//, '').replace(/^xl\//, ''));
    }
  }

  const sheets: XlsxSheet[] = [];
  const sheetRe = /<sheet\s([^>]*?)\/>/g;
  let sm: RegExpExecArray | null;
  let fallbackIdx = 0;
  while ((sm = sheetRe.exec(workbookXml)) !== null) {
    const a = attrs(`<sheet ${sm[1]}>`);
    fallbackIdx += 1;
    const target = rels.get(a['r:id'] ?? '') ?? `worksheets/sheet${fallbackIdx}.xml`;
    const sheetXml = await get(`xl/${target}`);
    if (!sheetXml) continue;
    const parsed = parseSheet(sheetXml, shared, dateStyle, date1904, maxRows, maxCols);
    sheets.push({
      name: a.name ?? `Sheet ${fallbackIdx}`,
      rows: parsed.rows,
      truncated: parsed.truncated,
    });
  }
  if (sheets.length === 0) throw new SpreadsheetReadError('No sheets found in this Excel file.');
  return { sheets };
}

/**
 * Reading failed for a reason the user can act on (wrong file type, corrupt
 * zip, unsupported compression). Carries no paths or stack detail — the
 * message is shown verbatim in the wizard and in sync warnings.
 */
export class SpreadsheetReadError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SpreadsheetReadError';
  }
}
