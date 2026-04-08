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
import jobsRouter         from './routes/jobs';
import schedulesRouter    from './routes/schedules';
import usersRouter        from './routes/users';
import conversationsRouter from './routes/conversations';
import notificationsRouter from './routes/notifications';
import { startWorkers, stopWorkers } from './jobs/workers';
import { closeQueues } from './jobs/queues';
import { closeRedis } from './jobs/redis';
import { loadSchedules, closeScheduler } from './jobs/scheduler';
import { drainPool } from './connectors/ConnectorPool';

const app = express();

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
app.use('/api/jobs',         jobsRouter);
app.use('/api/schedules',   schedulesRouter);
app.use('/api/users',       usersRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/notifications', notificationsRouter);

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

// Temporary debug endpoint — tests DuckDB Azure blob connectivity step by step
app.get('/api/debug/duckdb', async (_req, res) => {
  const steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }> = [];
  let db: any = null;
  try {
    const { Database } = await import('duckdb-async');
    const t0 = Date.now();
    db = await Database.create(':memory:');
    steps.push({ step: 'create_db', ok: true, ms: Date.now() - t0 });

    const t1 = Date.now();
    try { await db.exec('LOAD delta;'); } catch { await db.exec('INSTALL delta; LOAD delta;'); }
    steps.push({ step: 'load_delta', ok: true, ms: Date.now() - t1 });

    const t2 = Date.now();
    try { await db.exec('LOAD azure;'); } catch { await db.exec('INSTALL azure; LOAD azure;'); }
    steps.push({ step: 'load_azure', ok: true, ms: Date.now() - t2 });

    // Check DuckDB version
    const verRows = await db.all('SELECT version() as v');
    steps.push({ step: 'version', ok: true, ms: 0, detail: (verRows[0] as any).v });

    // Check if curl transport is supported
    const t3 = Date.now();
    try {
      await db.exec("SET azure_transport_option_type = 'curl';");
      steps.push({ step: 'set_curl_transport', ok: true, ms: Date.now() - t3 });
    } catch (e: any) {
      steps.push({ step: 'set_curl_transport', ok: false, ms: Date.now() - t3, detail: e.message });
    }

    // Check cert paths
    const fs = await import('fs');
    const certPaths = [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
    ];
    for (const p of certPaths) {
      steps.push({ step: `cert_exists:${p}`, ok: fs.existsSync(p), ms: 0 });
    }

    // Create Azure secret
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING ?? '';
    if (connStr) {
      const t4 = Date.now();
      const escaped = connStr.replace(/'/g, "''");
      await db.exec(`CREATE SECRET azure_secret (TYPE AZURE, CONNECTION_STRING '${escaped}');`);
      steps.push({ step: 'create_secret', ok: true, ms: Date.now() - t4 });

      // Try a delta_scan with 30s timeout
      const testPath = _req.query.path as string;
      if (testPath) {
        const t5 = Date.now();
        try {
          const result = await Promise.race([
            db.all(`SELECT COUNT(*) as cnt FROM delta_scan('${testPath.replace(/'/g, "''")}')`),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 30s')), 30000)),
          ]);
          steps.push({ step: 'delta_scan', ok: true, ms: Date.now() - t5, detail: JSON.stringify(result) });
        } catch (e: any) {
          steps.push({ step: 'delta_scan', ok: false, ms: Date.now() - t5, detail: e.message });
        }
      }
    } else {
      steps.push({ step: 'create_secret', ok: false, ms: 0, detail: 'AZURE_STORAGE_CONNECTION_STRING not set' });
    }
  } catch (e: any) {
    steps.push({ step: 'unexpected_error', ok: false, ms: 0, detail: e.message });
  } finally {
    if (db) try { await db.close(); } catch {}
  }
  res.json({ steps });
});


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
      } catch { /* non-fatal */ }
    })();

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
