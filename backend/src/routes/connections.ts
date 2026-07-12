import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { z } from 'zod';
import {
  createAdapterLogger,
  getConnector,
  ConfigValidationError,
  validateConnectorConfig,
} from '@databridge/connectors';
import { requireAuth, requireRole } from '../middleware/auth';
import { recordAudit } from '../services/auditService';
import { reqDb } from '../db/reqDb';
import { tenantScopedWrite } from '../db/tenantScopedWrite';
import { createConnector, createSourceConnector, testConnector, SUPPORTED_TYPES } from '../connectors/ConnectorFactory';
import {
  deleteWarehousePaths,
  productBasePath,
  productBasePathV2,
  productSlug as toProductSlug,
} from '../services/warehouse';
import { listProductTables } from '../services/tableCatalog';
import { runSchemaProfiler } from '../semantic/SchemaProfiler';
import { encryptCredentials, decryptCredentials } from '../utils/crypto';
import { validate } from '../middleware/validate';
import { testConnectionSchema, createConnectionSchema, updateConnectionSchema } from '../middleware/schemas';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'connections' });

const router = Router();

// POST /api/connections/test — test a source connection without saving it
router.post('/test', requireAuth, requireRole('admin'), validate(testConnectionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, config } = req.body as { type: string; config: Record<string, unknown> };
    if (!SUPPORTED_TYPES.includes(type as any)) {
      res.status(400).json({ ok: false, error: `Unsupported connection type: ${type}. Supported: ${SUPPORTED_TYPES.join(', ')}` });
      return;
    }
    const result = await testConnector(type, config);
    res.json({ ok: result.ok, data: { message: result.message } });
  } catch (err) {
    next(err);
  }
});

// POST /api/connections — create a connection and run schema profiling
router.post('/', requireAuth, requireRole('admin'), validate(createConnectionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);   // tenant-scoped per-request transaction
    const { name, type, config, domains } = req.body as {
      name: string;
      type: string;
      config: Record<string, unknown>;
      domains?: string[];
    };

    if (!SUPPORTED_TYPES.includes(type as any)) {
      res.status(400).json({ ok: false, error: `Unsupported connection type: ${type}. Supported: ${SUPPORTED_TYPES.join(', ')}` });
      return;
    }

    // Test before saving
    const test = await testConnector(type, config);
    if (!test.ok) {
      res.status(400).json({ ok: false, error: test.message });
      return;
    }

    // Encrypt credentials before storing
    const configJson = JSON.stringify(config);
    const encryptedConfig = encryptCredentials(configJson);

    // Wrap encrypted string in a JSON object so it's valid JSONB
    const configForDb = JSON.stringify({ encrypted: encryptedConfig });

    const [row] = await db('connections')
      .insert({
        tenant_id: req.user!.tenantId,
        name,
        type,
        config: configForDb,
        domains: JSON.stringify(domains ?? []),
        created_by: req.user!.email ?? 'unknown',
      })
      .returning('id');

    const connectionId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);

    await recordAudit(req, {
      action:     'connection.create',
      entityType: 'connection',
      entityId:   connectionId,
      context:    { name, type, domains: domains ?? [] },
    });

    // Do NOT run schema profiling here — the frontend will trigger it via
    // POST /:id/profile with SSE so the user sees real-time progress.
    res.status(201).json({ ok: true, data: { connectionId } });
  } catch (err) {
    next(err);
  }
});

