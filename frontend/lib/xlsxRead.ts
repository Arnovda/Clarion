/**
 * xlsxRead — a dependency-free .xlsx reader for grid imports.
 *
 * Why hand-rolled: the npm `xlsx` package carries unfixed high-severity
 * advisories (it would trip the audit gate), and the full generality of
 * SheetJS is not needed — grid import only wants VALUES: strings, numbers,
 * booleans, and dates. An .xlsx is a zip of small XML files with a rigid
 * shape, so a scoped reader is ~300 lines. It mirrors the house decision
 * that produced `xlsxBuilder.ts` (the hand-rolled writer) on the backend.
 *
 * Deliberately NOT handled: formulas (only their cached values are read),
 * merged-cell spans, styling, charts. Dates ARE handled: a numeric cell
 * whose style resolves to a date format is converted to `YYYY-MM-DD` at
 * read time (1900 and 1904 date systems both).
 *
 * Runs in the browser AND in Node ≥18 (DecompressionStream is used for
 * inflate; no DOM APIs), which is what makes it unit-testable in CI.
 */

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  /** Dense row-major values; trailing empty rows/columns trimmed. */
  rows: XlsxCellValue[][];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

/** Read caps — grid import is for budgets/mappings, not data dumps. */
export const XLSX_MAX_ROWS = 20_000;
export const XLSX_MAX_COLS = 64;

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
  throw new Error('Not an Excel file (.xlsx) — no zip directory found.');
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
  if (u32(view, lo) !== 0x04034b50) throw new Error('Corrupt Excel file (bad zip entry).');
  const nameLen = u16(view, lo + 26);
  const extraLen = u16(view, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  // Sizes from the CENTRAL directory — the local header may carry zeros when
  // the writer used a data descriptor (Excel itself does).
  const slice = buf.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return new TextDecoder('utf-8').decode(slice);
  if (entry.method !== 8) throw new Error('Unsupported Excel file compression.');
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
): XlsxCellValue[][] {
  const rows: XlsxCellValue[][] = [];
  const rowRe = /<row(\s[^>]*)?>([\s\S]*?)<\/row>|<row(\s[^>]*)?\/>/g;
  const cellRe = /<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g;
  let rowM: RegExpExecArray | null;
  let rowIdx = -1;
  while ((rowM = rowRe.exec(xml)) !== null) {
    const rowTagAttrs = attrs(`<row ${rowM[1] ?? rowM[3] ?? ''}>`);
    const declared = Number(rowTagAttrs.r);
    rowIdx = Number.isFinite(declared) && declared >= 1 ? declared - 1 : rowIdx + 1;
    if (rowIdx >= XLSX_MAX_ROWS) break;
    const body = rowM[2] ?? '';
    if (body === '') continue;
    const row: XlsxCellValue[] = rows[rowIdx] ?? [];
    let cellM: RegExpExecArray | null;
    let cellIdx = -1;
    while ((cellM = cellRe.exec(body)) !== null) {
      const a = attrs(`<c ${cellM[1] ?? cellM[2] ?? ''}>`);
      cellIdx = a.r ? colIndex(a.r) : cellIdx + 1;
      if (cellIdx < 0 || cellIdx >= XLSX_MAX_COLS) continue;
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
  return dense.map((r) => r.slice(0, usedCols));
}

// ─── Workbook assembly ──────────────────────────────────────────────────────

/**
 * Parse an .xlsx file's bytes into sheets of plain values.
 * Throws with a user-safe message on anything that isn't a readable workbook.
 */
export async function readXlsx(buf: ArrayBuffer): Promise<XlsxWorkbook> {
  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const get = async (name: string): Promise<string | null> => {
    const e = byName.get(name);
    return e ? await inflateEntry(buf, e) : null;
  };

  const workbookXml = await get('xl/workbook.xml');
  if (!workbookXml) throw new Error('Not an Excel workbook (.xlsx).');
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
    sheets.push({
      name: a.name ?? `Sheet ${fallbackIdx}`,
      rows: parseSheet(sheetXml, shared, dateStyle, date1904),
    });
  }
  if (sheets.length === 0) throw new Error('No sheets found in this Excel file.');
  return { sheets };
}
