/**
 * Operator console — operations (wave B item 3).
 *
 *   GET    /api/admin/ops/errors?tenantId=&limit=   — recent errors, every kind (6-2)
 *   GET    /api/admin/ops/queues                     — queue counts + the jobs worth
 *                                                      looking at (active / waiting /
 *                                                      delayed / FAILED = dead letter) (6-6)
 *   POST   /api/admin/ops/queues/:queue/jobs/:id/retry
 *   POST   /api/admin/ops/queues/:queue/jobs/:id/cancel
 *   GET    /api/admin/ops/announcements              — every announcement, history too (6-4)
 *   POST   /api/admin/ops/announcements
 *   PATCH  /api/admin/ops/announcements/:id
 *   DELETE /api/admin/ops/announcements/:id
 *
 * PLATFORM OPERATOR only — same gate and 404-not-403 refusal as the other
 * two consoles (routes/featureFlags.ts explains operator ≠ admin). Every
 * tenant-owned read runs under `tenantQuery(targetId, …)` with an explicit
 * tenant_id filter — the adminTenants discipline. The one thing the errors
 * feed exists to add is the CORRELATION id (6-1): every row that has one
 * shows it, and that id finds the request, the job and the sync worker's
 * log lines in one Log Analytics query.
 */

import { Router, Request, Response, NextFunction } from 'express';
import type { Queue, Job } from 'bullmq';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  adminOpsErrorsSchema,
  adminOpsQueueJobSchema,
  adminAnnouncementCreateSchema,
  adminAnnouncementPatchSchema,
  adminAnnouncementParamsSchema,
} from '../middleware/schemas';
import { semanticDb } from '../db/knex';
import { tenantQuery } from '../services/tenantQuery';
import { isPlatformOperator } from '../services/featureFlags';
import { cancelJob } from '../jobs/cancellation';
import {
  getSchemaProfilingQueue, getIngestionQueue, getTransformationQueue, getEmailReportQueue,
  getBusMatrixQueue, getConnectionSyncScheduleQueue, getPipelineScheduleQueue,
} from '../jobs/queues';
import {
  listAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement, type AnnouncementLevel,
} from '../services/announcements';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'adminOps' });

const router = Router();
router.use(requireAuth);
router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isPlatformOperator(req.user?.email)) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }
  next();
});

// ───────────────────────────── recent errors (6-2) ──────────────────────────

export interface ErrorRow {
  kind: 'sync' | 'transformation' | 'pipeline' | 'table' | 'ai';
  tenantId: number;
  at: string;
  /** One line for the list. */
  summary: string;
  /** The stored error text, bounded. */
  detail: string | null;
  /** The correlation id (6-1) when the row carries one. */
  requestId: string | null;
  /** Where to look: ids the operator can quote. */
  ref: Record<string, unknown>;
}

const DETAIL_MAX = 600;
const bound = (v: unknown) => (v == null ? null : String(v).slice(0, DETAIL_MAX));

