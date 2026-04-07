import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';
import { generateSchemaDraft, suggestRelationships } from '../ai/AIService';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import type { SemanticContext } from '../ai/prompts/schemaDraftPrompt';
import * as graph from '../db/semanticGraph';
import { invalidateSemanticCache } from '../db/semanticGraph';
import { notifyTenant } from '../services/notificationService';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers: version tracking + audit logging
// ---------------------------------------------------------------------------

async function recordVersion(
  tenantId: number | undefined,
  entityType: string,
  entityId: number,
  snapshot: Record<string, unknown>,
  changes: Record<string, unknown> | null,
  changedBy: string | number,
  changeReason?: string,
): Promise<void> {
  // Get next version number
  const prev = await semanticDb('definition_versions')
    .where({ entity_type: entityType, entity_id: entityId })
    .max('version as v')
    .first();
  const version = ((prev?.v as number) ?? 0) + 1;

  await semanticDb('definition_versions').insert({
    tenant_id: tenantId ?? null,
    entity_type: entityType,
    entity_id: entityId,
    version,
    snapshot: JSON.stringify(snapshot),
    changes: changes ? JSON.stringify(changes) : null,
    changed_by: changedBy,
    change_reason: changeReason ?? null,
  });
}

async function auditLog(
  tenantId: number | undefined,
  userId: string | number,
  userName: string | undefined,
  action: string,
  entityType: string,
  entityId: number | null,
  entityName: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  await semanticDb('audit_log').insert({
    tenant_id: tenantId ?? null,
    user_id: userId,
    user_name: userName ?? userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    entity_name: entityName,
    details: details ? JSON.stringify(details) : null,
  });
}

function computeChanges(oldObj: Record<string, unknown>, newObj: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(newObj)) {
    if (newObj[key] !== undefined && JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
      diff[key] = { from: oldObj[key] ?? null, to: newObj[key] };
    }
  }
  return diff;
}

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
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    // Capture old state for diff
    const oldRows = await graph.getTablesByConnection(0); // need by pgId
    const old = (await graph.getColumnsByTablePgId(0).catch(() => null), // fallback
      await semanticDb('definition_versions')
        .where({ entity_type: 'table', entity_id: id })
        .orderBy('version', 'desc').first());
    const oldSnapshot = old?.snapshot ? (typeof old.snapshot === 'string' ? JSON.parse(old.snapshot) : old.snapshot) : {};

    await graph.updateTable(id, body);
    await invalidateSemanticCache();

    // Record version + audit
    const changes = computeChanges(oldSnapshot, body);
    await recordVersion(req.user!.tenantId, 'table', id, { ...oldSnapshot, ...body }, changes, req.user!.sub, body.change_reason as string);
    await auditLog(req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'table', id, body.display_name as string ?? body.table_name as string, { fields: Object.keys(changes) });

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
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    const old = await semanticDb('definition_versions')
      .where({ entity_type: 'column', entity_id: id })
      .orderBy('version', 'desc').first();
    const oldSnapshot = old?.snapshot ? (typeof old.snapshot === 'string' ? JSON.parse(old.snapshot) : old.snapshot) : {};

    await graph.updateColumn(id, body);
    await invalidateSemanticCache();

    const changes = computeChanges(oldSnapshot, body);
    await recordVersion(req.user!.tenantId, 'column', id, { ...oldSnapshot, ...body }, changes, req.user!.sub);
    await auditLog(req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'column', id, body.display_name as string ?? body.column_name as string, { fields: Object.keys(changes) });

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
    await invalidateSemanticCache();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/semantic/relationships/:id
