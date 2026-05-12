/**
 * Routes for managing scheduled connection syncs.
 *
 *   GET    /api/connections/:id/sync-schedule       → fetch the connection's schedule (or 404)
 *   PUT    /api/connections/:id/sync-schedule       → upsert schedule
 *   DELETE /api/connections/:id/sync-schedule       → remove schedule
 *
 * Tenancy: every route gates by `(connection_id, tenant_id)` so a guess
 * at another tenant's connection ID returns 404, not their schedule.
 *
 * Cost: when the schedule fires, the orchestrator's schema-hash gate skips
 * Claude entirely on unchanged schemas — making hourly schedules
 * essentially free in steady state.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import type { Knex } from 'knex';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { reqDb } from '../db/reqDb';
import {
  registerConnectionSyncSchedule,
  removeConnectionSyncSchedule,
} from '../jobs/connectionSyncScheduler';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────
async function getConnectionForTenant(
  db: Knex | Knex.Transaction,
  connectionId: number,
  tenantId: number,
) {
  return db('connections')
    .where({ id: connectionId, tenant_id: tenantId })
    .first();
}

function validateCron(expression: string, timezone: string): { valid: boolean; nextRun?: Date; error?: string } {
  try {
    const interval = CronExpressionParser.parse(expression, { tz: timezone });
    return { valid: true, nextRun: interval.next().toDate() };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid cron expression' };
  }
}

// ─── GET — fetch the current schedule for a connection ────────────────────
router.get(
  '/:id/sync-schedule',
  requireAuth,
  requireRole('admin', 'analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const connectionId = Number(req.params.id);
      const conn = await getConnectionForTenant(db, connectionId, req.user!.tenantId);
      if (!conn) {
        res.status(404).json({ ok: false, error: 'Connection not found' });
        return;
      }
      const sched = await db('connection_sync_schedules')
        .where({ connection_id: connectionId, tenant_id: req.user!.tenantId })
        .first();
      if (!sched) {
        res.json({ ok: true, data: null });
        return;
      }
      // Compute next firing time so the UI can show "Next run: …".
      const nextRunCheck = validateCron(sched.cron_expression, sched.timezone);
      res.json({
        ok: true,
        data: {
          ...sched,
          next_run: nextRunCheck.nextRun?.toISOString() ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PUT — upsert schedule ────────────────────────────────────────────────
router.put(
  '/:id/sync-schedule',
  requireAuth,
  requireRole('admin'),
  validate(z.object({
    body: z.object({
      cronExpression: z.string().min(1).max(100),
      timezone: z.string().min(1).max(64).default('UTC'),
      enabled: z.boolean().default(true),
    }),
    params: z.object({ id: z.string().min(1) }),
  })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const connectionId = Number(req.params.id);
      const { cronExpression, timezone, enabled } = req.body as {
        cronExpression: string;
        timezone: string;
        enabled: boolean;
      };

      const conn = await getConnectionForTenant(db, connectionId, req.user!.tenantId);
      if (!conn) {
        res.status(404).json({ ok: false, error: 'Connection not found' });
        return;
      }
      if (!conn.connector_type) {
        res.status(400).json({ ok: false, error: 'Schedules only apply to source-connector connections' });
        return;
      }

      const cronCheck = validateCron(cronExpression, timezone);
      if (!cronCheck.valid) {
        res.status(400).json({ ok: false, error: `Invalid cron expression: ${cronCheck.error}` });
        return;
      }

      // Upsert (UNIQUE constraint on connection_id makes this atomic).
      const existing = await db('connection_sync_schedules')
        .where({ connection_id: connectionId, tenant_id: req.user!.tenantId })
        .first();

      let row;
      if (existing) {
        await db('connection_sync_schedules')
          .where({ id: existing.id, tenant_id: req.user!.tenantId })
          .update({
            cron_expression: cronExpression,
            timezone,
            enabled,
            updated_at: new Date().toISOString(),
          });
        row = await db('connection_sync_schedules')
          .where({ id: existing.id, tenant_id: req.user!.tenantId })
          .first();
      } else {
        const [inserted] = await db('connection_sync_schedules')
          .insert({
            tenant_id: req.user!.tenantId,
            connection_id: connectionId,
            cron_expression: cronExpression,
            timezone,
            enabled,
            created_by: req.user!.email ?? null,
          })
          .returning('*');
        row = inserted;
      }

      // Mirror to BullMQ. No-op when Redis isn't configured — the row
      // persists; activating Redis later picks them all up via
      // `loadConnectionSyncSchedules` on next backend boot.
      await registerConnectionSyncSchedule(row);

      res.json({
        ok: true,
        data: { ...row, next_run: cronCheck.nextRun?.toISOString() ?? null },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE — remove schedule ─────────────────────────────────────────────
router.delete(
  '/:id/sync-schedule',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const connectionId = Number(req.params.id);
      const conn = await getConnectionForTenant(db, connectionId, req.user!.tenantId);
      if (!conn) {
        res.status(404).json({ ok: false, error: 'Connection not found' });
        return;
      }
      const existing = await db('connection_sync_schedules')
        .where({ connection_id: connectionId, tenant_id: req.user!.tenantId })
        .first();
      if (!existing) {
        res.status(404).json({ ok: false, error: 'No schedule for this connection' });
        return;
      }
      await db('connection_sync_schedules')
        .where({ id: existing.id, tenant_id: req.user!.tenantId })
        .del();
      await removeConnectionSyncSchedule(existing.id);
      res.json({ ok: true, data: { removed: true } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
