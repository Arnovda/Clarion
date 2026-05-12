/**
 * Schedule API — CRUD for transformation schedules + run history.
 *
 * Routes:
 *   GET    /api/schedules/product/:productId       — get schedule for a product
 *   PUT    /api/schedules/product/:productId       — create or update schedule
 *   DELETE /api/schedules/product/:productId       — delete schedule
 *   GET    /api/schedules/product/:productId/runs  — get run history
 *   POST   /api/schedules/product/:productId/run   — trigger manual run
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { tenantQuery } from '../services/tenantQuery';
import { registerSchedule, removeSchedule } from '../jobs/scheduler';
import { getTransformationQueue, TransformationJobData } from '../jobs/queues';
import { trackEvent } from '../utils/monitoring';

const router = Router();

// GET /api/schedules/product/:productId — get schedule
router.get('/product/:productId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const schedule = await db('transformation_schedules')
      .where({ product_id: req.params.productId })
      .first();

    res.json({ ok: true, data: schedule ?? null });
  } catch (err) {
    next(err);
  }
});

// PUT /api/schedules/product/:productId — create or update schedule
router.put('/product/:productId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.productId);
    const { cron_expression, timezone, enabled } = req.body as {
      cron_expression: string;
      timezone?: string;
      enabled?: boolean;
    };

    if (!cron_expression) {
      res.status(400).json({ ok: false, error: 'cron_expression is required' });
      return;
    }

    // Validate cron expression (basic check: 5 parts)
    const parts = cron_expression.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      res.status(400).json({ ok: false, error: 'Invalid cron expression. Expected 5 parts: minute hour day month weekday' });
      return;
    }

    // Verify product exists
    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Product not found' });
      return;
    }

    const tz = timezone ?? 'Europe/Brussels';
    const isEnabled = enabled !== false;

    // Upsert
    const existing = await db('transformation_schedules')
      .where({ product_id: productId })
      .first();

    let scheduleId: number;
    if (existing) {
      await db('transformation_schedules')
        .where({ id: existing.id })
        .update({
          cron_expression,
          timezone: tz,
          enabled: isEnabled,
          updated_at: new Date(),
        });
      scheduleId = existing.id;
    } else {
      const [row] = await db('transformation_schedules')
        .insert({
          product_id: productId,
          cron_expression,
          timezone: tz,
          enabled: isEnabled,
          created_by: req.user!.email,
        })
        .returning('id');
      scheduleId = typeof row === 'object' ? (row as { id: number }).id : row;
    }

    // Sync with BullMQ
    const tenantId = req.user!.tenantId;
    await registerSchedule({
      id: scheduleId,
      product_id: productId,
      tenant_id: tenantId,
      cron_expression,
      timezone: tz,
      enabled: isEnabled,
    });

    trackEvent('schedule_updated', {
      productId: String(productId),
      cron: cron_expression,
      enabled: String(isEnabled),
    });

    const schedule = await db('transformation_schedules')
      .where({ id: scheduleId })
      .first();

    res.json({ ok: true, data: schedule });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/schedules/product/:productId — remove schedule
router.delete('/product/:productId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.productId);
    const existing = await db('transformation_schedules')
      .where({ product_id: productId })
      .first();

    if (existing) {
      await removeSchedule(existing.id);
      await db('transformation_schedules').where({ id: existing.id }).delete();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/schedules/product/:productId/runs — run history
router.get('/product/:productId/runs', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const runs = await db('transformation_runs')
      .where({ product_id: req.params.productId })
      .orderBy('started_at', 'desc')
      .limit(limit);

    res.json({ ok: true, data: runs });
  } catch (err) {
    next(err);
  }
});

// POST /api/schedules/product/:productId/run — trigger manual run
router.post('/product/:productId/run', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const productId = Number(req.params.productId);
    const tenantId = req.user!.tenantId;
    const triggeredBy = req.user!.email;

    const product = await db('data_products').where({ id: productId }).first();
    if (!product) {
      res.status(404).json({ ok: false, error: 'Product not found' });
      return;
    }

    // Record run
    const [runRow] = await db('transformation_runs').insert({
      product_id: productId,
      triggered_by: triggeredBy,
      status: 'running',
    }).returning('id');
    const runId = typeof runRow === 'object' ? (runRow as { id: number }).id : runRow;

    // Try to enqueue via BullMQ, else run inline
    const queue = getTransformationQueue();
    if (queue) {
      const job = await queue.add('manual-run', {
        productId,
        tenantId,
        triggeredBy,
      } as TransformationJobData);

      res.json({ ok: true, data: { runId, jobId: job.id, queue: 'transformation' } });
    } else {
      // Inline execution (no Redis)
      res.json({ ok: true, data: { runId, inline: true } });

      // Run in background (don't block response). The request's dbTrx
      // is gone by now, so use tenantQuery to open a fresh trx with
      // the right SET LOCAL applied.
      (async () => {
        try {
          const { runProductTransformation } = await import('../services/transformationRunner');
          const tables = await tenantQuery(tenantId, (trx) =>
            trx('product_tables').where({ product_id: productId }),
          );
          const results = await runProductTransformation(product, tables, tenantId);

          await tenantQuery(tenantId, (trx) =>
            trx('transformation_runs').where({ id: runId }).update({
              status: 'completed',
              tables_transformed: results.length,
              finished_at: new Date(),
            }),
          );
        } catch (err) {
          await tenantQuery(tenantId, (trx) =>
            trx('transformation_runs').where({ id: runId }).update({
              status: 'failed',
              error_message: err instanceof Error ? err.message : 'Unknown error',
              finished_at: new Date(),
            }),
          );
        }
      })();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
