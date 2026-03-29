import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { generateSchemaDraft } from '../ai/AIService';
import { SqliteConnector } from '../connectors/SqliteConnector';

const router = Router();

// ---------------------------------------------------------------------------
// Source Tables
// ---------------------------------------------------------------------------

// GET /api/semantic/tables?connectionId=1
router.get('/tables', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId } = req.query;
    const rows = await semanticDb('source_tables')
      .where({ connection_id: connectionId })
      .orderBy('table_name');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/tables/:id — confirm or edit a table definition
router.patch('/tables/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { display_name, description, owner_name, is_active, domains } = req.body as Record<string, unknown>;
    await semanticDb('source_tables')
      .where({ id: req.params.id })
      .update({ display_name, description, owner_name, is_active, domains: JSON.stringify(domains ?? []), ai_draft: false, updated_at: semanticDb.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/semantic/domains?connectionId=1 — all unique domain tags in use
router.get('/domains', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId } = req.query;
    const rows = await semanticDb('source_tables')
      .where({ connection_id: connectionId })
      .whereNotNull('domains')
      .select('domains');
    const all = new Set<string>();
    for (const row of rows) {
      const arr: string[] = typeof row.domains === 'string' ? JSON.parse(row.domains) : (row.domains ?? []);
      arr.forEach((d) => d && all.add(d));
    }
    res.json({ ok: true, data: Array.from(all).sort() });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Source Columns
// ---------------------------------------------------------------------------

// GET /api/semantic/columns?tableId=1
router.get('/columns', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tableId } = req.query;
    const rows = await semanticDb('source_columns')
      .where({ table_id: tableId })
      .orderBy('column_name');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/columns/:id — confirm or edit a column definition
router.patch('/columns/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { display_name, description, owner_name, is_dimension, is_measure } = req.body as Record<string, unknown>;
    await semanticDb('source_columns')
      .where({ id: req.params.id })
      .update({ display_name, description, owner_name, is_dimension, is_measure, ai_draft: false, updated_at: semanticDb.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

// GET /api/semantic/relationships?connectionId=1
router.get('/relationships', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId } = req.query;
    const rows = await semanticDb('table_relationships')
      .join('source_tables as ft', 'table_relationships.from_table_id', 'ft.id')
      .join('source_tables as tt', 'table_relationships.to_table_id',   'tt.id')
      .where('ft.connection_id', connectionId)
      .select(
        'table_relationships.*',
        'ft.table_name as from_table_name',
        'tt.table_name as to_table_name',
      );
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships — create a new relationship
router.post('/relationships', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from_table_id, from_column_id, to_table_id, to_column_id, relationship_type, description } = req.body as Record<string, unknown>;
    const [row] = await semanticDb('table_relationships')
      .insert({ from_table_id, from_column_id, to_table_id, to_column_id, relationship_type, description, ai_draft: false })
      .returning('id');
    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.status(201).json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/relationships/:id
router.patch('/relationships/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { relationship_type, description, from_column_id, to_column_id } = req.body as Record<string, unknown>;
    await semanticDb('table_relationships')
      .where({ id: req.params.id })
      .update({ relationship_type, description, from_column_id, to_column_id, ai_draft: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/semantic/relationships/:id
router.delete('/relationships/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await semanticDb('table_relationships').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships/re-suggest?connectionId=1
// Deletes all AI-draft relationships for the connection and re-generates them
// from Claude using the already-profiled columns — so column IDs are resolved correctly.
router.post('/relationships/re-suggest', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    if (!connectionId) return res.status(400).json({ ok: false, error: 'connectionId required' });

    // 1. Fetch connection config (to get the SQLite file path)
    const conn = await semanticDb('connections').where({ id: connectionId }).first();
    if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
    const filePath: string = (conn.config as { filepath: string }).filepath;

    // 2. Introspect source schema (needed to give Claude context)
    const connector = new SqliteConnector(filePath);
    await connector.connect();
    const schema = await connector.introspectSchema();
    connector.disconnect();

    // 3. Re-run AI to get relationship suggestions
    const draft = await generateSchemaDraft('sqlite', schema.tables);

    // 4. Build maps from the DB (already-profiled tables and columns)
    const dbTables = await semanticDb('source_tables').where({ connection_id: connectionId });
    const tableIdMap = new Map<string, number>(dbTables.map((t: { table_name: string; id: number }) => [t.table_name, t.id]));

    const tableIds = dbTables.map((t: { id: number }) => t.id);
    const dbColumns = tableIds.length
      ? await semanticDb('source_columns').whereIn('table_id', tableIds)
      : [];

    // "tableName.columnName" → column id
    const columnIdMap = new Map<string, number>();
    for (const col of dbColumns) {
      const tbl = dbTables.find((t: { id: number }) => t.id === col.table_id);
      if (tbl) columnIdMap.set(`${tbl.table_name}.${col.column_name}`, col.id);
    }

    // 5. Delete existing AI-draft relationships for this connection
    await semanticDb('table_relationships')
      .whereIn('from_table_id', tableIds)
      .where({ ai_draft: true })
      .delete();

    // 6. Re-insert with resolved column IDs
    let inserted = 0;
    for (const tableDef of draft.tables) {
      const fromTableId = tableIdMap.get(tableDef.table_name);
      if (!fromTableId) continue;
      for (const rel of tableDef.suggested_relationships ?? []) {
        const toTableId = tableIdMap.get(rel.to_table);
        if (!toTableId) continue;
        const fromColId = rel.via_column  ? (columnIdMap.get(`${tableDef.table_name}.${rel.via_column}`) ?? null) : null;
        const toColId   = rel.to_column   ? (columnIdMap.get(`${rel.to_table}.${rel.to_column}`) ?? null)          : null;
        await semanticDb('table_relationships').insert({
          from_table_id:     fromTableId,
          from_column_id:    fromColId,
          to_table_id:       toTableId,
          to_column_id:      toColId,
          relationship_type: rel.type,
          description:       `${tableDef.table_name}.${rel.via_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`,
          ai_draft:          true,
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
    const { connectionId } = req.query;
    const rows = await semanticDb('kpi_definitions')
      .where({ connection_id: connectionId })
      .orderBy('name');
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/semantic/kpis — create a new KPI
router.post('/kpis', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connection_id, name, description, formula_plain_text, formula_sql, owner_name } = req.body as Record<string, unknown>;
    const [row] = await semanticDb('kpi_definitions')
      .insert({ connection_id, name, description, formula_plain_text, formula_sql, owner_name, ai_draft: false })
      .returning('id');
    const id: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
    res.status(201).json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/kpis/:id
router.patch('/kpis/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, formula_plain_text, formula_sql, owner_name } = req.body as Record<string, unknown>;
    await semanticDb('kpi_definitions')
      .where({ id: req.params.id })
      .update({ name, description, formula_plain_text, formula_sql, owner_name, ai_draft: false, updated_at: semanticDb.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/semantic/preview?connectionId=1&table=orders&limit=10
// ---------------------------------------------------------------------------

router.get('/preview', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, table, limit = '10' } = req.query as Record<string, string>;

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const config = typeof connection.config === 'string' ? JSON.parse(connection.config) : connection.config;
    const connector = new SqliteConnector(config.filepath);
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
