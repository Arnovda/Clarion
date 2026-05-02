// Monitoring must be imported BEFORE other modules for auto-instrumentation
import { initMonitoring } from './utils/monitoring';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { requestLogger } from './middleware/requestLogger';
import { logger } from './utils/logger';

// Don't override env vars in test mode — setup.ts sets DATABASE_URL to test DB
if (!process.env.VITEST) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
}

// Initialize Application Insights (no-op if not configured)
initMonitoring();

import { ensureNeo4jConstraints, closeDriver } from './db/neo4j';

import { requireAuth, requireRole } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import authRouter         from './routes/auth';
import connectionsRouter  from './routes/connections';
import semanticRouter     from './routes/semantic';
import queryRouter        from './routes/query';
import reportsRouter      from './routes/reports';
import dashboardsRouter   from './routes/dashboards';
import crossViewsRouter   from './routes/cross-views';
import qualityRouter      from './routes/quality';
import ingestionRouter    from './routes/ingestion';
import productsRouter     from './routes/products';
import pipelinesRouter    from './routes/pipelines';
import jobsRouter         from './routes/jobs';
import schedulesRouter    from './routes/schedules';
import usersRouter        from './routes/users';
import conversationsRouter from './routes/conversations';
import notebooksRouter     from './routes/notebooks';
import notificationsRouter from './routes/notifications';
import policiesRouter      from './routes/policies';
import settingsRouter      from './routes/settings';
import emailSchedulesRouter from './routes/emailSchedules';
import sourcesRouter         from './routes/sources';
import catalogRouter         from './routes/catalog';
import { startWorkers, stopWorkers } from './jobs/workers';
import { closeQueues } from './jobs/queues';
import { closeRedis } from './jobs/redis';
import { loadSchedules, closeScheduler } from './jobs/scheduler';
import { loadEmailSchedules } from './jobs/emailScheduler';
import { drainPool } from './connectors/ConnectorPool';
import { drainAll as drainDuckDBPool } from './connectors/DuckDBPool';

const app = express();
app.set('trust proxy', 1); // trust Azure Container Apps / load balancer X-Forwarded-For

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

// Helmet sets security headers: X-Content-Type-Options, X-Frame-Options,
// X-XSS-Protection, Strict-Transport-Security, Content-Security-Policy, etc.
const isDev = process.env.NODE_ENV !== 'production';
app.use(helmet({
  contentSecurityPolicy: isDev ? false : {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS — locked to configured origins
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
app.use(cors({ origin: CORS_ORIGIN.split(','), credentials: true }));

// Body parsing with size limits
app.use(express.json({ limit: '2mb' }));

// Structured request logging + request ID tracing
app.use(requestLogger);

// Global rate limiter: 200 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Too many requests, please try again later' },
});
app.use(globalLimiter);

// Strict rate limiter for auth endpoints: 20 per minute per IP
const authLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Too many authentication attempts, please try again later' },
});

// Strict rate limiter for AI-intensive endpoints: 30 per minute per IP
const aiLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'AI rate limit reached, please try again shortly' },
});

// ---------------------------------------------------------------------------
// Auth routes (register, login, forgot-password, reset-password, refresh, me)
// ---------------------------------------------------------------------------

app.use('/api/auth', authLimiter, authRouter);

// ---------------------------------------------------------------------------
// Feature routes (all require JWT — tenant context set automatically by requireAuth)
// ---------------------------------------------------------------------------

app.use('/api/connections',  connectionsRouter);
app.use('/api/semantic',     semanticRouter);
app.use('/api/query',        aiLimiter, queryRouter);
app.use('/api/reports',      reportsRouter);
app.use('/api/dashboards',   dashboardsRouter);
app.use('/api/cross-views',  crossViewsRouter);
app.use('/api/quality',      qualityRouter);
app.use('/api/ingestion',    ingestionRouter);
app.use('/api/products',     productsRouter);
app.use('/api/pipelines',    pipelinesRouter);
app.use('/api/jobs',         jobsRouter);
app.use('/api/schedules',   schedulesRouter);
app.use('/api/users',       usersRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/notebooks',     notebooksRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/policies',        policiesRouter);
app.use('/api/settings',        settingsRouter);
app.use('/api/email-schedules', emailSchedulesRouter);
app.use('/api/source-types',    sourcesRouter);
app.use('/api/catalog',         catalogRouter);

// Admin-only: re-run schema profiling for an existing connection
app.post('/api/connections/:id/profile', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { semanticDb } = await import('./db/knex');
    const { runSchemaProfiler } = await import('./semantic/SchemaProfiler');
    const connection = await semanticDb('connections').where({ id: req.params.id }).first();
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }
    const config = (typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config) as { filepath: string };
    await semanticDb('source_tables').where({ connection_id: connection.id }).delete();
    const result = await runSchemaProfiler(connection.id as number, config.filepath);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Health check + global error handler
// ---------------------------------------------------------------------------

// Simple liveness probe — always 200 if the process is running
app.get('/api/ping', (_req, res) => { res.json({ ok: true }); });


