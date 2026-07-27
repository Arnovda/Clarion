// Monitoring must be imported BEFORE other modules for auto-instrumentation
import { initMonitoring, trackException } from './utils/monitoring';

// Patches Express 4's router so a throw (or rejected promise) inside an async
// route handler is forwarded to the error-handling middleware instead of
// becoming an unhandled rejection. Must be imported before the routers are
// built. Without it, an un-try/caught async throw in any of ~321 handlers
// escapes Express entirely and can crash the process.
import 'express-async-errors';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { requestLogger } from './middleware/requestLogger';
import { logger } from './utils/logger';
import { config } from './config';
import { runRetentionSweep } from './services/retention';

// Gate for the daily data-retention sweep (driven off the 5-min reaper tick).
let lastRetentionAt = 0;

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
import sourcesRouter                  from './routes/sources';
import connectionSyncSchedulesRouter   from './routes/connectionSyncSchedules';
import catalogRouter         from './routes/catalog';
import homeRouter            from './routes/home';
import buildRouter           from './routes/build';
import pulseRouter           from './routes/pulse';
import briefsRouter          from './routes/briefs';
import investigationsRouter  from './routes/investigations';
import aiUsageRouter         from './routes/aiUsage';
import aiRoutingRouter       from './routes/aiRouting';
import { startWorkers, stopWorkers } from './jobs/workers';
import { closeQueues } from './jobs/queues';
import { closeRedis } from './jobs/redis';
import { loadSchedules, closeScheduler } from './jobs/scheduler';
import { loadConnectionSyncSchedules } from './jobs/connectionSyncScheduler';
import { loadEmailSchedules } from './jobs/emailScheduler';
import { loadPipelineSchedules } from './jobs/pipelineScheduler';
import { startScheduleReconciler } from './jobs/scheduleReconciler';
import { subscribeToInvalidations, closeCacheBus } from './jobs/cacheBus';
import { drainPool } from './connectors/ConnectorPool';
import { drainAll as drainDuckDBPool } from './connectors/DuckDBPool';
import { drainRunners } from './services/warehouse/queryRunnerPool';

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
app.use(cors({ origin: config.corsOrigins, credentials: true }));

// Body parsing with size limits
app.use(express.json({ limit: '2mb' }));

// Structured request logging + request ID tracing
app.use(requestLogger);

// Rate limiters are disabled under the test runner so integration tests
// exercise business logic (400/401/etc.), not the limiter — a suite makes
// dozens of auth calls from one IP and would otherwise trip the 5/15-min
// brute-force window. No test asserts rate-limiting; if one is added, gate it
// on its own flag rather than removing this skip.
const skipRateLimit = (): boolean => process.env.NODE_ENV === 'test';

// Global rate limiter: 200 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       200,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:      skipRateLimit,
  message: { ok: false, error: 'Too many requests, please try again later' },
});
app.use(globalLimiter);

// Rate limit for /api/auth/* generally — refresh, me, etc. Generous
// because legitimate clients hit /refresh every 15min and a busy
// browser tab can issue several /me calls per second on startup.
const authLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       20,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:      skipRateLimit,
  message: { ok: false, error: 'Too many authentication attempts, please try again later' },
});

// MUCH stricter limit for the routes that an attacker would actually
// hammer in a brute-force attempt: login, forgot-password, reset-password.
// 5 attempts per 15-min window per IP makes brute-forcing impractical
// (a 6-char numeric password has 10^6 combinations → ~500 years at this
// rate) while still allowing a legitimate user who fumbles their password
// a few tries.
//
// Bypasses are still possible from a botnet (different IPs), which is
// why we ALSO have account lockout / monitoring on the application
// layer (audit_events action='login.fail' tracked separately).
const bruteForceLimiter = rateLimit({
  windowMs:  15 * 60 * 1000,
  max:       5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: 'Too many attempts. Please wait 15 minutes and try again.' },
  skip:      skipRateLimit,
  // Only count failed attempts so a legit user who logs in successfully
  // doesn't consume a "slot" needed for a retry on a typo.
  skipSuccessfulRequests: true,
});

// Strict rate limiter for AI-intensive endpoints: 30 per minute per IP
const aiLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       30,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:      skipRateLimit,
  message: { ok: false, error: 'AI rate limit reached, please try again shortly' },
});

