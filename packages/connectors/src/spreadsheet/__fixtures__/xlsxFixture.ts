/**
 * Minimal .xlsx writer, for tests only.
 *
 * The spreadsheet reader is hand-rolled, so its tests must run against real
 * files rather than against a mock of the parser's own assumptions. This
 * builds a genuine OOXML workbook — correct zip framing with CRC32s, a
 * content-types part, workbook relationships — so a fixture produced here
 * opens in Excel. That is the point: a fixture the reader can parse but Excel
 * cannot is evidence about nothing.
 *
 * Excluded from the package build (see tsconfig `exclude`).
 */

import { deflateRawSync } from 'zlib';

export type FixtureCell = string | number | boolean | null;

export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
}

export interface FixtureOptions {
  /** Emit strings via the sharedStrings part instead of inline. */
  useSharedStrings?: boolean;
  /** Column indices (0-based) whose numeric cells carry a date format. */
  dateColumns?: number[];
  /** Use the 1904 date system (Mac-era workbooks). */
  date1904?: boolean;
  /** Store entries uncompressed (zip method 0) to exercise that branch. */
  store?: boolean;
}

// ─── zip ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface PendingEntry { name: string; data: Buffer; }

function zip(entries: PendingEntry[], store: boolean): ArrayBuffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = store ? e.data : deflateRawSync(e.data);
    const method = store ? 0 : 8;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);          // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, comp);
    centrals.push(central);
    offset += local.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const out = Buffer.concat([...locals, centralBuf, eocd]);
  // Copy into a standalone ArrayBuffer — Buffer views share a pooled backing
  // store, and handing the reader a view's whole pool would corrupt offsets.
  const ab = new ArrayBuffer(out.length);
  new Uint8Array(ab).set(out);
  return ab;
}

// ─── spreadsheetML ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colRef(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Build a real .xlsx from plain rows. Strings inline unless asked otherwise. */
export function buildXlsxFixture(sheets: FixtureSheet[], opts: FixtureOptions = {}): ArrayBuffer {
  const dateCols = new Set(opts.dateColumns ?? []);
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const internStr = (s: string): number => {
    const hit = sharedIndex.get(s);
    if (hit !== undefined) return hit;
    const idx = shared.length;
    shared.push(s);
    sharedIndex.set(s, idx);
    return idx;
  };

  const sheetParts = sheets.map((sheet, sIdx) => {
    const rowsXml = sheet.rows.map((row, r) => {
      const cells = row.map((v, c) => {
        if (v === null || v === undefined) return '';
        const ref = `${colRef(c)}${r + 1}`;
        // Style 1 is the date format (see styles.xml below); 0 is General.
        const styleAttr = typeof v === 'number' && dateCols.has(c) ? ' s="1"' : '';
        if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
        if (typeof v === 'number') return `<c r="${ref}"${styleAttr}><v>${v}</v></c>`;
        if (opts.useSharedStrings) {
          return `<c r="${ref}" t="s"><v>${internStr(v)}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return {
      name: `xl/worksheets/sheet${sIdx + 1}.xml`,
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>`
        + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
        + `<sheetData>${rowsXml}</sheetData></worksheet>`,
        'utf8',
      ),
    };
  });

  const workbookPr = opts.date1904 ? '<workbookPr date1904="1"/>' : '';
  const sheetTags = sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `${workbookPr}<sheets>${sheetTags}</sheets></workbook>`;

  const relTags = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  const rels = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}</Relationships>`;

  // numFmtId 14 is the built-in short date; cellXfs index 1 references it.
  const styles = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>`
    + `</styleSheet>`;

  const overrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + overrides
    + `</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;

  const entries: PendingEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
    ...sheetParts,
  ];

  if (opts.useSharedStrings) {
    const items = shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('');
    entries.push({
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>`
        + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${items}</sst>`,
        'utf8',
      ),
    });
  }

  return zip(entries, opts.store ?? false);
}
