import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

import { ensureNeo4jConstraints, closeDriver } from './db/neo4j';

import { USERS, signToken, requireAuth, requireRole } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import connectionsRouter  from './routes/connections';
import semanticRouter     from './routes/semantic';
import queryRouter        from './routes/query';
import reportsRouter      from './routes/reports';
import dashboardsRouter   from './routes/dashboards';
import crossViewsRouter   from './routes/cross-views';
import qualityRouter      from './routes/quality';

const app = express();
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth endpoints (no token required)
// ---------------------------------------------------------------------------

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  const user = USERS[username];

  if (!user || user.password !== password) {
    res.status(401).json({ ok: false, error: 'Invalid username or password' });
    return;
  }

  const token = signToken({ sub: username, username, role: user.role });
  res.json({ ok: true, data: { token, role: user.role, username } });
});

// GET /api/auth/me — returns current user info
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, data: req.user });
});

// ---------------------------------------------------------------------------
// Feature routes (all require JWT)
// ---------------------------------------------------------------------------

app.use('/api/connections',  connectionsRouter);
app.use('/api/semantic',     semanticRouter);
app.use('/api/query',        queryRouter);
app.use('/api/reports',      reportsRouter);
app.use('/api/dashboards',   dashboardsRouter);
app.use('/api/cross-views',  crossViewsRouter);
app.use('/api/quality',      qualityRouter);

// Admin-only: re-run schema profiling for an existing connection
app.post('/api/connections/:id/profile', requireAuth, requireRole('epicdata_admin'), async (req, res, next) => {
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 3001);
const server = app.listen(PORT, () => {
  console.log(`DataBridge backend running on http://localhost:${PORT}`);
  // Start Neo4j constraint setup in the background — non-blocking.
  ensureNeo4jConstraints().catch(err => console.error('Neo4j constraint setup error:', err));
});

process.on('SIGTERM', async () => {
  server.close();
  await closeDriver();
});
process.on('SIGINT', async () => {
  server.close();
  await closeDriver();
});

export default app;
