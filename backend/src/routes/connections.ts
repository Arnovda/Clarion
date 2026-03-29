import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { semanticDb } from '../db/knex';
import { runSchemaProfiler } from '../semantic/SchemaProfiler';

const router = Router();

// POST /api/connections/test — test a source connection without saving it
router.post('/test', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, config } = req.body as { type: string; config: { filepath: string } };
    if (type !== 'sqlite') {
      res.status(400).json({ ok: false, error: 'Only sqlite connections are supported in this version' });
      return;
    }
    const connector = new SqliteConnector(config.filepath);
    const result = await connector.testConnection();
    res.json({ ok: result.ok, data: { message: result.message } });
  } catch (err) {
    next(err);
  }
});

// POST /api/connections — create a connection and run schema profiling
router.post('/', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, type, config } = req.body as { name: string; type: string; config: { filepath: string } };

    if (type !== 'sqlite') {
      res.status(400).json({ ok: false, error: 'Only sqlite connections are supported in this version' });
      return;
    }

    // Test before saving
    const connector = new SqliteConnector(config.filepath);
    const test = await connector.testConnection();
    if (!test.ok) {
      res.status(400).json({ ok: false, error: test.message });
      return;
    }

    const [row] = await semanticDb('connections')
      .insert({ name, type, config: JSON.stringify(config), created_by: req.user!.username })
      .returning('id');

    const connectionId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);

    // Run schema profiling asynchronously — client polls for completion
    runSchemaProfiler(connectionId, config.filepath).catch((err) =>
      console.error('[SchemaProfiler] background error:', err),
    );

    res.status(201).json({ ok: true, data: { connectionId } });
  } catch (err) {
    next(err);
  }
});

// GET /api/connections — list all connections
router.get('/', requireAuth, requireRole('epicdata_admin'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await semanticDb('connections').select('*').orderBy('created_at', 'desc');
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/connections/:id — update name and/or config
router.patch('/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, config } = req.body as { name?: string; config?: { filepath: string } };
    const updates: Record<string, unknown> = {};
    if (name) updates.name = name;
    if (config) updates.config = JSON.stringify(config);

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

// POST /api/connections/:id/profile — re-run schema profiling (synchronous so errors surface)
router.post('/:id/profile', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await semanticDb('connections').where({ id: req.params.id }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }
    const config = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
    const result = await runSchemaProfiler(connection.id, config.filepath);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/connections/:id — delete a connection and its semantic data
router.delete('/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);

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

    await semanticDb('kpi_definitions').where({ connection_id: id }).delete();
    await semanticDb('dashboards').where({ connection_id: id }).delete();
    const deleted = await semanticDb('connections').where({ id }).delete();

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