app.get('/api/health', async (_req, res) => {
  const checks: Record<string, string> = {};
  try {
    const { semanticDb } = await import('./db/knex');
    await semanticDb.raw('SELECT 1');
    checks.postgres = 'ok';
  } catch { checks.postgres = 'error'; }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  res.status(allOk ? 200 : 503).json({ ok: allOk, checks, uptime: process.uptime() });
});

app.use(errorHandler);

// Skip server start when running under Vitest (tests use supertest directly)
if (!process.env.VITEST) {
  const PORT = Number(process.env.PORT ?? 3001);
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'DataBridge backend running');
    // Start Neo4j constraint setup in the background — non-blocking.
    ensureNeo4jConstraints().catch(err => console.error('Neo4j constraint setup error:', err));
    // Start BullMQ workers (no-op if Redis not configured)
    startWorkers();
    // Load scheduled transformations from DB into BullMQ
    loadSchedules().catch(err => console.error('Schedule loading error:', err));
    // Load email report schedules from DB into BullMQ
    loadEmailSchedules().catch(err => console.error('Email schedule loading error:', err));

    // On startup, reset any profiling stuck in 'running' (from a previous crash/restart)
    (async () => {
      try {
        const { semanticDb } = await import('./db/knex');
        const stale = await semanticDb('connections')
          .where('profiling_status', 'running')
          .update({
            profiling_status: 'error',
            profiling_phase: 'error',
            profiling_message: 'Profiling was interrupted by a server restart',
            profiling_progress: 0,
          });
        if (stale > 0) console.log(`[startup] Reset ${stale} stale profiling job(s)`);

        // Same treatment for product_tables: any row pinned to 'running' at
        // startup must be from a previous worker that died mid-transformation.
        const staleTables = await semanticDb('product_tables')
          .where('transformation_status', 'running')
          .update({
            transformation_status: 'error',
            last_run_at: new Date().toISOString(),
            last_run_error: 'Run interrupted by worker restart',
          });
        if (staleTables > 0) console.log(`[startup] Reset ${staleTables} stuck product_table run(s)`);

        // Also close out any transformation_runs left in 'running' state.
        const staleRuns = await semanticDb('transformation_runs')
          .where('status', 'running')
          .update({
            status: 'failed',
            error_message: 'Run interrupted by worker restart',
            finished_at: new Date(),
          });
        if (staleRuns > 0) console.log(`[startup] Closed ${staleRuns} orphaned transformation run(s)`);

        // One-time backfill for dim_date rows in non-first products. Older
        // rows were inserted with transformation_sql=null but no
        // is_shared_dimension flag — see busMatrixBuilder.ts. Without that
        // flag the runner tries to materialize them and crashes with
        // "AS null" syntax errors. Scope is dim_date specifically; any other
        // null-sql dim row should still surface as a real authoring error.
        const flagged = await semanticDb('product_tables')
          .where({ table_role: 'dimension', table_name: 'dim_date' })
          .whereNull('transformation_sql')
          .where((qb) => qb.whereNull('is_shared_dimension').orWhere('is_shared_dimension', false))
          .update({ is_shared_dimension: true });
        if (flagged > 0) console.log(`[startup] Backfilled is_shared_dimension=true on ${flagged} dim_date stub row(s)`);
      } catch { /* non-fatal */ }
    })();

    // Auto-approve stale AI drafts — run once after a 30s delay to let the app settle
    setTimeout(async () => {
      try {
        const { autoApproveAllTenants } = await import('./services/autoApproveService');
        const count = await autoApproveAllTenants();
        if (count > 0) console.log(`[startup] Auto-approved ${count} stale AI draft(s)`);
      } catch { /* non-fatal */ }
    }, 30_000);

    // Stale ingestion/profiling cleanup — mark any stuck in 'running' for >30min as failed.
    // Runs every 5 minutes.
    setInterval(async () => {
      try {
        const { semanticDb } = await import('./db/knex');
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const staleIngestion = await semanticDb('connections')
          .where('ingestion_status', 'running')
          .where('created_at', '<', thirtyMinAgo)
          .update({
            ingestion_status: 'error',
            ingestion_error: 'Ingestion timed out (>30 minutes)',
          });
        if (staleIngestion > 0) console.log(`[cleanup] Marked ${staleIngestion} stale ingestion(s) as failed`);

        const staleProfiling = await semanticDb('connections')
          .where('profiling_status', 'running')
          .whereNotNull('profiling_started_at')
          .whereRaw("profiling_started_at < NOW() - INTERVAL '30 minutes'")
          .update({
            profiling_status: 'error',
            profiling_phase: 'error',
            profiling_message: 'Profiling timed out (>30 minutes)',
            profiling_progress: 0,
          });
        if (staleProfiling > 0) console.log(`[cleanup] Marked ${staleProfiling} stale profiling job(s) as failed`);
      } catch { /* non-fatal */ }
    }, 5 * 60 * 1000);
  });

  async function shutdown() {
    server.close();
    await drainPool();
    await drainDuckDBPool();
    await stopWorkers();
    await closeScheduler();
    await closeQueues();
    await closeRedis();
    await closeDriver();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default app;
