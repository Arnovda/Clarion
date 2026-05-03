import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import {
  createAdapterLogger,
  getConnector,
  ConfigValidationError,
} from '@databridge/connectors';
import { requireAuth, requireRole } from '../middleware/auth';
import { createConnector, createSourceConnector, testConnector, SUPPORTED_TYPES } from '../connectors/ConnectorFactory';
import { semanticDb } from '../db/knex';
import { runSchemaProfiler } from '../semantic/SchemaProfiler';
import { encryptCredentials, decryptCredentials } from '../utils/crypto';
import { validate } from '../middleware/validate';
import { testConnectionSchema, createConnectionSchema, updateConnectionSchema } from '../middleware/schemas';
import { logger } from '../utils/logger';

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

    const [row] = await semanticDb('connections')
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
      await semanticDb.raw(`SET app.current_tenant = '${Number(req.user!.tenantId)}'`);
      let config: Record<string, unknown>;
      let oauthRowId: number | null = null;
      if (oauthStateToken) {
        const row = await semanticDb('oauth_pending')
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
      const [row] = await semanticDb('connections')
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
        await semanticDb('oauth_pending').where({ id: oauthRowId }).del();
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

// GET /api/connections — list all connections
router.get('/', requireAuth, requireRole('admin'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await semanticDb('connections').select('*').orderBy('created_at', 'desc');
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
      const id = Number(req.params.id);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const rows = await semanticDb('source_sync_runs')
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
      const syncRunId = Number(req.params.syncRunId);
      const row = await semanticDb('source_sync_runs')
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
      const cancelled = requestCancellation(syncRunId);
      // Worker / orchestrator picks up the flag and writes status='cancelled' itself.
      res.json({ ok: true, data: { requested: cancelled } });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/connections/:id — update name and/or config
router.patch('/:id', requireAuth, requireRole('admin'), validate(updateConnectionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, config, domains } = req.body as { name?: string; config?: Record<string, unknown>; domains?: string[] };
    const updates: Record<string, unknown> = {};
    if (name) updates.name = name;
    if (config) {
      updates.config = encryptCredentials(JSON.stringify(config));
    }
    if (domains !== undefined) updates.domains = JSON.stringify(domains);

    const updated = await semanticDb('connections').where({ id: req.params.id }).update(updates);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Helper: compute profiling progress percentage from phase
const PROFILING_PHASES = ['schema', 'quality', 'ai_draft', 'storing', 'neo4j', 'done'] as const;
function profilingProgressPct(phase: string, tableIndex?: number, tableCount?: number): number {
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
  const connectionId = Number(req.params.id);
  const connection = await semanticDb('connections').where({ id: connectionId }).first();
  if (!connection) {
    res.status(404).json({ ok: false, error: 'Connection not found' });
    return;
  }

  // Mark profiling as running in DB so other clients can see it
  await semanticDb('connections').where({ id: connectionId }).update({
    profiling_status: 'running',
    profiling_phase: 'schema',
    profiling_message: 'Starting profiling…',
    profiling_progress: 0,
    profiling_started_at: new Date().toISOString(),
  });

  // Persist progress to DB on every phase change
  const persistProgress = async (p: { phase: string; message: string; tableIndex?: number; tableCount?: number }) => {
    try {
      await semanticDb('connections').where({ id: connectionId }).update({
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
        console.log(`[Profile] Connection ${connectionId}: using DuckDB connector (warehouse: ${connection.warehouse_path})`);
        connectorOverride = await createConnector(connection);
        await connectorOverride.connect();
        console.log(`[Profile] Connection ${connectionId}: DuckDB connected successfully`);
      } else {
        console.log(`[Profile] Connection ${connectionId}: using source connector (type: ${connection.type})`);
        connectorOverride = createSourceConnector(connection);
        await connectorOverride.connect();
        console.log(`[Profile] Connection ${connectionId}: source connector connected`);
      }

      const result = await runSchemaProfiler(connection.id, null, (p) => {
        console.log(`[Profile] Connection ${connectionId}: ${p.phase} — ${p.message}`);
        emit(p);
        persistProgress(p);
      }, connectorOverride);

      connectorOverride.disconnect();

      const doneMsg = `Done — ${result.tablesInserted} tables, ${result.columnsInserted} columns, ${result.relationshipsInserted} relationships`;
      emit({ phase: 'done', message: doneMsg, result });
      await semanticDb('connections').where({ id: connectionId }).update({
        profiling_status: 'done', profiling_phase: 'done',
        profiling_message: doneMsg, profiling_progress: 100,
        last_profiled_at: new Date().toISOString(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Profiling failed';
      console.error(`[Profile] Connection ${connectionId} profiling failed:`, err);
      emit({ phase: 'error', message: errMsg });
      await semanticDb('connections').where({ id: connectionId }).update({
        profiling_status: 'error', profiling_phase: 'error',
        profiling_message: errMsg, profiling_progress: 0,
      }).catch(() => {});
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

      const result = await runSchemaProfiler(connection.id, null, (p) => persistProgress(p), connectorOverride);

      connectorOverride.disconnect();

      await semanticDb('connections').where({ id: connectionId }).update({
        profiling_status: 'done', profiling_phase: 'done',
        profiling_message: `Done — ${result.tablesInserted} tables, ${result.columnsInserted} columns, ${result.relationshipsInserted} relationships`,
        profiling_progress: 100,
        last_profiled_at: new Date().toISOString(),
      });
      res.json({ ok: true, data: result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Profiling failed';
      await semanticDb('connections').where({ id: connectionId }).update({
        profiling_status: 'error', profiling_phase: 'error',
        profiling_message: errMsg, profiling_progress: 0,
      }).catch(() => {});
      res.status(500).json({ ok: false, error: errMsg });
    }
  }
});

// GET /api/connections/:id/profile/status — poll profiling progress
router.get('/:id/profile/status', requireAuth, async (req: Request, res: Response) => {
  const row = await semanticDb('connections')
    .where({ id: req.params.id })
    .select('profiling_status', 'profiling_phase', 'profiling_message', 'profiling_progress', 'profiling_started_at')
    .first();
  if (!row) {
    res.status(404).json({ ok: false, error: 'Connection not found' });
    return;
  }
  res.json({ ok: true, data: row });
});

// POST /api/connections/:id/introspect — lightweight column refresh (no AI)
// Re-reads actual column names + types from the source database and updates
// source_columns rows. Preserves existing AI-generated descriptions.
router.post('/:id/introspect', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.params.id);
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
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
      const sourceTable = await semanticDb('source_tables')
        .where({ connection_id: connectionId, table_name: tbl.tableName, is_active: true })
        .first();
      if (!sourceTable) continue;

      for (const col of tbl.columns) {
        const existing = await semanticDb('source_columns')
          .where({ table_id: sourceTable.id, column_name: col.name })
          .first();

        if (existing) {
          // Update data_type and example_values if they changed
          await semanticDb('source_columns').where({ id: existing.id }).update({
            data_type: col.type,
            example_values: col.sampleValues ? JSON.stringify(col.sampleValues) : existing.example_values,
          });
          updatedCols++;
        } else {
          // New column discovered — insert with ai_draft flag
          await semanticDb('source_columns').insert({
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
router.get('/freshness', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Connection freshness
    const connections = await semanticDb('connections')
      .select('id', 'name', 'last_synced_at', 'last_profiled_at', 'last_ingested_at', 'created_at')
      .orderBy('name');

    // Latest transformation run per product (graceful — may not exist)
    let products: Record<string, unknown>[] = [];
    try {
      products = await semanticDb('data_products as dp')
        .leftJoin('transformation_schedules as ts', 'ts.product_id', 'dp.id')
        .leftJoin(
          semanticDb('transformation_runs')
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
    const id = Number(req.params.id);

    // Fetch connection before deleting — need warehouse_path for cleanup
    const conn = await semanticDb('connections').where({ id }).first();

    // Get table IDs for this connection so we can cascade manually
    const tables = await semanticDb('source_tables').where({ connection_id: id }).select('id');
    const tableIds = tables.map((t: { id: number }) => t.id);

    if (tableIds.length) {
      // Delete ALL relationships touching any of these tables (from or to)
      await semanticDb('table_relationships')
        .where(function () {
          this.whereIn('from_table_id', tableIds).orWhereIn('to_table_id', tableIds);
        })
        .delete();

      await semanticDb('source_columns').whereIn('table_id', tableIds).delete();
      await semanticDb('source_tables').whereIn('id', tableIds).delete();
    }

    await semanticDb('ingested_tables').where({ connection_id: id }).delete();
    await semanticDb('kpi_definitions').where({ connection_id: id }).delete();
    await semanticDb('dashboards').where({ connection_id: id }).delete();
    const deleted = await semanticDb('connections').where({ id }).delete();

    // Clean up Delta Lake warehouse files on disk
    if (conn) {
      const warehouseDir = conn.warehouse_path
        ?? path.resolve(__dirname, '../../../warehouse', `conn_${id}`);
      try {
        if (fs.existsSync(warehouseDir)) {
          fs.rmSync(warehouseDir, { recursive: true, force: true });
          console.log(`[connections] Deleted warehouse: ${warehouseDir}`);
        }
      } catch (err) {
        console.warn(`[connections] Failed to delete warehouse ${warehouseDir}:`, err);
      }
    }

    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
