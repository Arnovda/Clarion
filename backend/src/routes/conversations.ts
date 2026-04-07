/**
 * Conversations API — server-side chat history
 *
 * GET    /api/conversations                — list conversations (user's own)
 * POST   /api/conversations                — create a new conversation
 * GET    /api/conversations/:id            — get conversation with messages
 * PATCH  /api/conversations/:id            — update title
 * DELETE /api/conversations/:id            — delete conversation + messages
 * PATCH  /api/conversations/:id/star       — toggle starred
 * POST   /api/conversations/:id/messages   — append a message
 * PATCH  /api/conversations/messages/:id/feedback — set feedback on a message
 * GET    /api/conversations/:id/export/csv   — export results as CSV
 * GET    /api/conversations/:id/export/xlsx  — export results as Excel
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { parsePagination, paginatedResponse } from '../utils/paginate';

const router = Router();
router.use(requireAuth);

// ─── LIST conversations ──────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const starred = req.query.starred === 'true';
    const { page, limit, offset } = parsePagination(req.query, { limit: 30 });

    let baseQuery = semanticDb('conversations').where({ user_id: userId });
    if (starred) baseQuery = baseQuery.where({ starred: true });

    const [{ count: total }] = await baseQuery.clone().count('* as count');

    const rows = await baseQuery
      .select('id', 'title', 'starred', 'source_key', 'created_at', 'updated_at')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .offset(offset);

    res.json(paginatedResponse(rows, Number(total), page, limit));
  } catch (err) { next(err); }
});

// ─── CREATE conversation ─────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, sourceKey } = req.body as { title?: string; sourceKey?: string };

    const [conv] = await semanticDb('conversations')
      .insert({
        tenant_id: req.user!.tenantId,
        user_id: req.user!.sub,
        title: title?.trim() || 'New conversation',
        source_key: sourceKey ?? null,
      })
      .returning('*');

    res.json({ ok: true, data: conv });
  } catch (err) { next(err); }
});

// ─── GET conversation with messages ──────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conv = await semanticDb('conversations')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();

    if (!conv) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }

    const messages = await semanticDb('conversation_messages')
      .where({ conversation_id: conv.id })
      .orderBy('created_at', 'asc')
      .select('*');

    res.json({ ok: true, data: { ...conv, messages } });
  } catch (err) { next(err); }
});

// ─── UPDATE title ────────────────────────────────────────────────────────────
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title } = req.body as { title: string };
    if (!title?.trim()) { res.status(400).json({ ok: false, error: 'Title is required' }); return; }

    const count = await semanticDb('conversations')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .update({ title: title.trim(), updated_at: new Date().toISOString() });

    if (count === 0) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE conversation ─────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await semanticDb('conversations')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .delete();

    if (count === 0) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── TOGGLE star ─────────────────────────────────────────────────────────────
router.patch('/:id/star', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conv = await semanticDb('conversations')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();

    if (!conv) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }

    const newVal = !conv.starred;
    await semanticDb('conversations')
      .where({ id: conv.id })
      .update({ starred: newVal, updated_at: new Date().toISOString() });

    res.json({ ok: true, data: { starred: newVal } });
  } catch (err) { next(err); }
});

// ─── APPEND message ──────────────────────────────────────────────────────────
router.post('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = Number(req.params.id);

    // Verify ownership
    const conv = await semanticDb('conversations')
      .where({ id: conversationId, user_id: req.user!.sub })
      .first();
    if (!conv) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }

    const msg = req.body as {
      role: string;
      content: string;
      question?: string;
      sql?: string;
      tablesUsed?: string[];
      confidence?: number;
      warning?: string;
      blocked?: boolean;
      needsClarification?: boolean;
      mismatches?: unknown;
      ambiguities?: unknown;
      error?: boolean;
      debug?: unknown;
      rows?: unknown[];
      wasRepaired?: boolean;
      reasoning?: string;
      queryLayer?: string;
    };

    if (!msg.role || !msg.content) {
      res.status(400).json({ ok: false, error: 'role and content are required' });
      return;
    }

    // Cap stored rows to 200 to keep DB size manageable
    const cappedRows = msg.rows ? (msg.rows as unknown[]).slice(0, 200) : null;

    const [saved] = await semanticDb('conversation_messages')
      .insert({
        tenant_id: req.user!.tenantId,
        conversation_id: conversationId,
        role: msg.role,
        content: msg.content,
        question: msg.question ?? null,
        sql: msg.sql ?? null,
        tables_used: msg.tablesUsed ? JSON.stringify(msg.tablesUsed) : null,
        confidence: msg.confidence ?? null,
        warning: msg.warning ?? null,
        blocked: msg.blocked ?? false,
        needs_clarification: msg.needsClarification ?? false,
        mismatches: msg.mismatches ? JSON.stringify(msg.mismatches) : null,
        ambiguities: msg.ambiguities ? JSON.stringify(msg.ambiguities) : null,
        error: msg.error ?? false,
        debug: msg.debug ? JSON.stringify(msg.debug) : null,
        rows: cappedRows ? JSON.stringify(cappedRows) : null,
        was_repaired: msg.wasRepaired ?? false,
        reasoning: msg.reasoning ?? null,
        query_layer: msg.queryLayer ?? null,
      })
      .returning('*');

    // Update conversation title from first user message + bump updated_at
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (msg.role === 'user') {
      const msgCount = await semanticDb('conversation_messages')
        .where({ conversation_id: conversationId, role: 'user' })
        .count('id as count')
        .first();
      if (Number(msgCount?.count ?? 0) <= 1) {
        update.title = msg.content.slice(0, 80);
      }
    }
    await semanticDb('conversations').where({ id: conversationId }).update(update);

    res.json({ ok: true, data: saved });
  } catch (err) { next(err); }
});

// ─── SET feedback on a message ───────────────────────────────────────────────
router.patch('/messages/:id/feedback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const messageId = Number(req.params.id);
    const { feedback, comment } = req.body as { feedback: 'up' | 'down' | null; comment?: string };

    if (feedback !== null && feedback !== 'up' && feedback !== 'down') {
      res.status(400).json({ ok: false, error: 'feedback must be "up", "down", or null' });
      return;
    }

    // Verify ownership via conversation join
    const msg = await semanticDb('conversation_messages as m')
      .join('conversations as c', 'c.id', 'm.conversation_id')
      .where({ 'm.id': messageId, 'c.user_id': req.user!.sub })
      .select('m.id')
      .first();

    if (!msg) { res.status(404).json({ ok: false, error: 'Message not found' }); return; }

    await semanticDb('conversation_messages')
      .where({ id: messageId })
      .update({
        feedback: feedback,
        feedback_comment: comment ?? null,
        feedback_at: feedback ? new Date().toISOString() : null,
      });

    // If feedback is 'down', create a definition gap entry for improvement
    if (feedback === 'down') {
      const fullMsg = await semanticDb('conversation_messages').where({ id: messageId }).first();
      if (fullMsg?.question) {
        await semanticDb('definition_gaps')
          .insert({
            tenant_id: req.user!.tenantId,
            gap_description: `User reported incorrect answer. Question: "${fullMsg.question}"${comment ? `. Comment: "${comment}"` : ''}`,
            resolved: false,
          })
          .catch(() => {}); // non-fatal
      }
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── EXPORT CSV ──────────────────────────────────────────────────────────────
router.get('/:id/export/csv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conv = await semanticDb('conversations')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();
    if (!conv) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }

    // Find the last assistant message with rows
    const messageId = req.query.messageId ? Number(req.query.messageId) : null;
    const msgQuery = semanticDb('conversation_messages')
      .where({ conversation_id: conv.id, role: 'assistant' })
      .whereNotNull('rows');
    if (messageId) msgQuery.where({ id: messageId });
    const msg = await msgQuery.orderBy('created_at', 'desc').first();

    if (!msg || !msg.rows) {
      res.status(404).json({ ok: false, error: 'No result data found to export' });
      return;
    }

    const rows = typeof msg.rows === 'string' ? JSON.parse(msg.rows) : msg.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(404).json({ ok: false, error: 'No result data found to export' });
      return;
    }

    const columns = Object.keys(rows[0]);
    const csvLines: string[] = [];

    // Header
    csvLines.push(columns.map(escapeCsvField).join(','));

    // Data rows
    for (const row of rows) {
      csvLines.push(columns.map((col) => escapeCsvField(String(row[col] ?? ''))).join(','));
    }

    const csv = csvLines.join('\r\n');
    const filename = `databridge-export-${conv.id}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compat
  } catch (err) { next(err); }
});

// ─── EXPORT XLSX ─────────────────────────────────────────────────────────────
router.get('/:id/export/xlsx', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conv = await semanticDb('conversations')
      .where({ id: Number(req.params.id), user_id: req.user!.sub })
      .first();
    if (!conv) { res.status(404).json({ ok: false, error: 'Conversation not found' }); return; }

    const messageId = req.query.messageId ? Number(req.query.messageId) : null;
    const msgQuery = semanticDb('conversation_messages')
      .where({ conversation_id: conv.id, role: 'assistant' })
      .whereNotNull('rows');
    if (messageId) msgQuery.where({ id: messageId });
    const msg = await msgQuery.orderBy('created_at', 'desc').first();

    if (!msg || !msg.rows) {
      res.status(404).json({ ok: false, error: 'No result data found to export' });
      return;
    }

    const rows = typeof msg.rows === 'string' ? JSON.parse(msg.rows) : msg.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(404).json({ ok: false, error: 'No result data found to export' });
      return;
    }

    // Build XLSX using a minimal OOXML generator (no external dependency)
    const columns = Object.keys(rows[0]);
    const xlsx = buildXlsx(columns, rows);
    const filename = `databridge-export-${conv.id}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsx);
  } catch (err) { next(err); }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Minimal XLSX builder — produces a valid .xlsx buffer without dependencies.
 * Uses a flat ZIP container with an uncompressed sheet.
 */
function buildXlsx(columns: string[], rows: Record<string, unknown>[]): Buffer {
  // Shared strings approach: collect all strings, reference by index
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

  // Register header strings
  const headerIndices = columns.map((c) => addString(c));

  // Build sheet rows
  const sheetRows: string[] = [];
  // Header row
  const headerCells = headerIndices.map((si, ci) =>
    `<c r="${colRef(ci)}1" t="s"><v>${si}</v></c>`
  ).join('');
  sheetRows.push(`<row r="1">${headerCells}</row>`);

  // Data rows
  for (let ri = 0; ri < rows.length; ri++) {
    const rowNum = ri + 2;
    const cells = columns.map((col, ci) => {
      const val = rows[ri][col];
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

  const lastCol = colRef(columns.length - 1);
  const lastRow = rows.length + 1;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${sheetRows.join('')}</sheetData>
</worksheet>`;

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}
</sst>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Results" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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
    { path: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
    { path: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf8') },
  ];

  return buildZip(files);
}

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

export default router;
