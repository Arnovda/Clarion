/**
 * CRUD for dashboard email schedules.
 *
 * Routes:
 *   GET    /api/email-schedules                        — list schedules for tenant
 *   GET    /api/email-schedules/:id                    — get single schedule
 *   POST   /api/email-schedules                        — create schedule
 *   PUT    /api/email-schedules/:id                    — update schedule
 *   DELETE /api/email-schedules/:id                    — delete schedule
 *   POST   /api/email-schedules/:id/send-now           — manual trigger (analyst+)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { registerEmailSchedule, unregisterEmailSchedule } from '../jobs/emailScheduler';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'emailSchedules' });

const router = Router();

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { dashboardId, savedQuestionId } = req.query;
    // LEFT joins since migration 83: a schedule targets a dashboard XOR a
    // saved question.
    let query = db('email_schedules')
      .select(
        'email_schedules.*',
        'dashboards.title as dashboard_title',
        'saved_questions.question as saved_question_text',
      )
      .leftJoin('dashboards', 'dashboards.id', 'email_schedules.dashboard_id')
      .leftJoin('saved_questions', 'saved_questions.id', 'email_schedules.saved_question_id')
      .orderBy('email_schedules.created_at', 'desc');

    if (dashboardId) query = query.where({ 'email_schedules.dashboard_id': Number(dashboardId) });
    if (savedQuestionId) query = query.where({ 'email_schedules.saved_question_id': Number(savedQuestionId) });

    const rows = await query;
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const row = await db('email_schedules').where({ id: req.params.id }).first();
    if (!row) { res.status(404).json({ ok: false, error: 'Schedule not found' }); return; }
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { dashboard_id, saved_question_id, name, recipients, cron_expression, enabled = true, ai_summary = true } = req.body;

    // Exactly one target — dashboard XOR saved question (migration 83's CHECK
    // backs this at the schema level).
    const targets = [dashboard_id, saved_question_id].filter(Boolean).length;
    if (targets !== 1 || !name || !cron_expression) {
      res.status(400).json({ ok: false, error: 'Exactly one of dashboard_id / saved_question_id, plus name and cron_expression, are required' });
      return;
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ ok: false, error: 'recipients must be a non-empty array of email addresses' });
      return;
    }
    if (saved_question_id) {
      const sq = await db('saved_questions').where({ id: Number(saved_question_id) }).first();
      if (!sq) { res.status(404).json({ ok: false, error: 'Saved question not found' }); return; }
    }

    // Pull from the authenticated JWT, NOT a hypothetical req.tenantId
    // that was never populated. Previous code read
    // `(req as ...).tenantId` which was always undefined → INSERT
    // relied on the column default to fire `current_setting`, which
    // works inside reqDb's trx but is fragile.
    const tenantId = req.user!.tenantId;

    const [row] = await db('email_schedules')
      .insert({
        tenant_id: tenantId,
        dashboard_id: dashboard_id ?? null,
        saved_question_id: saved_question_id ?? null,
        name,
        recipients: JSON.stringify(recipients),
        cron_expression,
        enabled,
        ai_summary,
      })
      .returning('*');

    // Register in BullMQ scheduler (no-op if Redis not available)
    await registerEmailSchedule(row);

    res.status(201).json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

router.put('/:id', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, recipients, cron_expression, enabled, ai_summary } = req.body;

    const existing = await db('email_schedules').where({ id: req.params.id }).first();
    if (!existing) { res.status(404).json({ ok: false, error: 'Schedule not found' }); return; }

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name !== undefined) updates.name = name;
    if (recipients !== undefined) updates.recipients = JSON.stringify(recipients);
    if (cron_expression !== undefined) updates.cron_expression = cron_expression;
    if (enabled !== undefined) updates.enabled = enabled;
    if (ai_summary !== undefined) updates.ai_summary = ai_summary;

    const [row] = await db('email_schedules')
      .where({ id: req.params.id })
      .update(updates)
      .returning('*');

    // Re-register so BullMQ uses updated cron / enabled state
    await unregisterEmailSchedule(row.id);
    if (row.enabled) await registerEmailSchedule(row);

    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

router.delete('/:id', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const existing = await db('email_schedules').where({ id: req.params.id }).first();
    if (!existing) { res.status(404).json({ ok: false, error: 'Schedule not found' }); return; }

    await unregisterEmailSchedule(Number(req.params.id));
    await db('email_schedules').where({ id: req.params.id }).delete();

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Manual trigger
// ---------------------------------------------------------------------------

router.post('/:id/send-now', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const schedule = await db('email_schedules').where({ id: req.params.id }).first();
    if (!schedule) { res.status(404).json({ ok: false, error: 'Schedule not found' }); return; }

    // Enqueue with zero delay (or run inline if Redis not available)
    const { getEmailReportQueue } = await import('../jobs/queues');
    const q = getEmailReportQueue();
    if (q) {
      await q.add('email-report', { scheduleId: schedule.id, tenantId: schedule.tenant_id });
    } else {
      // Inline execution (no Redis)
      const { sendScheduledReport } = await import('../services/reportEmailService');
      sendScheduledReport(schedule.id, schedule.tenant_id).catch((err) => {
        log.error({ err }, '[send-now] inline report failed');
      });
    }

    res.json({ ok: true, message: 'Report queued' });
  } catch (err) { next(err); }
});

export default router;