// Compute-intensive endpoints that run DuckDB queries (dashboards batch-execute,
// notebooks, quality profiling). Looser than aiLimiter (these fire several
// widget queries per dashboard load) but still bounds a single IP from
// saturating the shared query engine. Separate store so it doesn't share the
// AI budget.
const computeLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       90,
  standardHeaders: true,
  legacyHeaders:   false,
  skip:      skipRateLimit,
  message: { ok: false, error: 'Too many requests, please slow down for a moment' },
});

// ---------------------------------------------------------------------------
// Auth routes (register, login, forgot-password, reset-password, refresh, me)
// ---------------------------------------------------------------------------

// Strict brute-force limiters apply to the specific routes BEFORE the
// general authLimiter. Order matters — express-rate-limit checks each
// middleware in the chain; the stricter one fires first.
app.use('/api/auth/login', bruteForceLimiter);
app.use('/api/auth/forgot-password', bruteForceLimiter);
app.use('/api/auth/reset-password', bruteForceLimiter);
app.use('/api/auth', authLimiter, authRouter);

// ---------------------------------------------------------------------------
// Feature routes (all require JWT — tenant context set automatically by requireAuth)
// ---------------------------------------------------------------------------

app.use('/api/connections',  connectionsRouter);
app.use('/api/semantic',     semanticRouter);
app.use('/api/query',        aiLimiter, queryRouter);
app.use('/api/reports',      reportsRouter);
app.use('/api/dashboards',   computeLimiter, dashboardsRouter);
app.use('/api/cross-views',  crossViewsRouter);
app.use('/api/quality',      computeLimiter, qualityRouter);
app.use('/api/ingestion',    ingestionRouter);
app.use('/api/products',     productsRouter);
app.use('/api/pipelines',    pipelinesRouter);
app.use('/api/jobs',         jobsRouter);
app.use('/api/schedules',   schedulesRouter);
app.use('/api/users',       usersRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/notebooks',     computeLimiter, notebooksRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/policies',        policiesRouter);
app.use('/api/settings',        settingsRouter);
app.use('/api/email-schedules', emailSchedulesRouter);
app.use('/api/source-types',    sourcesRouter);
// Same prefix as connections — the schedule routes hang off /:id under
// /api/connections so they share that namespace's auth/middleware/RLS.
app.use('/api/connections',     connectionSyncSchedulesRouter);
app.use('/api/catalog',         catalogRouter);
app.use('/api/home',            homeRouter);
app.use('/api/build',           buildRouter);
app.use('/api/pulse',           pulseRouter);
app.use('/api/briefs',          briefsRouter);
app.use('/api/investigations',  investigationsRouter);
app.use('/api/admin/ai-usage',  aiUsageRouter);
app.use('/api/admin/ai-routing', aiRoutingRouter);