// POST /api/connections/source — create a source-system connection
//
// Used by the new "Add source" wizard for ExactOnline / NetSuite / etc.
// Distinct from POST /api/connections (which is for direct-DB connections):
//   • the runtime query side is always DuckDB (reads warehouse Parquet files)
//   • there's no schema profiling on save — that runs after the first sync
//     lands data
//   • credentials are connector-specific JSON, validated by the connector's
//     own JSON Schema, not the SQL-driver shape
//
// Accepts EITHER inline `config` (paste-token flow) OR `oauthStateToken`
// (OAuth flow — the full config lives encrypted in `oauth_pending`).
const createSourceConnectionSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    connectorType: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()).optional(),
    oauthStateToken: z.string().optional(),
    selectedEntities: z.array(z.string()).min(1, 'Pick at least one entity'),
    domains: z.array(z.string()).optional(),
  }).refine((v) => !!v.config || !!v.oauthStateToken, {
    message: 'Body must include either `config` or `oauthStateToken`',
  }),
});
router.post(
  '/source',
  requireAuth,
  requireRole('admin'),
  validate(createSourceConnectionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const { name, connectorType, config: inlineConfig, oauthStateToken, selectedEntities, domains } =
        req.body as {
          name: string;
          connectorType: string;
          config?: Record<string, unknown>;
          oauthStateToken?: string;
          selectedEntities: string[];
          domains?: string[];
        };

      // Resolve the connector — 404 if the type isn't registered.
      let connector;
      try {
        connector = getConnector(connectorType);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Unknown connector type')) {
          res.status(404).json({ ok: false, error: e.message });
          return;
        }
        throw e;
      }

      // Resolve the config: inline OR via oauth_pending lookup.
      let config: Record<string, unknown>;
      let oauthRowId: number | null = null;
      if (oauthStateToken) {
        const row = await db('oauth_pending')
          .where({
            state_token: oauthStateToken,
            connector_type: connectorType,
            tenant_id: req.user!.tenantId,
            initiated_by_user_id: req.user!.sub,
          })
          .first();
        if (!row) {
          res.status(404).json({ ok: false, error: 'Unknown or already-consumed stateToken' });
          return;
        }
        if (row.status !== 'authorised') {
          res.status(400).json({ ok: false, error: 'OAuth flow not complete — finish the connect step first' });
          return;
        }
        if (new Date(row.expires_at).getTime() < Date.now()) {
          res.status(400).json({ ok: false, error: 'OAuth session expired — re-run the Connect step' });
          return;
        }
        config = JSON.parse(decryptCredentials(row.encrypted_config));
        oauthRowId = row.id;
      } else {
        config = inlineConfig!;
      }

      // Re-validate credentials before saving. The wizard already calls
      // testConnection but we don't trust client state — repeat here so a
      // skipped wizard-step or stale tab can't store bad creds.
      const probeLog = createAdapterLogger(
        logger.child({
          mod: 'create-source-connection',
          connector: connectorType,
          tenantId: req.user?.tenantId,
        }),
      );
      let testResult;
      try {
        testResult = await connector.testConnection(config, { log: probeLog });
      } catch (e) {
        if (e instanceof ConfigValidationError) {
          res.status(400).json({ ok: false, error: e.message });
          return;
        }
        throw e;
      }
      if (!testResult.ok) {
        res.status(400).json({ ok: false, error: testResult.error ?? 'Credentials rejected' });
        return;
      }

      // Encrypt the connector config. Stored as bare TEXT (ciphertext is
      // already opaque — no need to wrap in JSON).
      const encrypted = encryptCredentials(JSON.stringify(config));

      // Save the connection. `type='duckdb'` because the QUERY side will
      // read the warehouse Parquet files via DuckDB (matches the pattern
      // every other warehouse-backed connection uses).
      const [row] = await db('connections')
        .insert({
          tenant_id: req.user!.tenantId,
          name,
          type: 'duckdb',
          // Direct-DB `config` column unused for source connections, but the
          // existing schema requires it (NOT NULL). Empty config object is fine.
          config: JSON.stringify({}),
          connector_type: connectorType,
          connector_config_encrypted: encrypted,
          selected_entities: selectedEntities,
          domains: JSON.stringify(domains ?? []),
          created_by: req.user!.email ?? 'unknown',
        })
        .returning('id');

      const connectionId: number =
        typeof row === 'object' ? (row as { id: number }).id : (row as number);

      // Consume the oauth_pending row — the persistent connection's
      // `connector_config_encrypted` takes over from here. Delete-after-use
      // means the stateToken can't be replayed even if it leaks.
      if (oauthRowId !== null) {
        await db('oauth_pending').where({ id: oauthRowId }).del();
      }

      // No schema profiling here — there's no data yet. The first sync will
      // populate the warehouse, and the orchestrator will trigger profiling
      // automatically on completion (Day 5+).
      res.status(201).json({
        ok: true,
        data: { connectionId, testDetails: testResult.details },
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/connections — list this tenant's connections
router.get('/', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    // Explicit tenant filter — Postgres RLS would catch this too in the
    // dual-role deployment, but the prod single-role deployment skips RLS,
    // so application-layer scoping is mandatory. Defence in depth either way.
    const rows = await db('connections')
      .where('tenant_id', req.user!.tenantId)
      .select('*')
      .orderBy('created_at', 'desc');
    // Strip encrypted config secrets from the response — only send type + non-sensitive info
    const sanitized = rows.map((r: Record<string, unknown>) => {
      const config = typeof r.config === 'string'
        ? (() => { try { return JSON.parse(r.config as string); } catch { return {}; } })()
        : r.config;
      // Mask passwords in the response
      const safeConfig = { ...config };
      if (safeConfig.password) safeConfig.password = '••••••••';
      // Strip the encrypted source-connector config — never send ciphertext to the browser.
      const sanitizedRow = { ...r, config: safeConfig };
      delete (sanitizedRow as Record<string, unknown>).connector_config_encrypted;
      return sanitizedRow;
    });
    res.json({ ok: true, data: sanitized });
  } catch (err) {
    next(err);
  }
});

// ─── Source-connection sync routes ────────────────────────────────────────
// Trigger a sync, list sync history, poll a single sync run, request cancellation.
// All gated by tenant-scoped RLS via the existing middleware stack.

// POST /api/connections/:id/sync — trigger a sync of the selected entities
router.post(
  '/:id/sync',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ ok: false, error: 'Invalid connection id' });
        return;
      }
      const { triggerSync } = await import('../orchestrator/SyncOrchestrator');
      const result = await triggerSync({
        connectionId: id,
        tenantId: req.user!.tenantId,
        triggeredByUserId: req.user!.sub,
      });
      res.status(202).json({ ok: true, data: result });
    } catch (err) {
      // User-input errors (no entities, no connector_type) → 400 not 500.
      const msg = err instanceof Error ? err.message : 'Failed to trigger sync';
      if (
        msg.includes('not found') ||
        msg.includes('not a source-connector') ||
        msg.includes('no selected entities')
      ) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      next(err);
    }
  },
);

