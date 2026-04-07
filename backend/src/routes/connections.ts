import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth, requireRole } from '../middleware/auth';
import { createConnector, createSourceConnector, testConnector, SUPPORTED_TYPES } from '../connectors/ConnectorFactory';
import { semanticDb } from '../db/knex';
import { runSchemaProfiler } from '../semantic/SchemaProfiler';
import { encryptCredentials } from '../utils/crypto';
import { validate } from '../middleware/validate';
import { testConnectionSchema, createConnectionSchema, updateConnectionSchema } from '../middleware/schemas';

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
      return { ...r, config: safeConfig };
    });
    res.json({ ok: true, data: sanitized });
  } catch (err) {
    next(err);
  }
});

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

// POST /api/connections/:id/profile — re-run schema profiling with SSE progress
router.post('/:id/profile', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  const connection = await semanticDb('connections').where({ id: req.params.id }).first();
  if (!connection) {
    res.status(404).json({ ok: false, error: 'Connection not found' });
    return;
  }

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
      // Create the appropriate source connector for profiling
      let connectorOverride;
      if (connection.query_engine === 'duckdb' && connection.warehouse_path) {
        connectorOverride = await createConnector(connection);
        await connectorOverride.connect();
      } else {
        // For non-SQLite connectors, we need to pass the connector to the profiler
        connectorOverride = createSourceConnector(connection);
        await connectorOverride.connect();
      }

      const result = await runSchemaProfiler(connection.id, null, (p) => emit(p), connectorOverride);

      connectorOverride.disconnect();

      emit({ phase: 'done', message: `Done — ${result.tablesInserted} tables, ${result.columnsInserted} columns, ${result.relationshipsInserted} relationships`, result });
    } catch (err) {
      emit({ phase: 'error', message: err instanceof Error ? err.message : 'Profiling failed' });
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

      const result = await runSchemaProfiler(connection.id, null, undefined, connectorOverride);

      connectorOverride.disconnect();

      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Profiling failed' });
    }
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