// Admin-only: re-run schema profiling for an existing connection
app.post('/api/connections/:id/profile', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { runSchemaProfiler } = await import('./semantic/SchemaProfiler');
    const { tenantQuery } = await import('./services/tenantQuery');
    const tenantId = req.user?.tenantId;
    // Tenant-scoped fetch + delete: bare pool queries are RLS-filtered to
    // zero rows in production (silent no-op / docs-channel loss).
    const connection = await tenantQuery(tenantId, (trx) =>
      trx('connections').where({ id: req.params.id }).first(),
    );
    if (!connection) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }
    await tenantQuery(tenantId, (trx) =>
      trx('source_tables').where({ connection_id: connection.id }).delete(),
    );
    // SchemaProfiler builds its own connector from the connection record
    // via createConnector() — no filepath parameter needed since we
    // standardised on connector-based introspection for every source type.
    const result = await runSchemaProfiler(connection.id as number, undefined, undefined, { connection });
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
  const PORT = config.port;
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Clarion backend running');
    // Start Neo4j constraint setup in the background — non-blocking.
    ensureNeo4jConstraints().catch(err => logger.error({ err }, 'Neo4j constraint setup error'));

    // Listen for cache invalidations published by other processes. BOTH roles
    // need this: the API applies invalidations raised by the worker (otherwise
    // it serves pre-refresh widget rows, stale filter options and pooled DuckDB
    // views over the old file set), and the worker stays consistent too.
    subscribeToInvalidations();

    // ROLE splits this image into two deployments without a second build:
    //   ROLE=api     → HTTP only. No workers, schedules, recovery or reapers.
    //   ROLE=worker  → background work only (it still listens, but nothing
    //                  routes traffic to it — that just gives it a health port).
    //   unset        → both, i.e. today's single-process behaviour. Local dev
    //                  and any deployment that hasn't split yet are unchanged.
    //
    // Everything below this guard is owned by exactly ONE process on purpose.
    // The crash-recovery block and the 5-minute reaper mark rows stuck in
    // 'running' as failed using only an age test — no owner or heartbeat. If
    // both containers ran them they would race, and an API restart would mark a
    // healthy worker's in-flight work as failed. The worker owns them because
    // it owns the work they clean up after.
    const role = (process.env.ROLE ?? '').trim().toLowerCase();
    const runsJobs = role !== 'api';
    if (!runsJobs) {
      logger.info({ role }, 'ROLE=api — background jobs, schedules and reapers are handled by the jobs-worker');
      return;
    }

    // Start BullMQ workers (no-op if Redis not configured)
    startWorkers();
    // Load scheduled transformations from DB into BullMQ
    loadSchedules().catch(err => logger.error({ err }, 'Schedule loading error'));
    // Load email report schedules from DB into BullMQ
    loadEmailSchedules().catch(err => logger.error({ err }, 'Email schedule loading error'));
    // Load connection sync schedules from DB into BullMQ
    loadConnectionSyncSchedules().catch(err => logger.error({ err }, 'Connection sync schedule loading error'));
    // Load pipeline cron triggers from DB into BullMQ. on-source-sync
    // triggers are evaluated in-process in SyncOrchestrator; nothing to
    // pre-load for those.
    loadPipelineSchedules().catch(err => logger.error({ err }, 'Pipeline schedule loading error'));
    // Redis holds the repeatable-job registrations but Postgres is the source of
    // truth. If Redis restarts without the API restarting, the repeatables are
    // gone and cron work stops silently — this re-registers them on reconnect.
    startScheduleReconciler();

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
        if (stale > 0) logger.info(`[startup] Reset ${stale} stale profiling job(s)`);

        // Same treatment for product_tables: any row pinned to 'running' at
        // startup must be from a previous worker that died mid-transformation.
        const staleTables = await semanticDb('product_tables')
          .where('transformation_status', 'running')
          .update({
            transformation_status: 'error',
            last_run_at: new Date().toISOString(),
            last_run_error: 'Run interrupted by worker restart',
          });
        if (staleTables > 0) logger.info(`[startup] Reset ${staleTables} stuck product_table run(s)`);

        // Also close out any transformation_runs left in 'running' state.
        const staleRuns = await semanticDb('transformation_runs')
          .where('status', 'running')
          .update({
            status: 'failed',
            error_message: 'Run interrupted by worker restart',
            finished_at: new Date(),
          });
        if (staleRuns > 0) logger.info(`[startup] Closed ${staleRuns} orphaned transformation run(s)`);

        // Source-connector syncs (ExactOnline, Odoo, …): a worker that died
        // between status='running' and a terminal update leaves the row
        // pinned 'running'. The SyncOrchestrator's in-flight guard then keeps
        // returning that zombie run and refuses to start a new sync — the
        // connection becomes permanently un-syncable. Close out any
        // queued/running rows from before this restart so the next trigger
        // can proceed. (The worker process itself was killed with the parent.)
        const staleSyncs = await semanticDb('source_sync_runs')
          .whereIn('status', ['queued', 'running'])
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Sync was interrupted by a server restart',
          });
        if (staleSyncs > 0) {
          logger.info(`[startup] Closed ${staleSyncs} interrupted source sync run(s)`);
          // Keep the connection's denormalised status in step with the runs.
          await semanticDb('connections')
            .whereIn('last_sync_status', ['queued', 'running'])
            .update({ last_sync_status: 'failed' });
        }

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
        if (flagged > 0) logger.info(`[startup] Backfilled is_shared_dimension=true on ${flagged} dim_date stub row(s)`);

        // One-time repair for the inverted is_shared_dimension flag. Older
        // bus-matrix builds inserted OWNED dims with is_shared_dimension=true
        // (matching the AI proposal's semantic of "true=owner") but the
        // runner reads true as "stub; skip." The mismatch caused dims to
        // never be materialised and delta_path to stay null, breaking the
        // catalog preview ("No data yet…"). Heuristic for misclassified
        // owners: is_shared_dimension=true with non-empty transformation_sql.
        // True stubs always have null/empty SQL.
        const repaired = await semanticDb('product_tables')
          .where({ table_role: 'dimension', is_shared_dimension: true })
          .whereNot('table_name', 'dim_date')
          .whereNotNull('transformation_sql')
          .where('transformation_sql', '!=', '')
          .update({ is_shared_dimension: false });
        if (repaired > 0) {
          logger.info(
            `[startup] Repaired is_shared_dimension flag on ${repaired} owned ` +
            `dim row(s) (had non-null SQL but were flagged as stubs). ` +
            `Re-run the refresh pipeline to materialise their parquet.`,
          );
        }
      } catch { /* non-fatal */ }
    })();

    // Auto-approve stale AI drafts — run once after a 30s delay to let the app settle
    setTimeout(async () => {
      try {
        const { autoApproveAllTenants } = await import('./services/autoApproveService');
        const count = await autoApproveAllTenants();
        if (count > 0) logger.info(`[startup] Auto-approved ${count} stale AI draft(s)`);
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
        if (staleIngestion > 0) logger.info(`[cleanup] Marked ${staleIngestion} stale ingestion(s) as failed`);

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
        if (staleProfiling > 0) logger.info(`[cleanup] Marked ${staleProfiling} stale profiling job(s) as failed`);

        // Source-connector syncs stuck >30min. Mirrors the ingestion/profiling
        // reaper. Without this a worker that hangs (no terminal event, no
        // crash) keeps source_sync_runs 'running' forever and the in-flight
        // guard blocks every future sync of that connection. Uses
        // coalesce(started_at, queued_at) so a job that never started still
        // ages out.
        const staleSyncRuns = await semanticDb('source_sync_runs')
          .whereIn('status', ['queued', 'running'])
          .whereRaw("COALESCE(started_at, queued_at) < NOW() - INTERVAL '30 minutes'")
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: 'Sync timed out (>30 minutes)',
          });
        if (staleSyncRuns > 0) {
          logger.info(`[cleanup] Marked ${staleSyncRuns} stale source sync run(s) as failed`);
          await semanticDb('connections')
            .whereIn('last_sync_status', ['queued', 'running'])
            .whereRaw(`NOT EXISTS (
              SELECT 1 FROM source_sync_runs s
              WHERE s.connection_id = connections.id
                AND s.status IN ('queued','running')
            )`)
            .update({ last_sync_status: 'failed' });
        }

        // Retention: source_sync_runs grows unbounded otherwise (every
        // scheduled sync adds a fat row with log_excerpt + JSONB counts).
        // Keep terminal runs for 90 days; never delete in-flight rows.
        const SYNC_RUN_RETENTION_DAYS = Number(process.env.SYNC_RUN_RETENTION_DAYS) || 90;
        const prunedSyncRuns = await semanticDb('source_sync_runs')
          .whereIn('status', ['succeeded', 'failed', 'cancelled'])
          .whereRaw(`COALESCE(completed_at, queued_at) < NOW() - (? * INTERVAL '1 day')`, [SYNC_RUN_RETENTION_DAYS])
          .del();
        if (prunedSyncRuns > 0) logger.info(`[cleanup] Pruned ${prunedSyncRuns} source sync run(s) older than ${SYNC_RUN_RETENTION_DAYS}d`);

        // Data-retention sweep — the heavier age-based deletes on the
        // append-only tables (notifications/ai_call_log by default;
        // query_log/conversations opt-in). Driven off this reaper tick but
        // gated to run at most once per 24h so it doesn't fire every 5 min.
        if (Date.now() - lastRetentionAt > 24 * 60 * 60 * 1000) {
          lastRetentionAt = Date.now();
          await runRetentionSweep(semanticDb);
        }
      } catch { /* non-fatal */ }
    }, 5 * 60 * 1000);
  });

  async function shutdown() {
    server.close();
    await drainPool();
    await drainDuckDBPool();
    drainRunners();
    await stopWorkers();
    await closeScheduler();
    await closeQueues();
    await closeCacheBus();
    await closeRedis();
    await closeDriver();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Process-level safety net. Registered only in the running server (not under
  // the test runner). express-async-errors routes route-handler throws to the
  // error middleware, so anything reaching here is a genuinely unhandled
  // async path (a stray fire-and-forget promise, a bug outside a request).
  //
  //   • unhandledRejection — log loudly + report; do NOT exit. Most are
  //     non-fatal background tasks, and Node would otherwise crash the whole
  //     server for one stray rejection. Surfacing it is what matters.
  //   • uncaughtException — the process state is undefined per the Node docs;
  //     log, attempt a best-effort graceful shutdown, then exit non-zero so
  //     the orchestrator restarts a clean process.
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err }, 'unhandledRejection — a promise rejected with no catch');
    trackException(err);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException — process state is undefined, shutting down');
    trackException(err);
    void shutdown().finally(() => process.exit(1));
  });
}

export default app;
