/**
 * Job status API — check progress of background jobs.
 *
 * Routes:
 *   GET  /api/jobs/:queue/:id       — get job status + progress
 *   GET  /api/jobs/:queue/:id/logs  — get job log entries
 *   POST /api/jobs/:queue/:id/retry — retry a failed job
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Queue, Job } from 'bullmq';
import { requireAuth } from '../middleware/auth';
import { getSchemaProfilingQueue, getIngestionQueue, getTransformationQueue, getBusMatrixQueue } from '../jobs/queues';

const router = Router();

function getQueue(name: string): Queue | null {
  switch (name) {
    case 'schema-profiling': return getSchemaProfilingQueue();
    case 'ingestion': return getIngestionQueue();
    case 'transformation': return getTransformationQueue();
    case 'bus-matrix': return getBusMatrixQueue();
    default: return null;
  }
}

// GET /api/jobs/:queue/:id — job status
router.get('/:queue/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queue = getQueue(req.params.queue);
    if (!queue) {
      res.status(400).json({ ok: false, error: 'Job queues not available (Redis not configured)' });
      return;
    }

    const job = await queue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ ok: false, error: 'Job not found' });
      return;
    }

    const state = await job.getState();
    const progress = job.progress;

    res.json({
      ok: true,
      data: {
        id: job.id,
        queue: req.params.queue,
        state,           // 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'
        progress,        // whatever the worker set via job.updateProgress()
        data: job.data,
        result: job.returnvalue,
        failedReason: job.failedReason,
        attempts: job.attemptsMade,
        createdAt: job.timestamp,
        processedAt: job.processedOn,
        finishedAt: job.finishedOn,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:queue/:id/retry — retry a failed job
router.post('/:queue/:id/retry', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queue = getQueue(req.params.queue);
    if (!queue) {
      res.status(400).json({ ok: false, error: 'Job queues not available' });
      return;
    }

    const job = await queue.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ ok: false, error: 'Job not found' });
      return;
    }

    const state = await job.getState();
    if (state !== 'failed') {
      res.status(400).json({ ok: false, error: `Cannot retry job in state: ${state}` });
      return;
    }

    await job.retry(state);
    res.json({ ok: true, data: { id: job.id, state: 'waiting' } });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/active — list all active/waiting jobs across all queues
router.get('/', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const results: Array<{ queue: string; id: string | undefined; state: string; progress: unknown; data: unknown; createdAt: number | undefined }> = [];

    for (const queueName of ['schema-profiling', 'ingestion', 'transformation']) {
      const queue = getQueue(queueName);
      if (!queue) continue;

      const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'failed'], 0, 20);
      for (const job of jobs) {
        const state = await job.getState();
        results.push({
          queue: queueName,
          id: job.id,
          state,
          progress: job.progress,
          data: job.data,
          createdAt: job.timestamp,
        });
      }
    }

    res.json({ ok: true, data: results });
  } catch (err) {
    next(err);
  }
});

export default router;