router.delete('/relationships/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.deleteRelationship(Number(req.params.id));
    await invalidateSemanticCache();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships/re-suggest?connectionId=1
// Supports SSE (Accept: text/event-stream) for real-time progress
router.post('/relationships/re-suggest', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const connectionId = Number(req.query.connectionId);
  if (!connectionId) return res.status(400).json({ ok: false, error: 'connectionId required' });

  const wantsStream = req.headers.accept?.includes('text/event-stream');

  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  const emit = (data: object) => {
    if (wantsStream) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
    }
  };

  try {
    emit({ phase: 'loading', message: 'Loading semantic layer data…' });

    // Gather all enriched semantic context from Neo4j (including quality stats + FK candidates)
    const [tables, columns, existingRels, kpis, fkCandidates] = await Promise.all([
      graph.getTablesByConnection(connectionId),
      graph.getColumnsByConnection(connectionId),
      graph.getRelationshipsForContext(connectionId),
      graph.getKpisByConnection(connectionId),
      graph.getFkCandidates(connectionId),
    ]);

    if (!tables.length) {
      const msg = 'No tables found for this connection — run profiling first';
      if (wantsStream) { emit({ phase: 'error', message: msg }); res.end(); }
      else res.status(400).json({ ok: false, error: msg });
      return;
    }

    // Build enriched context for AI — includes quality stats + FK candidates
    const ctx: SemanticContext = {
      tables: (tables as any[]).map((t) => ({
        table_name:   t.table_name,
        display_name: t.display_name ?? t.table_name,
        description:  t.description ?? '',
        grain:        t.grain ?? undefined,
        row_count:    t.row_count ?? null,
      })),
      columns: (columns as any[]).map((c) => ({
        table_name:     c.table_name,
        column_name:    c.column_name,
        display_name:   c.display_name ?? c.column_name,
        description:    c.description ?? '',
        data_type:      c.data_type ?? '',
        is_dimension:   c.is_dimension ?? false,
        is_measure:     c.is_measure ?? false,
        example_values: c.example_values ?? [],
        distinct_count: c.distinct_count ?? null,
        null_pct:       c.null_pct ?? null,
        top_values:     c.top_values ?? null,
        min_value:      c.min_value ?? null,
        max_value:      c.max_value ?? null,
      })),
      relationships: (existingRels as any[])
        .filter((r) => !r.ai_draft) // only confirmed relationships
        .map((r) => ({
          from_table:        r.from_table,
          from_column:       r.from_column ?? null,
          to_table:          r.to_table,
          to_column:         r.to_column ?? null,
          relationship_type: r.relationship_type,
          description:       r.description ?? null,
        })),
      kpis: (kpis as any[]).map((k) => ({
        name:        k.name,
        description: k.description ?? null,
        formula_sql: k.formula_sql ?? null,
      })),
      fkCandidates: fkCandidates.length > 0 ? fkCandidates : undefined,
    };

    const fkInfo = fkCandidates.length > 0 ? `, ${fkCandidates.length} FK candidates` : '';
    emit({ phase: 'ai', message: `Analysing ${ctx.tables.length} tables, ${ctx.columns.length} columns, ${ctx.kpis.length} KPIs${fkInfo} with AI…` });

    const result = await suggestRelationships(ctx);

    emit({ phase: 'storing', message: `Saving ${result.relationships.length} relationships…` });

    const tableIdMap  = await graph.getTablePgIdMap(connectionId);
    const columnIdMap = await graph.getColumnPgIdMap(connectionId);

    await graph.deleteAiDraftRelationships(connectionId);

    let inserted = 0;
    for (const rel of result.relationships) {
      const fromTablePgId = tableIdMap.get(rel.from_table);
      const toTablePgId   = tableIdMap.get(rel.to_table);
      if (!fromTablePgId || !toTablePgId) continue;

      const fromColPgId = rel.via_column ? (columnIdMap.get(`${rel.from_table}.${rel.via_column}`) ?? null) : null;
      const toColPgId   = rel.to_column  ? (columnIdMap.get(`${rel.to_table}.${rel.to_column}`)    ?? null) : null;

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
        description:    rel.reason ?? `${rel.from_table}.${rel.via_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`,
        aiDraft:        true,
      });
      inserted++;
      emit({ phase: 'storing', message: `Stored: ${rel.from_table}.${rel.via_column} → ${rel.to_table}.${rel.to_column}` });
    }

    emit({ phase: 'done', message: `Done — ${inserted} relationships created` });

    if (wantsStream) res.end();
    else res.json({ ok: true, data: { inserted } });
  } catch (err) {
    if (wantsStream) {
      emit({ phase: 'error', message: err instanceof Error ? err.message : 'Re-suggest failed' });
      res.end();
    } else {
      next(err);
    }
  }
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

    const snapshot = { connection_id, name, description, formula_plain_text, formula_sql, owner_name };
    await recordVersion(req.user!.tenantId, 'kpi', pgId, snapshot, null, req.user!.sub);
    await auditLog(req.user!.tenantId, req.user!.sub, req.user!.name as string, 'create', 'kpi', pgId, String(name ?? ''));

    res.status(201).json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/kpis/:id