/** The recent errors of ONE tenant, every kind, newest first. */
export async function recentErrorsForTenant(tenantId: number, limit: number, sinceDays = 14): Promise<ErrorRow[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  return tenantQuery(tenantId, async (trx) => {
    const rows: ErrorRow[] = [];

    const syncs = await trx('source_sync_runs as r')
      .leftJoin('connections as c', 'c.id', 'r.connection_id')
      .select('r.id', 'r.connection_id', 'r.status', 'r.error_message', 'r.failed_entities', 'r.request_id', 'r.completed_at', 'r.queued_at', 'c.name as connection_name')
      .where('r.tenant_id', tenantId)
      .whereIn('r.status', ['failed', 'partial'])
      .where('r.queued_at', '>=', since)
      .orderBy('r.queued_at', 'desc')
      .limit(limit);
    for (const r of syncs) {
      rows.push({
        kind: 'sync', tenantId,
        at: new Date(r.completed_at ?? r.queued_at).toISOString(),
        summary: `${r.status === 'partial' ? 'Partial' : 'Failed'} sync of ${r.connection_name ?? `connection ${r.connection_id}`}`,
        detail: bound(r.error_message),
        requestId: r.request_id ?? null,
        ref: { syncRunId: r.id, connectionId: r.connection_id, failedEntities: r.failed_entities ?? null },
      });
    }

    const transformations = await trx('transformation_runs as t')
      .leftJoin('data_products as p', 'p.id', 't.product_id')
      .select('t.id', 't.product_id', 't.error_message', 't.finished_at', 't.started_at', 't.triggered_by', 'p.name as product_name')
      .where('t.tenant_id', tenantId)
      .where('t.status', 'failed')
      .where('t.started_at', '>=', since)
      .orderBy('t.started_at', 'desc')
      .limit(limit);
    for (const r of transformations) {
      rows.push({
        kind: 'transformation', tenantId,
        at: new Date(r.finished_at ?? r.started_at).toISOString(),
        summary: `Transformation of ${r.product_name ?? `product ${r.product_id}`} failed`,
        detail: bound(r.error_message),
        requestId: null,
        ref: { transformationRunId: r.id, productId: r.product_id, triggeredBy: r.triggered_by },
      });
    }

    const pipelines = await trx('pipeline_runs as pr')
      .leftJoin('pipelines as pl', 'pl.id', 'pr.pipeline_id')
      .select('pr.id', 'pr.pipeline_id', 'pr.error_message', 'pr.completed_at', 'pr.queued_at', 'pr.job_id', 'pl.name as pipeline_name')
      .where('pr.tenant_id', tenantId)
      .where('pr.status', 'failed')
      .where('pr.queued_at', '>=', since)
      .orderBy('pr.queued_at', 'desc')
      .limit(limit);
    for (const r of pipelines) {
      rows.push({
        kind: 'pipeline', tenantId,
        at: new Date(r.completed_at ?? r.queued_at).toISOString(),
        summary: `Pipeline ${r.pipeline_name ?? r.pipeline_id} failed`,
        detail: bound(r.error_message),
        requestId: null,
        ref: { pipelineRunId: r.id, pipelineId: r.pipeline_id, jobId: r.job_id },
      });
    }

    // A table whose LAST run failed is a standing error, not an event —
    // its timestamp is the last run.
    const tables = await trx('product_tables')
      .select('id', 'table_name', 'display_name', 'last_run_error', 'last_run_at')
      .where({ tenant_id: tenantId, transformation_status: 'failed' })
      .whereNotNull('last_run_error')
      .orderBy('last_run_at', 'desc')
      .limit(limit);
    for (const r of tables) {
      rows.push({
        kind: 'table', tenantId,
        at: new Date(r.last_run_at ?? since).toISOString(),
        summary: `Table ${r.display_name ?? r.table_name} is failing`,
        detail: bound(r.last_run_error),
        requestId: null,
        ref: { productTableId: r.id, tableName: r.table_name },
      });
    }

    const ai = await trx('ai_call_log')
      .select('id', 'call_label', 'category', 'error_code', 'created_at', 'user_id')
      .where({ tenant_id: tenantId, failed: true })
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(limit);
    for (const r of ai) {
      rows.push({
        kind: 'ai', tenantId,
        at: new Date(r.created_at).toISOString(),
        summary: `AI call ${r.call_label} failed${r.error_code ? ` (${r.error_code})` : ''}`,
        detail: null,
        requestId: null,
        ref: { aiCallId: r.id, category: r.category, userId: r.user_id },
      });
    }

    rows.sort((a, b) => b.at.localeCompare(a.at));
    return rows.slice(0, limit);
  });
}