// GET /api/connections/:id/sync-runs?limit=N — list sync history for a connection
router.get(
  '/:id/sync-runs',
  requireAuth,
  requireRole('admin', 'analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const id = Number(req.params.id);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const rows = await db('source_sync_runs')
        .where({ connection_id: id, tenant_id: req.user!.tenantId })
        .orderBy('id', 'desc')
        .limit(limit);
      res.json({ ok: true, data: rows });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/connections/:id/sync-runs/:syncRunId — poll a single run (for live UI status)
router.get(
  '/:id/sync-runs/:syncRunId',
  requireAuth,
  requireRole('admin', 'analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const syncRunId = Number(req.params.syncRunId);
      const row = await db('source_sync_runs')
        .where({ id: syncRunId, tenant_id: req.user!.tenantId })
        .first();
      if (!row) {
        res.status(404).json({ ok: false, error: 'Sync run not found' });
        return;
      }
      res.json({ ok: true, data: row });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/connections/:id/sync/:syncRunId/cancel — request cancellation
router.post(
  '/:id/sync/:syncRunId/cancel',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const syncRunId = Number(req.params.syncRunId);
      const { requestCancellation } = await import('../orchestrator/SyncOrchestrator');
      // Pass tenantId — registry validates the run belongs to this tenant.
      const result = requestCancellation(syncRunId, req.user!.tenantId);
      if (result === 'forbidden' || result === 'not_found') {
        // Treat both the same to avoid leaking which sync_run_ids exist
        // for other tenants.
        res.status(404).json({ ok: false, error: 'Sync run not found' });
        return;
      }
      // Worker / orchestrator picks up the flag and writes status='cancelled' itself.
      res.json({ ok: true, data: { requested: true } });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/connections/:id — update name and/or config
router.patch('/:id', requireAuth, requireRole('admin'), validate(updateConnectionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { name, config, domains } = req.body as { name?: string; config?: Record<string, unknown>; domains?: string[] };
    const updates: Record<string, unknown> = {};
    if (name) updates.name = name;
    if (config) {
      updates.config = encryptCredentials(JSON.stringify(config));
    }
    if (domains !== undefined) updates.domains = JSON.stringify(domains);

    const updated = await db('connections').where({ id: req.params.id }).update(updates);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    await recordAudit(req, {
      action:     'connection.update',
      entityType: 'connection',
      entityId:   Number(req.params.id),
      context:    { fields_changed: Object.keys(updates) },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/connections/:id/source-config — return decrypted source-connector config for editing
router.get('/:id/source-config', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const row = await db('connections').where({ id: req.params.id }).first();
    if (!row) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }
    if (!row.connector_type || !row.connector_config_encrypted) {
      res.status(400).json({ ok: false, error: 'Not a source-connector connection' });
      return;
    }
    const decrypted = JSON.parse(decryptCredentials(row.connector_config_encrypted));
    const redacted = { ...decrypted };
    for (const key of Object.keys(redacted)) {
      if (/(secret|password|token|apikey|api_key)/i.test(key)) {
        if (redacted[key]) redacted[key] = '••••••••';
      }
    }
    res.json({ ok: true, data: redacted });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/connections/:id/source-config — update source-connector config
router.patch('/:id/source-config', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { config } = req.body as { config: Record<string, unknown> };
    if (!config || typeof config !== 'object') {
      res.status(400).json({ ok: false, error: 'config object is required' });
      return;
    }
    const row = await db('connections').where({ id: req.params.id }).first();
    if (!row) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }
    if (!row.connector_type || !row.connector_config_encrypted) {
      res.status(400).json({ ok: false, error: 'Not a source-connector connection' });
      return;
    }
    const existing = JSON.parse(decryptCredentials(row.connector_config_encrypted));
    const merged = { ...existing };
    for (const [key, value] of Object.entries(config)) {
      if (value === '••••••••') continue;
      merged[key] = value;
    }

    // Validate the merged config against the connector's JSON Schema BEFORE
    // persisting. Without this, a malformed edit (extra props, wrong types,
    // dropped required fields) was written straight to the encrypted cell and
    // only blew up deep inside the next sync's worker.
    const validation = validateConnectorConfig(row.connector_type, merged);
    if (!validation.ok) {
      res.status(400).json({ ok: false, error: `Invalid config: ${validation.errors.join('; ')}` });
      return;
    }

    const encrypted = encryptCredentials(JSON.stringify(merged));
    await db('connections').where({ id: req.params.id }).update({
      connector_config_encrypted: encrypted,
    });

    await recordAudit(req, {
      action:     'connection.update_source_config',
      entityType: 'connection',
      entityId:   Number(req.params.id),
      context:    { connector_type: row.connector_type },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/connections/:id/oauth-reconnect — re-authenticate an OAuth connection
// Takes an oauthStateToken from a completed OAuth flow and updates the stored config
// with the fresh tokens, preserving non-auth fields (division, selected_entities, etc.).
router.post('/:id/oauth-reconnect', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { oauthStateToken } = req.body as { oauthStateToken: string };
    if (!oauthStateToken) {
      res.status(400).json({ ok: false, error: 'oauthStateToken is required' });
      return;
    }
    const conn = await db('connections').where({ id: req.params.id }).first();
    if (!conn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }
    if (!conn.connector_type || !conn.connector_config_encrypted) {
      res.status(400).json({ ok: false, error: 'Not a source-connector connection' });
      return;
    }
    const oauthRow = await db('oauth_pending')
      .where({
        state_token: oauthStateToken,
        tenant_id: req.user!.tenantId,
        initiated_by_user_id: req.user!.sub,
        status: 'authorised',
      })
      .first();
    if (!oauthRow) {
      res.status(400).json({ ok: false, error: 'Invalid or expired OAuth session' });
      return;
    }
    const freshConfig = JSON.parse(decryptCredentials(oauthRow.encrypted_config));
    const encrypted = encryptCredentials(JSON.stringify(freshConfig));
    await db('connections').where({ id: req.params.id }).update({
      connector_config_encrypted: encrypted,
    });
    await db('oauth_pending').where({ id: oauthRow.id }).del();

    await recordAudit(req, {
      action:     'connection.oauth_reconnect',
      entityType: 'connection',
      entityId:   Number(req.params.id),
      context:    { connector_type: conn.connector_type },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Helper: compute profiling progress percentage from phase
const PROFILING_PHASES = ['schema', 'quality', 'ai_draft', 'storing', 'neo4j', 'done'] as const;
export function profilingProgressPct(phase: string, tableIndex?: number, tableCount?: number): number {
  // Each phase gets a weight — quality + ai_draft are heaviest
  const weights: Record<string, [number, number]> = {
    schema:   [0,  10],
    quality:  [10, 45],
    ai_draft: [45, 80],
    storing:  [80, 90],
    neo4j:    [90, 98],
    done:     [100, 100],
    error:    [0, 0],
  };
  const [start, end] = weights[phase] ?? [0, 0];
  if (phase === 'error') return 0;
  if (tableIndex != null && tableCount && tableCount > 0) {
    return Math.round(start + (end - start) * (tableIndex + 1) / tableCount);
  }
  return end;
}

// POST /api/connections/:id/profile — re-run schema profiling with SSE progress
router.post('/:id/profile', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const db = reqDb(req);
  const connectionId = Number(req.params.id);
  const connection = await db('connections').where({ id: connectionId }).first();
  if (!connection) {
    res.status(404).json({ ok: false, error: 'Connection not found' });
    return;
  }

  // Mark profiling as running in DB so other clients can see it
  await db('connections').where({ id: connectionId }).update({
    profiling_status: 'running',
    profiling_phase: 'schema',
    profiling_message: 'Starting profiling…',
    profiling_progress: 0,
    profiling_started_at: new Date().toISOString(),
  });

  // Persist progress to DB on every phase change
  const persistProgress = async (p: { phase: string; message: string; tableIndex?: number; tableCount?: number }) => {
    try {
      await db('connections').where({ id: connectionId }).update({
        profiling_phase: p.phase,
        profiling_message: p.message,
        profiling_progress: profilingProgressPct(p.phase, p.tableIndex, p.tableCount),
      });
    } catch { /* non-fatal — DB write failed but profiling continues */ }
  };

  // If client accepts SSE, stream progress events
  const wantsStream = req.headers.accept?.includes('text/event-stream');
  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const emit = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
    };

    try {
      let connectorOverride;
      if (connection.query_engine === 'duckdb' && connection.warehouse_path) {
        log.info(`[Profile] Connection ${connectionId}: using DuckDB connector (warehouse: ${connection.warehouse_path})`);
        connectorOverride = await createConnector(connection);
        await connectorOverride.connect();
        log.info(`[Profile] Connection ${connectionId}: DuckDB connected successfully`);
      } else {
        log.info(`[Profile] Connection ${connectionId}: using source connector (type: ${connection.type})`);
        connectorOverride = createSourceConnector(connection);
        await connectorOverride.connect();
        log.info(`[Profile] Connection ${connectionId}: source connector connected`);
      }

      const result = await runSchemaProfiler(connection.id, (p) => {
        log.info(`[Profile] Connection ${connectionId}: ${p.phase} — ${p.message}`);
        emit(p);
        persistProgress(p);
      }, connectorOverride);

      connectorOverride.disconnect();

      const doneMsg = `Done — ${result.tablesInserted} tables, ${result.columnsInserted} columns, ${result.relationshipsInserted} relationships`;
      emit({ phase: 'done', message: doneMsg, result });
      await db('connections').where({ id: connectionId }).update({
        profiling_status: 'done', profiling_phase: 'done',
        profiling_message: doneMsg, profiling_progress: 100,
        last_profiled_at: new Date().toISOString(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Profiling failed';
      log.error({ err }, `[Profile] Connection ${connectionId} profiling failed`);
      emit({ phase: 'error', message: errMsg });
      // Use a fresh tenantScopedWrite for the "mark errored" update —
      // the request trx may already be poisoned by the upstream failure,
      // and a `.catch(() => {})` on a poisoned-trx update silently
      // no-ops, leaving the connection stuck in 'profiling'.
      if (req.user?.tenantId) {
        try {
          await tenantScopedWrite(req.user.tenantId, (trx) =>
            trx('connections').where({ id: connectionId }).update({
              profiling_status: 'error', profiling_phase: 'error',
              profiling_message: errMsg, profiling_progress: 0,
            }),
          );
        } catch (markErr) {
          log.error({ err: markErr }, '[Profile] failed to mark profiling errored');
        }
      }
    }
    res.end();
  } else {
    // Fallback: synchronous JSON response for non-SSE clients
    try {
      let connectorOverride;
      if (connection.query_engine === 'duckdb' && connection.warehouse_path) {
        connectorOverride = await createConnector(connection);
      } else {
        connectorOverride = createSourceConnector(connection);
      }
      await connectorOverride.connect();

      const result = await runSchemaProfiler(connection.id, (p) => persistProgress(p), connectorOverride);

      connectorOverride.disconnect();

      await db('connections').where({ id: connectionId }).update({
        profiling_status: 'done', profiling_phase: 'done',
        profiling_message: `Done — ${result.tablesInserted} tables, ${result.columnsInserted} columns, ${result.relationshipsInserted} relationships`,
        profiling_progress: 100,
        last_profiled_at: new Date().toISOString(),
      });
      res.json({ ok: true, data: result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Profiling failed';
      // Same trx-poison rationale as the SSE branch above — fresh trx
      // for the diagnostic write.
      if (req.user?.tenantId) {
        try {
          await tenantScopedWrite(req.user.tenantId, (trx) =>
            trx('connections').where({ id: connectionId }).update({
              profiling_status: 'error', profiling_phase: 'error',
              profiling_message: errMsg, profiling_progress: 0,
            }),
          );
        } catch (markErr) {
          log.error({ err: markErr }, '[Profile] failed to mark profiling errored');
        }
      }
      res.status(500).json({ ok: false, error: errMsg });
    }
  }
});

// GET /api/connections/:id/profile/status — poll profiling progress
router.get('/:id/profile/status', requireAuth, async (req: Request, res: Response) => {
  const db = reqDb(req);
  const row = await db('connections')
    .where({ id: req.params.id })
    .select('profiling_status', 'profiling_phase', 'profiling_message', 'profiling_progress', 'profiling_started_at')
    .first();
  if (!row) {
    res.status(404).json({ ok: false, error: 'Connection not found' });
    return;
  }
  res.json({ ok: true, data: row });
});

/**
 * GET /api/connections/:id/schema-changes?limit=20
 *
 * Returns recent schema-drift detections for a connection, newest first.
 * Backs the "Recent schema changes" callout on /sources — the surface
 * the user lands on when they click the bell notification fired by
 * `runProfilerInBackground` in `SyncOrchestrator`.
 *
 * Each row carries the full diff JSONB so the frontend can render
 * per-table additions/removals without a second round-trip.
 */
router.get('/:id/schema-changes', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const connectionId = Number(req.params.id);
    if (!Number.isFinite(connectionId)) {
      return res.status(400).json({ ok: false, error: 'invalid connection id' });
    }
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await db('schema_changes')
      .where({ connection_id: connectionId, tenant_id: tenantId })
      .orderBy('detected_at', 'desc')
      .limit(limit)
      .select(
        'id', 'detected_at', 'summary', 'diff',
        'tables_added', 'tables_removed',
        'columns_added', 'columns_removed', 'columns_changed',
      );
    // Postgres returns JSONB as a parsed object via pg's automatic
    // type parser, but knex sometimes hands it back as a string
    // depending on driver version — normalise so the client can
    // always treat it as an object.
    const data = rows.map((r: { diff: unknown }) => ({
      ...r,
      diff: typeof r.diff === 'string' ? JSON.parse(r.diff) : r.diff,
    }));
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// POST /api/connections/:id/introspect — lightweight column refresh (no AI)
// Re-reads actual column names + types from the source database and updates
// source_columns rows. Preserves existing AI-generated descriptions.
router.post('/:id/introspect', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const connectionId = Number(req.params.id);
    const connection = await db('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    // Connect to the source database
    const connector = createSourceConnector(connection);
    await connector.connect();

    let schema: { tables: Array<{ tableName: string; columns: Array<{ name: string; type: string; sampleValues?: unknown[] }> }> };
    try {
      schema = await connector.introspectSchema();
    } finally {
      connector.disconnect();
    }

    let updatedCols = 0;
    let insertedCols = 0;

    for (const tbl of schema.tables) {
      // Find the matching source_table row
      const sourceTable = await db('source_tables')
        .where({ connection_id: connectionId, table_name: tbl.tableName, is_active: true })
        .first();
      if (!sourceTable) continue;

      for (const col of tbl.columns) {
        const existing = await db('source_columns')
          .where({ table_id: sourceTable.id, column_name: col.name })
          .first();

        if (existing) {
          // Update data_type and example_values if they changed
          await db('source_columns').where({ id: existing.id }).update({
            data_type: col.type,
            example_values: col.sampleValues ? JSON.stringify(col.sampleValues) : existing.example_values,
          });
          updatedCols++;
        } else {
          // New column discovered — insert with ai_draft flag
          await db('source_columns').insert({
            table_id:       sourceTable.id,
            column_name:    col.name,
            data_type:      col.type,
            display_name:   col.name,
            description:    null,
            example_values: col.sampleValues ? JSON.stringify(col.sampleValues) : null,
            is_dimension:   false,
            is_measure:     false,
            ai_draft:       true,
          });
          insertedCols++;
        }
      }
    }

    res.json({ ok: true, data: { tables: schema.tables.length, updatedColumns: updatedCols, newColumns: insertedCols } });
  } catch (err) { next(err); }
});

// GET /api/connections/freshness — freshness info for all connections + data products
router.get('/freshness', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    // Connection freshness
    const connections = await db('connections')
      .select('id', 'name', 'last_synced_at', 'last_profiled_at', 'last_ingested_at', 'created_at')
      .orderBy('name');

    // Latest transformation run per product (graceful — may not exist)
    let products: Record<string, unknown>[] = [];
    try {
      products = await db('data_products as dp')
        .leftJoin('transformation_schedules as ts', 'ts.product_id', 'dp.id')
        .leftJoin(
          db('transformation_runs')
            .select('schedule_id')
            .max('finished_at as last_run_at')
            .where('status', 'success')
            .groupBy('schedule_id')
            .as('tr'),
          'tr.schedule_id', 'ts.id'
        )
        .select('dp.id', 'dp.name', 'dp.created_at', 'tr.last_run_at')
        .groupBy('dp.id', 'dp.name', 'dp.created_at', 'tr.last_run_at')
        .orderBy('dp.name');
    } catch { /* data_products table may not exist yet */ }

    res.json({
      ok: true,
      data: {
        connections: connections.map((c: Record<string, unknown>) => ({
          id: c.id,
          name: c.name,
          last_synced_at: c.last_synced_at ?? c.last_ingested_at ?? null,
          last_profiled_at: c.last_profiled_at ?? null,
          created_at: c.created_at,
        })),
        products: products.map((p: Record<string, unknown>) => ({
          id: p.id,
          name: p.name,
          last_run_at: p.last_run_at ?? null,
          created_at: p.created_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/connections/:id — delete a connection and its semantic data
router.delete('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    const tenantId = req.user!.tenantId;

    // Fetch connection before deleting — need warehouse_path for cleanup
    const conn = await db('connections').where({ id }).first();
    if (!conn) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    // Get table IDs for this connection so we can cascade manually
    const tables = await db('source_tables').where({ connection_id: id }).select('id');
    const tableIds = tables.map((t: { id: number }) => t.id);

    // Collect every data_product that will be cascade-deleted when the
    // connection row goes. data_products.connection_id has ON DELETE
    // CASCADE, so the rows disappear silently — but the warehouse files
    // those products materialised on disk / in Blob do NOT. We resolve
    // and delete their URIs HERE, before the FK cascade fires, so we
    // don't orphan parquet/delta files.
    const dependentProducts = await db('data_products')
      .where({ connection_id: id })
      .select<{ id: number; name: string }[]>('id', 'name');
    const productWarehouseUris = new Set<string>();
    for (const dp of dependentProducts) {
      try {
        const resolved = await listProductTables(tenantId, dp.id);
        for (const t of resolved) if (t.uri) productWarehouseUris.add(t.uri);
      } catch (err) {
        log.warn({ err }, `[connections.delete] catalog lookup for product=${dp.id} failed`);
      }
      // Also the v2 product directory + v1 slug-based directory, same
      // as the product DELETE route. Catches v2 deployments where the
      // catalog rows might miss empty/never-written directories, AND
      // legacy v1 deployments where the catalog rows are gone.
      productWarehouseUris.add(productBasePathV2(tenantId, dp.id));
      productWarehouseUris.add(productBasePath(conn.warehouse_path ?? '', toProductSlug(dp.name)));
    }

    if (tableIds.length) {
      // Delete ALL relationships touching any of these tables (from or to)
      await db('table_relationships')
        .where(function () {
          this.whereIn('from_table_id', tableIds).orWhereIn('to_table_id', tableIds);
        })
        .delete();

      await db('source_columns').whereIn('table_id', tableIds).delete();
      await db('source_tables').whereIn('id', tableIds).delete();
    }

    await db('ingested_tables').where({ connection_id: id }).delete();
    await db('kpi_definitions').where({ connection_id: id }).delete();
    await db('dashboards').where({ connection_id: id }).delete();

    // notebooks.connection_id has NO ON DELETE action set (it predates
    // the cascade audit), so deleting a connection that has notebooks
    // pointing at it would fail with a FK violation. Unlink instead —
    // notebooks are user-owned analytical artifacts; the user keeps the
    // cells, they just lose the connection binding and need to repick
    // one before re-running SQL cells.
    await db('notebooks').where({ connection_id: id }).update({ connection_id: null });

    const deleted = await db('connections').where({ id }).delete();

    // Clean up the warehouse data files. Two roots to consider:
    //   - The connection's own ingested-table directory
    //     (`./warehouse/conn_<id>` or `az://warehouse/tenant_<tid>/conn_<id>`).
    //     This is where the ETL drops parquet for synced tables.
    //   - The product warehouse URIs collected earlier — one per
    //     dependent data_product that's about to be cascade-deleted.
    //     The DB cascade would silently leave these orphaned otherwise.
    // Best-effort — errors logged into the audit context, never block
    // the row deletion. Orphan blobs are recoverable; we'd rather have
    // some orphans than a half-deleted database state.
    const connWarehouseDir = conn.warehouse_path
      ?? path.resolve(__dirname, '../../../warehouse', `conn_${id}`);

    const allUris = [connWarehouseDir, ...productWarehouseUris];
    const warehouseResult = await deleteWarehousePaths(allUris);
    log.info(
      `connection=${id} deleted ${warehouseResult.deleted} warehouse file(s) ` +
      `(${warehouseResult.kind}) from ${allUris.length} candidate path(s) ` +
      `(${dependentProducts.length} dependent product(s) cascade-cleaned)`,
    );
    if (warehouseResult.errors.length > 0) {
      log.warn(
        { errors: warehouseResult.errors.slice(0, 5) },
        `connection=${id} warehouse cleanup had ${warehouseResult.errors.length} errors`,
      );
    }

    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    await recordAudit(req, {
      action:     'connection.delete',
      entityType: 'connection',
      entityId:   id,
      context: {
        connection_name:           conn.name,
        connector_type:            conn.connector_type,
        tables_deleted:            tableIds.length,
        dependent_products_deleted: dependentProducts.length,
        warehouse_files_deleted:   warehouseResult.deleted,
        warehouse_storage_kind:    warehouseResult.kind,
        warehouse_errors:          warehouseResult.errors.length || undefined,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
