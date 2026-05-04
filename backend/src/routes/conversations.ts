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
import { buildXlsxFromRows, escapeCsvField } from '../utils/xlsxBuilder';

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
    const filename = `clarion-export-${conv.id}.csv`;

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
    const xlsx = buildXlsxFromRows(columns, rows);
    const filename = `clarion-export-${conv.id}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsx);
  } catch (err) { next(err); }
});

export default router;