router.get('/errors', validate(adminOpsErrorsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const tenantFilter = req.query.tenantId == null ? null : Number(req.query.tenantId);

    const tenants = await semanticDb('tenants')
      .select('id', 'name')
      .modify((q) => { if (tenantFilter != null) q.where({ id: tenantFilter }); })
      .orderBy('id', 'asc')
      .limit(200);
    if (tenantFilter != null && tenants.length === 0) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const names = new Map<number, string>(tenants.map((t) => [Number(t.id), String(t.name)]));

    // Per tenant, the most recent few; merged and cut. One broken tenant
    // degrades to a note, never blanks the feed.
    const perTenant = tenantFilter != null ? limit : Math.max(5, Math.ceil(limit / Math.max(1, tenants.length)) * 3);
    const failed: number[] = [];
    const all: ErrorRow[] = [];
    for (const t of tenants) {
      try {
        all.push(...(await recentErrorsForTenant(Number(t.id), perTenant)));
      } catch (err) {
        log.warn({ err, tenantId: t.id }, 'errors feed: tenant read failed');
        failed.push(Number(t.id));
      }
    }
    all.sort((a, b) => b.at.localeCompare(a.at));
    res.json({
      ok: true,
      data: {
        errors: all.slice(0, limit).map((e) => ({ ...e, tenantName: names.get(e.tenantId) ?? null })),
        unreadableTenants: failed,
      },
    });
  } catch (err) { next(err); }
});

// ───────────────────────────── queues (6-6) ─────────────────────────────────

const QUEUES: Record<string, () => Queue | null> = {
  'schema-profiling': () => getSchemaProfilingQueue() as Queue | null,
  ingestion: () => getIngestionQueue() as Queue | null,
  transformation: () => getTransformationQueue() as Queue | null,
  'email-report': () => getEmailReportQueue() as Queue | null,
  'bus-matrix': () => getBusMatrixQueue() as Queue | null,
  'connection-sync-schedule': () => getConnectionSyncScheduleQueue() as Queue | null,
  'pipeline-schedule': () => getPipelineScheduleQueue() as Queue | null,
};

function shapeJob(queue: string, state: string, j: Job) {
  const d = (j.data ?? {}) as Record<string, unknown>;
  return {
    queue, state,
    id: String(j.id),
    name: j.name,
    tenantId: typeof d.tenantId === 'number' ? d.tenantId : null,
    requestId: typeof d.requestId === 'string' ? d.requestId : null,
    attemptsMade: j.attemptsMade,
    attempts: (j.opts?.attempts as number | undefined) ?? 1,
    failedReason: j.failedReason ? String(j.failedReason).slice(0, DETAIL_MAX) : null,
    createdAt: j.timestamp ? new Date(j.timestamp).toISOString() : null,
    processedAt: j.processedOn ? new Date(j.processedOn).toISOString() : null,
    finishedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
    // What the job is about, minus anything bulky.
    about: Object.fromEntries(Object.entries(d).filter(([k, v]) => k !== 'requestId' && (typeof v !== 'object' || v === null)).slice(0, 8)),
  };
}

router.get('/queues', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const first = Object.values(QUEUES)[0]();
    if (!first) {
      res.json({ ok: true, data: { available: false, queues: [] } });
      return;
    }
    const queues = [];
    for (const [name, get] of Object.entries(QUEUES)) {
      const q = get();
      if (!q) continue;
      const counts = await q.getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed');
      const [active, waiting, delayed, failed] = await Promise.all([
        q.getJobs(['active'], 0, 20), q.getJobs(['waiting'], 0, 20), q.getJobs(['delayed'], 0, 20), q.getJobs(['failed'], 0, 50),
      ]);
      queues.push({
        name,
        counts,
        jobs: [
          ...active.map((j) => shapeJob(name, 'active', j)),
          ...waiting.map((j) => shapeJob(name, 'waiting', j)),
          ...delayed.map((j) => shapeJob(name, 'delayed', j)),
          ...failed.map((j) => shapeJob(name, 'failed', j)),
        ],
      });
    }
    res.json({ ok: true, data: { available: true, queues } });
  } catch (err) { next(err); }
});

