import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { generateSchemaDraft } from '../ai/AIService';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import * as graph from '../db/semanticGraph';

const router = Router();

// ---------------------------------------------------------------------------
// Source Tables
// ---------------------------------------------------------------------------

// GET /api/semantic/tables?connectionId=1
router.get('/tables', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    const rows = await graph.getTablesByConnection(connectionId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/tables/:id — confirm or edit a table definition
router.patch('/tables/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.updateTable(Number(req.params.id), req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/semantic/domains?connectionId=1
router.get('/domains', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    const [conn, tableDomains] = await Promise.all([
      semanticDb('connections').where({ id: connectionId }).first(),
      graph.getTableDomains(connectionId),
    ]);
    const all = new Set<string>(tableDomains);
    const connDomains: string[] = conn?.domains
      ? (typeof conn.domains === 'string' ? JSON.parse(conn.domains) : conn.domains)
      : [];
    connDomains.forEach((d: string) => d && all.add(d));
    res.json({ ok: true, data: Array.from(all).sort() });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Source Columns
// ---------------------------------------------------------------------------

// GET /api/semantic/columns?tableId=1
router.get('/columns', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await graph.getColumnsByTablePgId(Number(req.query.tableId));
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/columns/:id
router.patch('/columns/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.updateColumn(Number(req.params.id), req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

// GET /api/semantic/paths?connectionId=1&fromTableId=2&toTableId=3
router.get('/paths', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    const fromTableId  = Number(req.query.fromTableId);
    const toTableId    = Number(req.query.toTableId);
    if (!connectionId || !fromTableId || !toTableId) {
      res.status(400).json({ ok: false, error: 'connectionId, fromTableId and toTableId required' });
      return;
    }
    const result = await graph.findAllShortestPaths(connectionId, fromTableId, toTableId);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// GET /api/semantic/relationships?connectionId=1
router.get('/relationships', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await graph.getRelationshipsForConnection(Number(req.query.connectionId));
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships
router.post('/relationships', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from_table_id, from_column_id, to_table_id, to_column_id, relationship_type, description } =
      req.body as Record<string, unknown>;

    // Look up column names if column IDs were provided
    const [fromCol, toCol] = await Promise.all([
      from_column_id ? graph.getColumnByPgId(Number(from_column_id)) : Promise.resolve(null),
      to_column_id   ? graph.getColumnByPgId(Number(to_column_id))   : Promise.resolve(null),
    ]);

    const pgId = await graph.nextPgId();
    await graph.createRelationship({
      pgId,
      fromTablePgId:   Number(from_table_id),
      fromColumnPgId:  from_column_id ? Number(from_column_id) : null,
      fromColName:     fromCol?.column_name ?? null,
      toTablePgId:     Number(to_table_id),
      toColumnPgId:    to_column_id   ? Number(to_column_id)   : null,
      toColName:       toCol?.column_name ?? null,
      relationshipType: String(relationship_type ?? ''),
      description:     description ? String(description) : null,
      aiDraft:         false,
    });
    res.status(201).json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/relationships/:id
router.patch('/relationships/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { relationship_type, description, from_column_id, to_column_id } =
      req.body as Record<string, unknown>;

    const [fromCol, toCol] = await Promise.all([
      from_column_id !== undefined ? graph.getColumnByPgId(Number(from_column_id)) : Promise.resolve(undefined),
      to_column_id   !== undefined ? graph.getColumnByPgId(Number(to_column_id))   : Promise.resolve(undefined),
    ]);

    await graph.updateRelationship(Number(req.params.id), {
      relationship_type,
      description,
      fromColumnPgId: from_column_id !== undefined ? (from_column_id ? Number(from_column_id) : null) : undefined,
      fromColName:    fromCol !== undefined ? (fromCol?.column_name ?? null) : undefined,
      toColumnPgId:   to_column_id   !== undefined ? (to_column_id   ? Number(to_column_id)   : null) : undefined,
      toColName:      toCol   !== undefined ? (toCol?.column_name   ?? null) : undefined,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/semantic/relationships/:id
router.delete('/relationships/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.deleteRelationship(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships/re-suggest?connectionId=1
router.post('/relationships/re-suggest', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    if (!connectionId) return res.status(400).json({ ok: false, error: 'connectionId required' });

    const conn = await semanticDb('connections').where({ id: connectionId }).first();
    if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
    const filePath: string = (conn.config as { filepath: string }).filepath;

    const connector = new SqliteConnector(filePath);
    await connector.connect();
    const schema = await connector.introspectSchema();
    connector.disconnect();

    const draft = await generateSchemaDraft('sqlite', schema.tables);

    const tableIdMap  = await graph.getTablePgIdMap(connectionId);
    const columnIdMap = await graph.getColumnPgIdMap(connectionId);

    await graph.deleteAiDraftRelationships(connectionId);

    let inserted = 0;
    for (const tableDef of draft.tables) {
      const fromTablePgId = tableIdMap.get(tableDef.table_name);
      if (!fromTablePgId) continue;
      for (const rel of tableDef.suggested_relationships ?? []) {
        const toTablePgId = tableIdMap.get(rel.to_table);
        if (!toTablePgId) continue;
        const fromColPgId = rel.via_column ? (columnIdMap.get(`${tableDef.table_name}.${rel.via_column}`) ?? null) : null;
        const toColPgId   = rel.to_column  ? (columnIdMap.get(`${rel.to_table}.${rel.to_column}`)         ?? null) : null;

        const pgId = await graph.nextPgId();
        await graph.createRelationship({
          pgId,
          fromTablePgId,
          fromColumnPgId: fromColPgId ?? null,
          fromColName:    rel.via_column ?? null,
          toTablePgId,
          toColumnPgId:   toColPgId ?? null,
          toColName:      rel.to_column ?? null,
          relationshipType: rel.type,
          description:    `${tableDef.table_name}.${rel.via_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`,
          aiDraft:        true,
        });
        inserted++;
      }
    }

    res.json({ ok: true, data: { inserted } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// KPI Definitions
// ---------------------------------------------------------------------------

// GET /api/semantic/kpis?connectionId=1
router.get('/kpis', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await graph.getKpisByConnection(Number(req.query.connectionId));
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/semantic/kpis
router.post('/kpis', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connection_id, name, description, formula_plain_text, formula_sql, owner_name } =
      req.body as Record<string, unknown>;
    const pgId = await graph.nextPgId();
    await graph.createKpi({
      pgId,
      connectionId:    Number(connection_id),
      name:            String(name ?? ''),
      description:     description     ? String(description)     : null,
      formulaPlainText: formula_plain_text ? String(formula_plain_text) : null,
      formulaSql:      formula_sql     ? String(formula_sql)     : null,
      ownerName:       owner_name      ? String(owner_name)      : null,
      aiDraft:         false,
    });
    res.status(201).json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/kpis/:id
router.patch('/kpis/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.updateKpi(Number(req.params.id), req.body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/semantic/preview?connectionId=1&table=orders&limit=10
// (reads from SQLite source — unchanged)
// ---------------------------------------------------------------------------

router.get('/preview', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, table, limit = '10' } = req.query as Record<string, string>;

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const connector = createConnector(connection);
    await connector.connect();

    try {
      const result = await connector.executeQuery(
        `SELECT * FROM "${table}" LIMIT ${Math.min(Number(limit), 50)}`,
      );
      res.json({ ok: true, data: { rows: result.rows, columns: result.rows.length ? Object.keys(result.rows[0] as object) : [] } });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
