/**
 * Shared XLSX builder — produces valid .xlsx buffers without any external dependencies.
 * Uses OOXML (Office Open XML) format with a flat ZIP container (store method, no compression).
 *
 * Supports single-sheet and multi-sheet workbooks.
 */

export interface SheetData {
  name: string;
  headers: string[];
  rows: unknown[][];
}

/**
 * Build a single-sheet XLSX from column names and row objects.
 * Convenience wrapper for the multi-sheet builder.
 */
export function buildXlsxFromRows(columns: string[], rows: Record<string, unknown>[]): Buffer {
  const sheetRows = rows.map((row) => columns.map((col) => row[col]));
  return buildXlsx([{ name: 'Results', headers: columns, rows: sheetRows }]);
}

/**
 * Build a multi-sheet XLSX workbook.
 * Each sheet has a name, headers, and rows (as arrays of values).
 */
export function buildXlsx(sheets: SheetData[]): Buffer {
  if (sheets.length === 0) {
    sheets = [{ name: 'Sheet1', headers: [], rows: [] }];
  }

  // Shared strings approach: collect all strings across all sheets, reference by index
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();

  function addString(s: string): number {
    const existing = stringIndex.get(s);
    if (existing !== undefined) return existing;
    const idx = strings.length;
    strings.push(s);
    stringIndex.set(s, idx);
    return idx;
  }

  // Build sheet XMLs
  const sheetXmls: string[] = [];

  for (const sheet of sheets) {
    const headerIndices = sheet.headers.map((c) => addString(c));

    const sheetRows: string[] = [];
    // Header row
    const headerCells = headerIndices.map((si, ci) =>
      `<c r="${colRef(ci)}1" t="s"><v>${si}</v></c>`
    ).join('');
    sheetRows.push(`<row r="1">${headerCells}</row>`);

    // Data rows
    for (let ri = 0; ri < sheet.rows.length; ri++) {
      const rowNum = ri + 2;
      const cells = sheet.rows[ri].map((val, ci) => {
        if (val === null || val === undefined) return '';
        const ref = `${colRef(ci)}${rowNum}`;
        if (typeof val === 'number' || (typeof val === 'string' && val !== '' && !isNaN(Number(val)) && val.trim() !== '')) {
          return `<c r="${ref}"><v>${Number(val)}</v></c>`;
        }
        const si = addString(String(val));
        return `<c r="${ref}" t="s"><v>${si}</v></c>`;
      }).join('');
      sheetRows.push(`<row r="${rowNum}">${cells}</row>`);
    }

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRows.join('')}</sheetData>
</worksheet>`;

    sheetXmls.push(sheetXml);
  }

  // Shared strings XML
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}
</sst>`;

  // Workbook XML — list all sheets
  const sheetEntries = sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetEntries}</sheets>
</workbook>`;

  // Workbook relationships — one per sheet + shared strings
  const wbRels = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  const ssRId = sheets.length + 1;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${wbRels}
<Relationship Id="rId${ssRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  // Content types — override for each sheet + shared strings
  const sheetOverrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetOverrides}
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // Build ZIP
  const files: Array<{ path: string; data: Buffer }> = [
    { path: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { path: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { path: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    ...sheetXmls.map((xml, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(xml, 'utf8'),
    })),
    { path: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf8') },
  ];

  return buildZip(files);
}

/**
 * Escape a value for safe CSV embedding.
 */
export function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a CSV string from headers and row arrays.
 */
export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCsvField).join(','));
  for (const row of rows) {
    lines.push(row.map((v) => escapeCsvField(String(v ?? ''))).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Build a CSV string from column names and row objects.
 */
export function buildCsvFromRows(columns: string[], rows: Record<string, unknown>[]): string {
  const dataRows = rows.map((row) => columns.map((col) => row[col]));
  return buildCsv(columns, dataRows);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function colRef(index: number): string {
  let ref = '';
  let i = index;
  while (i >= 0) {
    ref = String.fromCharCode(65 + (i % 26)) + ref;
    i = Math.floor(i / 26) - 1;
  }
  return ref;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minimal ZIP builder — store method (no compression), valid for Office Open XML */
function buildZip(files: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.path, 'utf8');

    // Local file header (30 + nameLen)
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // compression: store
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0, 12);            // mod date
    local.writeUInt32LE(crc32(file.data), 14); // CRC-32
    local.writeUInt32LE(file.data.length, 18); // compressed size
    local.writeUInt32LE(file.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // name length
    local.writeUInt16LE(0, 28);            // extra length
    nameBuffer.copy(local, 30);

    // Central directory entry (46 + nameLen)
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);

    parts.push(local, file.data);
    centralDir.push(central);
    offset += local.length + file.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const cd of centralDir) { parts.push(cd); centralSize += cd.length; }

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

/** CRC-32 lookup table + computation */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