router.patch('/kpis/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    const old = await semanticDb('definition_versions')
      .where({ entity_type: 'kpi', entity_id: id })
      .orderBy('version', 'desc').first();
    const oldSnapshot = old?.snapshot ? (typeof old.snapshot === 'string' ? JSON.parse(old.snapshot) : old.snapshot) : {};

    await graph.updateKpi(id, body);
    await invalidateSemanticCache();

    const changes = computeChanges(oldSnapshot, body);
    await recordVersion(req.user!.tenantId, 'kpi', id, { ...oldSnapshot, ...body }, changes, req.user!.sub);
    await auditLog(req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'kpi', id, body.name as string, { fields: Object.keys(changes) });

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
    if (!connectionId || !table) {
      res.status(400).json({ ok: false, error: 'connectionId and table are required' });
      return;
    }

    // Validate table name against known tables to prevent SQL injection
    const knownTables = await graph.getTablesByConnection(Number(connectionId));
    const validTable = (knownTables as { table_name: string }[]).find(
      (t) => t.table_name === table,
    );
    if (!validTable) {
      res.status(400).json({ ok: false, error: `Table "${table}" not found in this connection` });
      return;
    }

    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      res.status(404).json({ ok: false, error: 'Connection not found' });
      return;
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    const connector = await createConnector(connection);
    await connector.connect();

    try {
      const result = await connector.executeQuery(
        `SELECT * FROM "${validTable.table_name}" LIMIT ${safeLimit}`,
      );
      res.json({ ok: true, data: { rows: result.rows, columns: result.rows.length ? Object.keys(result.rows[0] as object) : [] } });
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Version History + Diff
// ---------------------------------------------------------------------------

// GET /api/semantic/history?entityType=table&entityId=5
router.get('/history', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entityType, entityId } = req.query as { entityType: string; entityId: string };
    if (!entityType || !entityId) {
      res.status(400).json({ ok: false, error: 'entityType and entityId required' });
      return;
    }

    const rows = await semanticDb('definition_versions')
      .where({ entity_type: entityType, entity_id: Number(entityId) })
      .orderBy('version', 'desc')
      .limit(50);

    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/semantic/diff?entityType=table&entityId=5&v1=1&v2=2
router.get('/diff', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entityType, entityId, v1, v2 } = req.query as Record<string, string>;
    if (!entityType || !entityId || !v1 || !v2) {
      res.status(400).json({ ok: false, error: 'entityType, entityId, v1, v2 required' });
      return;
    }

    const [snap1, snap2] = await Promise.all([
      semanticDb('definition_versions')
        .where({ entity_type: entityType, entity_id: Number(entityId), version: Number(v1) })
        .first(),
      semanticDb('definition_versions')
        .where({ entity_type: entityType, entity_id: Number(entityId), version: Number(v2) })
        .first(),
    ]);

    if (!snap1 || !snap2) {
      res.status(404).json({ ok: false, error: 'Version not found' });
      return;
    }

    const s1 = typeof snap1.snapshot === 'string' ? JSON.parse(snap1.snapshot) : snap1.snapshot;
    const s2 = typeof snap2.snapshot === 'string' ? JSON.parse(snap2.snapshot) : snap2.snapshot;
    const diff = computeChanges(s1, s2);

    res.json({ ok: true, data: { v1: snap1, v2: snap2, diff } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

// GET /api/semantic/audit?connectionId=1&limit=50
router.get('/audit', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entityType = req.query.entityType as string | undefined;
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;

    let query = semanticDb('audit_log').orderBy('created_at', 'desc').limit(limit);
    if (entityType) query = query.where({ entity_type: entityType });
    if (entityId) query = query.where({ entity_id: entityId });

    const rows = await query;
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Approval Workflow
// ---------------------------------------------------------------------------

// POST /api/semantic/approve — approve or reject a definition
router.post('/approve', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entityType, entityId, action, reason } = req.body as {
      entityType: 'table' | 'column' | 'kpi';
      entityId: number;
      action: 'approve' | 'reject' | 'submit_for_review';
      reason?: string;
    };

    if (!entityType || !entityId || !action) {
      res.status(400).json({ ok: false, error: 'entityType, entityId, action required' });
      return;
    }

    if (!['table', 'column', 'kpi'].includes(entityType)) {
      res.status(400).json({ ok: false, error: 'Invalid entityType' });
      return;
    }

    const statusMap: Record<string, string> = {
      approve: 'approved',
      reject: 'rejected',
    };

    const updates: {
      approval_status: string;
      approved_by?: string | null;
      approved_at?: string | null;
      rejection_reason?: string | null;
    } = {
      approval_status: statusMap[action],
    };

    if (action === 'approve') {
      updates.approved_by = String(req.user!.sub);
      updates.approved_at = new Date().toISOString();
      updates.rejection_reason = null;
    } else if (action === 'reject') {
      updates.rejection_reason = reason ?? null;
      updates.approved_by = null;
      updates.approved_at = null;
    }

    await graph.updateApprovalStatus(entityType as 'table' | 'column' | 'kpi', entityId, updates);
    await invalidateSemanticCache();
    await auditLog(req.user!.tenantId, req.user!.sub, req.user!.name as string, action, entityType, entityId, null, { reason });

    // Notify tenant about the approval/rejection
    if (req.user!.tenantId) {
      const verb = action === 'approve' ? 'approved' : 'rejected';
      notifyTenant(req.user!.tenantId, 'approval', `${entityType} ${verb}`, {
        message: `${req.user!.name ?? 'Admin'} ${verb} ${entityType} #${entityId}${reason ? `: ${reason}` : ''}`,
        entityType,
        entityId,
        link: '/semantic',
        excludeUserId: req.user!.sub as number,
      }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Bulk Import Definitions from CSV
// ---------------------------------------------------------------------------

// POST /api/semantic/import — bulk import/update definitions
router.post('/import', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { connectionId, definitions } = req.body as {
      connectionId: number;
      definitions: {
        table_name: string;
        column_name?: string;
        display_name?: string;
        description?: string;
        is_dimension?: boolean;
        is_measure?: boolean;
        domains?: string[];
        grain?: string;
      }[];
    };

    if (!connectionId || !definitions?.length) {
      res.status(400).json({ ok: false, error: 'connectionId and definitions[] required' });
      return;
    }

    let updated = 0;
    let skipped = 0;

    for (const def of definitions) {
      if (def.column_name) {
        // Column-level update: find table then column
        const table = await graph.getTableByConnectionAndName(connectionId, def.table_name);
        if (!table) { skipped++; continue; }
        const columns = await graph.getColumnsByTablePgId(table.id as number);
        const col = (columns as { id: number; column_name: string }[]).find((c) => c.column_name === def.column_name);
        if (!col) { skipped++; continue; }

        const patch: Record<string, unknown> = {};
        if (def.display_name !== undefined) patch.display_name = def.display_name;
        if (def.description !== undefined) patch.description = def.description;
        if (def.is_dimension !== undefined) patch.is_dimension = def.is_dimension;
        if (def.is_measure !== undefined) patch.is_measure = def.is_measure;

        if (Object.keys(patch).length > 0) {
          await graph.updateColumn(col.id, patch);
          await recordVersion(req.user!.tenantId, 'column', col.id, patch, null, req.user!.sub, 'bulk import');
          updated++;
        }
      } else {
        // Table-level update
        const table = await graph.getTableByConnectionAndName(connectionId, def.table_name);
        if (!table) { skipped++; continue; }

        const patch: Record<string, unknown> = {};
        if (def.display_name !== undefined) patch.display_name = def.display_name;
        if (def.description !== undefined) patch.description = def.description;
        if (def.domains !== undefined) patch.domains = def.domains;
        if (def.grain !== undefined) patch.grain = def.grain;

        if (Object.keys(patch).length > 0) {
          await graph.updateTable(table.id as number, patch);
          await recordVersion(req.user!.tenantId, 'table', table.id as number, patch, null, req.user!.sub, 'bulk import');
          updated++;
        }
      }
    }

    await auditLog(req.user!.tenantId, req.user!.sub, req.user!.name as string, 'import', 'table', null, null, { updated, skipped, total: definitions.length });

    res.json({ ok: true, data: { updated, skipped } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Data Dictionary Export
// ---------------------------------------------------------------------------

// GET /api/semantic/dictionary?connectionId=1&format=html|json
router.get('/dictionary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    const format = (req.query.format as string) || 'json';

    const tables = await graph.getTablesByConnection(connectionId);
    const allColumns = await graph.getColumnsByConnection(connectionId);
    const relationships = await graph.getRelationshipsForConnection(connectionId);
    const kpis = await graph.getKpisByConnection(connectionId);

    type TableRow = { id: number; table_name: string; display_name: string; description: string; domains: string[]; grain: string; approval_status: string };
    type ColRow = { table_id: number; column_name: string; display_name: string; description: string; data_type: string; is_dimension: boolean; is_measure: boolean };
    type RelRow = { from_table: string; from_column: string; to_table: string; to_column: string; relationship_type: string; description: string };
    type KpiRow = { name: string; description: string; formula_plain_text: string; formula_sql: string };

    if (format === 'html') {
      const conn = await semanticDb('connections').where({ id: connectionId }).first();
      const connName = conn?.name ?? `Connection #${connectionId}`;

      let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Data Dictionary — ${connName}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem; color: #1e293b; }
  h1 { font-size: 1.75rem; border-bottom: 2px solid #3b82f6; padding-bottom: 0.5rem; }
  h2 { font-size: 1.25rem; margin-top: 2rem; color: #1e40af; }
  h3 { font-size: 1rem; margin-top: 1.5rem; color: #334155; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.875rem; }
  th, td { text-align: left; padding: 6px 10px; border: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
  .dim { background: #dbeafe; color: #1e40af; }
  .meas { background: #dcfce7; color: #166534; }
  .meta { color: #64748b; font-size: 0.8rem; }
  .footer { margin-top: 3rem; font-size: 0.75rem; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 1rem; }
</style></head><body>
<h1>Data Dictionary: ${connName}</h1>
<p class="meta">Generated ${new Date().toISOString().slice(0, 10)} — ${(tables as TableRow[]).length} tables, ${(allColumns as ColRow[]).length} columns, ${(kpis as KpiRow[]).length} KPIs</p>`;

      // Tables + columns
      for (const t of tables as TableRow[]) {
        const cols = (allColumns as ColRow[]).filter((c) => c.table_id === t.id);
        html += `<h2>${t.display_name || t.table_name}</h2>`;
        if (t.description) html += `<p>${t.description}</p>`;
        if (t.grain) html += `<p class="meta">Grain: ${t.grain}</p>`;
        html += `<table><thead><tr><th>Column</th><th>Type</th><th>Role</th><th>Description</th></tr></thead><tbody>`;
        for (const c of cols) {
          const role = [c.is_dimension ? '<span class="badge dim">Dim</span>' : '', c.is_measure ? '<span class="badge meas">Measure</span>' : ''].filter(Boolean).join(' ') || '—';
          html += `<tr><td><strong>${c.column_name}</strong>${c.display_name ? ` <span class="meta">(${c.display_name})</span>` : ''}</td><td>${c.data_type ?? ''}</td><td>${role}</td><td>${c.description ?? ''}</td></tr>`;
        }
        html += `</tbody></table>`;
      }

      // Relationships
      if ((relationships as RelRow[]).length > 0) {
        html += `<h2>Relationships</h2><table><thead><tr><th>From</th><th>To</th><th>Type</th><th>Description</th></tr></thead><tbody>`;
        for (const r of relationships as RelRow[]) {
          html += `<tr><td>${r.from_table}${r.from_column ? '.' + r.from_column : ''}</td><td>${r.to_table}${r.to_column ? '.' + r.to_column : ''}</td><td>${r.relationship_type}</td><td>${r.description ?? ''}</td></tr>`;
        }
        html += `</tbody></table>`;
      }

      // KPIs
      if ((kpis as KpiRow[]).length > 0) {
        html += `<h2>KPI Definitions</h2><table><thead><tr><th>Name</th><th>Description</th><th>Formula</th></tr></thead><tbody>`;
        for (const k of kpis as KpiRow[]) {
          html += `<tr><td><strong>${k.name}</strong></td><td>${k.description ?? ''}</td><td>${k.formula_plain_text ?? k.formula_sql ?? ''}</td></tr>`;
        }
        html += `</tbody></table>`;
      }

      html += `<div class="footer">DataBridge Data Dictionary — auto-generated</div></body></html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } else {
      // JSON format
      res.json({
        ok: true,
        data: {
          tables: (tables as TableRow[]).map((t) => ({
            ...t,
            columns: (allColumns as ColRow[]).filter((c) => c.table_id === t.id),
          })),
          relationships,
          kpis,
        },
      });
    }
  } catch (err) { next(err); }
});

export default router;