async function findJob(req: Request, res: Response): Promise<{ queue: Queue; job: Job } | null> {
  const get = QUEUES[req.params.queue];
  const queue = get ? get() : null;
  if (!queue) {
    res.status(400).json({ ok: false, error: get ? 'Job queues are not available (Redis not configured)' : 'Unknown queue' });
    return null;
  }
  const job = await queue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Job not found' });
    return null;
  }
  return { queue, job };
}

router.post('/queues/:queue/jobs/:id/retry', validate(adminOpsQueueJobSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const found = await findJob(req, res);
    if (!found) return;
    const state = await found.job.getState();
    if (state !== 'failed') {
      res.status(400).json({ ok: false, error: `Only a failed job can be retried (this one is ${state})` });
      return;
    }
    await found.job.retry('failed');
    log.info({ queue: req.params.queue, jobId: req.params.id, operator: req.user!.email }, 'operator retried a failed job');
    res.json({ ok: true, data: { id: req.params.id, state: 'waiting' } });
  } catch (err) { next(err); }
});

/**
 * Cancel: a waiting/delayed job is removed before it runs; an ACTIVE job is
 * told to stop through the cancellation channel (the bus-matrix and sync
 * flows check it at every step and abort their AI streams); a failed job is
 * removed from the dead-letter set (the operator has decided it is not
 * worth retrying).
 */
router.post('/queues/:queue/jobs/:id/cancel', validate(adminOpsQueueJobSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const found = await findJob(req, res);
    if (!found) return;
    const state = await found.job.getState();
    let outcome: string;
    if (state === 'active') {
      cancelJob(String(found.job.id));
      outcome = 'cancellation requested — the worker stops at its next checkpoint';
    } else if (state === 'completed') {
      res.status(400).json({ ok: false, error: 'This job already completed' });
      return;
    } else {
      await found.job.remove();
      outcome = state === 'failed' ? 'removed from the failed set' : 'removed before it ran';
    }
    log.info({ queue: req.params.queue, jobId: req.params.id, state, operator: req.user!.email }, 'operator cancelled a job');
    res.json({ ok: true, data: { id: req.params.id, previousState: state, outcome } });
  } catch (err) { next(err); }
});

// ─────────────────────────── announcements (6-4) ────────────────────────────

router.get('/announcements', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: { announcements: await listAnnouncements() } });
  } catch (err) { next(err); }
});

router.post('/announcements', validate(adminAnnouncementCreateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = req.body as { message: string; level?: AnnouncementLevel; endsAt?: string | null };
    const a = await createAnnouncement({
      message: b.message, level: b.level ?? 'info',
      endsAt: b.endsAt ? new Date(b.endsAt) : null,
      createdBy: req.user!.email,
    });
    log.info({ announcementId: a.id, level: a.level, operator: req.user!.email }, 'announcement published');
    res.status(201).json({ ok: true, data: a });
  } catch (err) { next(err); }
});

router.patch('/announcements/:id', validate(adminAnnouncementPatchSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = req.body as { message?: string; level?: AnnouncementLevel; endsAt?: string | null; end?: boolean };
    const patch: { message?: string; level?: AnnouncementLevel; endsAt?: Date | null } = {};
    if (b.message !== undefined) patch.message = b.message;
    if (b.level !== undefined) patch.level = b.level;
    if (b.end) patch.endsAt = new Date();
    else if (b.endsAt !== undefined) patch.endsAt = b.endsAt ? new Date(b.endsAt) : null;
    const a = await updateAnnouncement(Number(req.params.id), patch);
    if (!a) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    res.json({ ok: true, data: a });
  } catch (err) { next(err); }
});

router.delete('/announcements/:id', validate(adminAnnouncementParamsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const gone = await deleteAnnouncement(Number(req.params.id));
    if (!gone) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
