import { Router, Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  updateTableSchema, updateColumnSchema, createRelationshipSchema, updateRelationshipSchema,
  createKpiSchema, createGlossarySchema, updateGlossarySchema,
} from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { owns, ownedIds } from '../db/tenantOwnership';
import type { OwnedTable } from '../db/tenantOwnership';
import { getMatchAssertions } from '../services/matchAssertions';
import { connectionIdForEntity } from '../db/semanticCacheScope';
import type { ScopedEntity } from '../db/semanticCacheScope';
import { generateSchemaDraft, suggestRelationships, improveDescription } from '../ai/AIService';
import { SqliteConnector } from '../connectors/SqliteConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import type { SemanticContext } from '../ai/prompts/schemaDraftPrompt';
import * as graph from '../db/semanticGraph';
import { invalidateSemanticCache } from '../db/semanticGraph';
import { notifyTenant } from '../services/notificationService';
import { invalidateTenantCache } from '../services/queryCache';
import { buildXlsx, buildCsv, escapeCsvField } from '../utils/xlsxBuilder';
import { isAzurePath } from '../services/warehouse';
import { startSSE } from '../services/sse';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'semantic' });

const router = Router();

/**
 * Refuse a request whose target id belongs to another tenant.
 *
 * Every `graph.*` call is unscoped (see db/tenantOwnership.ts), so an id that
 * arrives in a path param, query string or body must be authorised against
 * Postgres BEFORE it reaches Neo4j. Returns true when the caller may proceed;
 * when it returns false it has already sent 404 and the handler must return.
 *
 * 404 rather than 403 on purpose: a 403 confirms the id exists somewhere else.
 */
async function denyUnlessOwned(
  req: Request,
  res: Response,
  table: Parameters<typeof owns>[1],
  id: unknown,
): Promise<boolean> {
  if (await owns(reqDb(req), table, id, req.user?.tenantId)) return true;
  res.status(404).json({ ok: false, error: 'Not found' });
  return false;
}

/**
 * Gate for the routes that dispatch on an entityType from the body
 * (/revert, /approve). Maps the type to its mirror table and applies the same
 * check; an unknown type is refused rather than waved through.
 */
// Values must be valid for BOTH the ownership gate and the cache scope resolver.
const ENTITY_TABLE: Record<string, OwnedTable & ScopedEntity> = {
  table:          'source_tables',
  column:         'source_columns',
  kpi:            'kpi_definitions',
  product_table:  'product_tables',
  product_column: 'product_columns',
};

async function denyUnlessOwnedEntity(
  req: Request,
  res: Response,
  entityType: string,
  entityId: unknown,
): Promise<boolean> {
  const table = ENTITY_TABLE[entityType];
  if (!table) {
    res.status(400).json({ ok: false, error: 'Invalid entityType' });
    return false;
  }
  return denyUnlessOwned(req, res, table, entityId);
}

/**
 * Cache scope for the entityType-dispatching routes. `undefined` means "could
 * not determine", which makes invalidateSemanticCache fall back to the global
 * wipe — slow, but never stale.
 */
async function scopeForEntity(
  db: ReturnType<typeof reqDb>,
  entityType: string,
  entityId: unknown,
): Promise<number | undefined> {
  const table = ENTITY_TABLE[entityType];
  if (!table) return undefined;
  return (await connectionIdForEntity(db, table, entityId)) ?? undefined;
}

/**
 * Same gate for relationships, which need one extra step.
 *
 * Relationships created before the Postgres dual-write existed have no mirror
 * row, so the plain `table_relationships` check would 404 them and users could
 * no longer reject old AI drafts from the review queue. For those, authorise via
 * the connection that owns the relationship in the graph — still a real tenant
 * check, just resolved through a different path.
 */
async function denyUnlessOwnedRelationship(
  req: Request,
  res: Response,
  id: number,
): Promise<boolean> {
  const db = reqDb(req);
  const tenantId = req.user?.tenantId;
  if (await owns(db, 'table_relationships', id, tenantId)) return true;

  // The graph lookup is a best-effort SECOND CHANCE, never a gate of its own.
  // It runs on the refusal path, so a Neo4j outage would otherwise turn every
  // "denied" into a 500 — an unavailable graph is not permission to proceed,
  // and the caller must not be able to tell the two apart. Refuse on any error.
  let connectionId: number | null = null;
  if (Number.isInteger(id) && id > 0) {
    try {
      connectionId = await graph.getRelationshipConnectionId(id);
    } catch (err) {
      log.warn({ err, id }, 'relationship ownership fallback unavailable — refusing');
    }
  }
  if (connectionId !== null && await owns(db, 'connections', connectionId, tenantId)) return true;

  res.status(404).json({ ok: false, error: 'Not found' });
  return false;
}

/**
 * Any successful write to the semantic layer (PATCH/POST/DELETE on a
 * definition) can change the correct SQL for previously-cached questions.
 * This middleware fires a tenant-wide query-cache invalidation after any
 * 2xx response to a write request. Reads (GET/HEAD) are ignored.
 *
 * Runs BEFORE the route handlers so `res.on('finish', …)` registers the
 * hook only once per response. Errors in invalidation are swallowed — a
 * successful semantic write should never be blocked by a cache purge.
 */
router.use((req: Request, res: Response, next: NextFunction) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const tenantId = (req as unknown as { user?: { tenantId?: number } }).user?.tenantId;
    if (!tenantId) return;
    invalidateTenantCache(tenantId).catch(() => { /* already logged */ });
  });
  next();
});

// ---------------------------------------------------------------------------
// Helpers: version tracking + audit logging
// ---------------------------------------------------------------------------

async function recordVersion(
  db: Knex | Knex.Transaction,
  tenantId: number | undefined,
  entityType: string,
  entityId: number,
  snapshot: Record<string, unknown>,
  changes: Record<string, unknown> | null,
  changedBy: string | number,
  changeReason?: string,
): Promise<void> {
  // Get next version number
  const prev = await db('definition_versions')
    .where({ entity_type: entityType, entity_id: entityId })
    .max('version as v')
    .first();
  const version = ((prev?.v as number) ?? 0) + 1;

  await db('definition_versions').insert({
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
  db: Knex | Knex.Transaction,
  tenantId: number | undefined,
  userId: string | number,
  userName: string | undefined,
  action: string,
  entityType: string,
  entityId: number | null,
  entityName: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  await db('audit_log').insert({
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
    if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;
    const rows = await graph.getTablesByConnection(connectionId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/tables/:id — confirm or edit a table definition
router.patch('/tables/:id', requireAuth, requireRole('admin', 'analyst'), validate(updateTableSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    // graph.updateTable matches on pgId with no tenant predicate, so authorise
    // BEFORE touching Neo4j. The Postgres mirror below is tenant-scoped and
    // would silently update 0 rows, leaving the two stores divergent.
    if (!await denyUnlessOwned(req, res, 'source_tables', id)) return;

    // Capture old state for diff
    const old = await db('definition_versions')
      .where({ entity_type: 'table', entity_id: id })
      .orderBy('version', 'desc').first();
    const oldSnapshot = old?.snapshot ? (typeof old.snapshot === 'string' ? JSON.parse(old.snapshot) : old.snapshot) : {};

    await graph.updateTable(id, body);
    // Mirror to Postgres source_tables. Neo4j is the source of truth for
    // reads, but several aggregate surfaces (Home health score, /review
    // queue counts) still query Postgres directly. Without this dual-write
    // a confirm in /review never lowered the "AI drafts pending" count.
    // Tenant-scoped to defend against cross-tenant id collisions even
    // though source_tables.id is globally unique.
    const tablePatch: Record<string, unknown> = { ai_draft: false };
    if (typeof body.display_name === 'string') tablePatch.display_name = body.display_name;
    if (typeof body.description === 'string') tablePatch.description = body.description;
    if (typeof body.approval_status === 'string') tablePatch.approval_status = body.approval_status;
    if (body.is_active !== undefined) tablePatch.is_active = !!body.is_active;
    if (Array.isArray(body.domains)) tablePatch.domains = JSON.stringify(body.domains);

    // Human-edit tracking (top rung of the precedence ladder): flag the row
    // as human-authored ONLY when a semantic field actually CHANGED — a bare
    // confirm of machine text is approval, not authorship. The profiler
    // snapshots flagged rows across its wipe-and-reinsert.
    const current = await db('source_tables').where({ id }).first();
    if (current) {
      const changedSemantics =
        (typeof body.display_name === 'string' && body.display_name !== current.display_name) ||
        (typeof body.description === 'string' && body.description !== (current.description ?? ''));
      if (changedSemantics) tablePatch.edited_by_user = true;
    }
    await db('source_tables').where({ id }).update(tablePatch);

    await invalidateSemanticCache(await connectionIdForEntity(db, 'source_tables', id) ?? undefined);

    // Record version + audit
    const changes = computeChanges(oldSnapshot, body);
    await recordVersion(db, req.user!.tenantId, 'table', id, { ...oldSnapshot, ...body }, changes, req.user!.sub, body.change_reason as string);
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'table', id, body.display_name as string ?? body.table_name as string, { fields: Object.keys(changes) });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/semantic/domains?connectionId=1
router.get('/domains', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const connectionId = Number(req.query.connectionId);
    if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;
    const [conn, tableDomains] = await Promise.all([
      db('connections').where({ id: connectionId }).first(),
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
    const tableId = Number(req.query.tableId);
    if (!await denyUnlessOwned(req, res, 'source_tables', tableId)) return;
    const rows = await graph.getColumnsByTablePgId(tableId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/columns/:id
router.patch('/columns/:id', requireAuth, requireRole('admin', 'analyst'), validate(updateColumnSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    // Unscoped graph write — authorise first. See PATCH /tables/:id.
    if (!await denyUnlessOwned(req, res, 'source_columns', id)) return;

    const old = await db('definition_versions')
      .where({ entity_type: 'column', entity_id: id })
      .orderBy('version', 'desc').first();
    const oldSnapshot = old?.snapshot ? (typeof old.snapshot === 'string' ? JSON.parse(old.snapshot) : old.snapshot) : {};

    await graph.updateColumn(id, body);
    // Mirror to Postgres source_columns. See PATCH /tables/:id above for
    // the full rationale — Home health score + /review queue COUNT
    // queries hit Postgres directly and would otherwise miss confirms.
    const colPatch: Record<string, unknown> = { ai_draft: false };
    if (typeof body.display_name === 'string') colPatch.display_name = body.display_name;
    if (typeof body.description === 'string') colPatch.description = body.description;
    if (typeof body.approval_status === 'string') colPatch.approval_status = body.approval_status;
    if (body.is_dimension !== undefined) colPatch.is_dimension = !!body.is_dimension;
    if (body.is_measure !== undefined) colPatch.is_measure = !!body.is_measure;

    // Same human-edit rule as PATCH /tables/:id: authorship = a semantic
    // field actually changed; a bare confirm never sets the flag.
    const current = await db('source_columns').where({ id }).first();
    if (current) {
      const changedSemantics =
        (typeof body.display_name === 'string' && body.display_name !== current.display_name) ||
        (typeof body.description === 'string' && body.description !== (current.description ?? '')) ||
        (body.is_dimension !== undefined && !!body.is_dimension !== !!current.is_dimension) ||
        (body.is_measure !== undefined && !!body.is_measure !== !!current.is_measure);
      if (changedSemantics) colPatch.edited_by_user = true;
    }

    // Enrichment reject path (semantic-enrichment-plan Phase 3): flagging an
    // AI-enriched draft restores the immutable vendor text instead of
    // leaving rejected AI prose in the catalog.
    if (
      current?.semantic_source === 'ai_enriched' &&
      body.approval_status === 'flagged' &&
      current?.vendor_description
    ) {
      colPatch.description = current.vendor_description;
      colPatch.semantic_source = 'curated';
      colPatch.approval_status = 'approved';
      colPatch.ai_draft = false;
      await graph.updateColumnDescriptionOnly(id, String(current.vendor_description), false);
    }

    await db('source_columns').where({ id }).update(colPatch);

    await invalidateSemanticCache(await connectionIdForEntity(db, 'source_columns', id) ?? undefined);

    const changes = computeChanges(oldSnapshot, body);
    await recordVersion(db, req.user!.tenantId, 'column', id, { ...oldSnapshot, ...body }, changes, req.user!.sub);
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'column', id, body.display_name as string ?? body.column_name as string, { fields: Object.keys(changes) });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Conversational tuning — "Ask AI to change this description"
//
// Returns an AI-improved description for the user to review; it does NOT save.
// On accept, the client calls the existing PATCH /tables|/columns/:id. This is
// the business-owner's plain-language way to tune meaning without writing the
// text (or any SQL) themselves.
// ---------------------------------------------------------------------------

function readInstruction(req: Request, res: Response): string | null {
  const instruction = (req.body as { instruction?: unknown })?.instruction;
  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    res.status(400).json({ ok: false, error: 'An instruction is required.' });
    return null;
  }
  if (instruction.length > 1000) {
    res.status(400).json({ ok: false, error: 'Instruction is too long (max 1000 characters).' });
    return null;
  }
  return instruction.trim();
}

// POST /api/semantic/tables/:id/improve-description  { instruction }
router.post('/tables/:id/improve-description', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'Invalid id' }); return; }
    const instruction = readInstruction(req, res);
    if (instruction === null) return;

    const table = await db('source_tables').where({ id }).first();
    if (!table) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }
    const conn = table.connection_id
      ? await db('connections').where({ id: table.connection_id }).first()
      : null;

    const proposal = await improveDescription({
      entityType: 'table',
      name: String(table.display_name || table.table_name || 'table'),
      currentDescription: String(table.description ?? ''),
      instruction,
      connectorType: conn?.connector_type ?? conn?.type ?? null,
    });

    res.json({ ok: true, data: { current_description: String(table.description ?? ''), ai_proposal: proposal, instruction } });
  } catch (err) { next(err); }
});

// POST /api/semantic/columns/:id/improve-description  { instruction }
router.post('/columns/:id/improve-description', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'Invalid id' }); return; }
    const instruction = readInstruction(req, res);
    if (instruction === null) return;

    const col = await db('source_columns').where({ id }).first();
    if (!col) { res.status(404).json({ ok: false, error: 'Column not found' }); return; }
    const parent = col.source_table_id
      ? await db('source_tables').where({ id: col.source_table_id }).first()
      : null;
    const conn = parent?.connection_id
      ? await db('connections').where({ id: parent.connection_id }).first()
      : null;

    const proposal = await improveDescription({
      entityType: 'column',
      name: String(col.display_name || col.column_name || 'column'),
      tableName: parent ? String(parent.display_name || parent.table_name) : null,
      dataType: col.data_type ?? null,
      currentDescription: String(col.description ?? ''),
      instruction,
      connectorType: conn?.connector_type ?? conn?.type ?? null,
    });

    res.json({ ok: true, data: { current_description: String(col.description ?? ''), ai_proposal: proposal, instruction } });
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
    // All three ids are attacker-controlled and all three reach unscoped Cypher.
    if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;
    if (!await denyUnlessOwned(req, res, 'source_tables', fromTableId)) return;
    if (!await denyUnlessOwned(req, res, 'source_tables', toTableId)) return;
    const result = await graph.findAllShortestPaths(connectionId, fromTableId, toTableId);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ─── Relationships ─────────────────────────────────────────────────────────
// DUAL-WRITE CONTRACT (until Phase 7 Neo4j cutover is complete):
//   • Neo4j is the source of truth for READS via graph.getRelationshipsForConnection
//     etc. Every user-facing aggregate that needs Neo4j data goes through Neo4j.
//   • A handful of aggregate surfaces still query Postgres directly — Home health
//     score (routes/home.ts), AI review queue counts, the legacy /gaps page.
//     For those surfaces to stay correct, every WRITE that mutates relationships
//     must also be mirrored into Postgres `table_relationships`.
//   • Mirrored writes (today): SchemaProfiler (Postgres-first, then Neo4j),
//     POST/PATCH/DELETE /relationships, POST /relationships/re-suggest.
//   • Mirror invariant: id is identical on both sides. The route uses
//     `nextPgId()` (semantic_node_id_seq) as the source-of-truth id and inserts
//     into Postgres with that explicit id, then bumps table_relationships_id_seq.
//   • If you add a new write to relationships anywhere, MIRROR IT or extend the
//     consuming aggregate to read from Neo4j. See CLAUDE.md → "Dual-write contract".

// GET /api/semantic/relationships?connectionId=1
router.get('/relationships', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = Number(req.query.connectionId);
    if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;
    const rows = await graph.getRelationshipsForConnection(connectionId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships
// POST /api/semantic/relationships
// Role: admin + analyst — parity with PATCH and DELETE below. An analyst who
// may confirm and remove a relationship must be able to draw one; the
// relationship canvas is analyst+, and admin-only here meant an analyst could
// measure a link, see that it holds, and then be refused when saving it.
router.post('/relationships', requireAuth, requireRole('admin', 'analyst'), validate(createRelationshipSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { from_table_id, from_column_id, to_table_id, to_column_id, relationship_type, description,
            kind, match_keys, measured } =
      req.body as Record<string, unknown>;
    // A link between two sources is a `match`, not a join — see migration 77.
    // Anything unrecognised falls back to 'join', which is what every row
    // written before that migration is.
    const relKind = kind === 'match' ? 'match' : 'join';

    // Every id here is body-supplied and every graph call below is unscoped.
    // Unauthorised, this both READS another tenant's column names and plants a
    // relationship between their tables.
    if (!await denyUnlessOwned(req, res, 'source_tables', from_table_id)) return;
    if (!await denyUnlessOwned(req, res, 'source_tables', to_table_id)) return;
    if (from_column_id && !await denyUnlessOwned(req, res, 'source_columns', from_column_id)) return;
    if (to_column_id && !await denyUnlessOwned(req, res, 'source_columns', to_column_id)) return;

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
      tenantId:        req.user!.tenantId,
    });
    // Mirror to Postgres `table_relationships` so Home's "relationships
    // approved / total" counts reflect the new row. Insert with explicit
    // id = Neo4j pgId so PATCH/DELETE by id stays consistent across stores.
    // See dual-write contract notes in CLAUDE.md.
    await db('table_relationships')
      .insert({
        id:                pgId,
        from_table_id:     Number(from_table_id),
        from_column_id:    from_column_id ? Number(from_column_id) : null,
        to_table_id:       Number(to_table_id),
        to_column_id:      to_column_id ? Number(to_column_id) : null,
        relationship_type: String(relationship_type ?? ''),
        description:       description ? String(description) : null,
        ai_draft:          false,
        kind:              relKind,
        // Postgres-only, like the cached measurement: the Neo4j edge carries
        // neither, and mirroring a statistic that moves on every sync would
        // give the two stores a third way to disagree.
        match_keys:        match_keys == null ? null : JSON.stringify(match_keys),
        measured:          measured == null ? null : JSON.stringify(measured),
      })
      .onConflict('id').merge();
    // Keep table_relationships_id_seq ahead of any pgId we've inserted so
    // future SchemaProfiler runs (which let Postgres auto-assign id) don't
    // collide with Neo4j-assigned pgIds we've already mirrored.
    await db.raw(
      `SELECT setval('table_relationships_id_seq', GREATEST(?, (SELECT COALESCE(MAX(id), 1) FROM table_relationships)))`,
      [pgId],
    );
    res.status(201).json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/relationships/:id
// Role: admin + analyst. Relaxed from admin-only for parity with
// PATCH /tables/:id and /columns/:id (which were widened in the
// Phase A IA redesign so analysts can confirm/flag from the review
// queue). Relationships review now lives in the same /review surface,
// so the role gate must match.
router.patch('/relationships/:id', requireAuth, requireRole('admin', 'analyst'), validate(updateRelationshipSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { relationship_type, description, from_column_id, to_column_id, measured } =
      req.body as Record<string, unknown>;

    if (!await denyUnlessOwnedRelationship(req, res, Number(req.params.id))) return;
    if (from_column_id !== undefined && from_column_id
        && !await denyUnlessOwned(req, res, 'source_columns', from_column_id)) return;
    if (to_column_id !== undefined && to_column_id
        && !await denyUnlessOwned(req, res, 'source_columns', to_column_id)) return;

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
    // Mirror to Postgres table_relationships so Home's "relationships
    // approved / total" count reflects the confirmation. Same dual-write
    // pattern as PATCH /tables/:id and PATCH /columns/:id above.
    const relPatch: Record<string, unknown> = { ai_draft: false };
    if (typeof relationship_type === 'string') relPatch.relationship_type = relationship_type;
    if (typeof description === 'string') relPatch.description = description;
    // Any PATCH here is a human acting on the relationship (confirm or
    // edit) — mark it so the profiler preserves it across re-profiles.
    relPatch.confirmed_by_user = true;
    // Cached measurement (migration 77). Postgres-only: the Neo4j edge carries
    // no measurement, and mirroring a statistic that changes on every sync
    // would give the two stores a third way to disagree. Stringified rather
    // than passed as an object so the jsonb cast is explicit.
    if (measured !== undefined) {
      relPatch.measured = measured === null ? null : JSON.stringify(measured);
    }
    await db('table_relationships').where({ id: Number(req.params.id) }).update(relPatch);

    await invalidateSemanticCache(
      await connectionIdForEntity(db, 'table_relationships', req.params.id) ?? undefined,
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/semantic/relationships/:id
// Role: admin + analyst — same parity rationale as PATCH above.
// Analysts need to be able to "Reject" an AI-drafted relationship from
// the review queue (relationships have no approval_status column, so
// rejection is a hard delete rather than a soft flag).
router.delete('/relationships/:id', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    if (!await denyUnlessOwnedRelationship(req, res, id)) return;
    // Resolve the cache scope BEFORE the row is deleted — afterwards there is
    // nothing left to join through and we would fall back to a global wipe.
    const relConnectionId = await connectionIdForEntity(db, 'table_relationships', id);
    await graph.deleteRelationship(id);
    // Mirror delete to Postgres so Home's relationship counts decrement.
    // No-op if the row doesn't exist (e.g. legacy Neo4j-only rels created
    // before the dual-write was added).
    await db('table_relationships').where({ id }).delete();
    await invalidateSemanticCache(relConnectionId ?? undefined);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/semantic/relationships/re-suggest?connectionId=1
// Supports SSE (Accept: text/event-stream) for real-time progress
router.post('/relationships/re-suggest', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  const connectionId = Number(req.query.connectionId);
  if (!connectionId) return res.status(400).json({ ok: false, error: 'connectionId required' });

  // Before any SSE stream opens: this route reads the connection's whole
  // semantic context AND wipes its AI-draft relationships, both unscoped.
  if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;

  const wantsStream = req.headers.accept?.includes('text/event-stream');

  const sse = wantsStream ? startSSE(res) : null;

  const emit = (data: object) => { sse?.emit(data); };

  try {
    const db = reqDb(req);
    emit({ phase: 'loading', message: 'Loading semantic layer data…' });

    // Gather all enriched semantic context from Neo4j (including quality stats + FK candidates)
    const [tables, columns, existingRels, kpis, fkCandidates, matchAssertions] = await Promise.all([
      graph.getTablesByConnection(connectionId),
      graph.getColumnsByConnection(connectionId),
      graph.getRelationshipsForContext(connectionId),
      graph.getKpisByConnection(connectionId),
      graph.getFkCandidates(connectionId),
      // Cross-source identity links. Postgres-backed and NOT part of the Neo4j
      // relationship read above: `kind` lives only in Postgres, and a match
      // spans two connections while that read is scoped to one.
      getMatchAssertions(reqDb(req), req.user?.tenantId, connectionId),
    ]);

    if (!tables.length) {
      const msg = 'No tables found for this connection — run profiling first';
      if (sse) { emit({ phase: 'error', message: msg }); sse.end(); }
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
      // Identity links are appended AFTER the joins, carrying their own
      // relationship_type and a description that says outright they are not
      // foreign keys — a model pattern-matching for something joinable must not
      // find one here.
      relationships: [...matchAssertions, ...(existingRels as any[])
        .filter((r) => !r.ai_draft) // only confirmed relationships
        .map((r) => ({
          from_table:        r.from_table,
          from_column:       r.from_column ?? null,
          to_table:          r.to_table,
          to_column:         r.to_column ?? null,
          relationship_type: r.relationship_type,
          description:       r.description ?? null,
        }))],
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
    // Mirror the wipe in Postgres — drop every AI-draft relationship rooted
    // at any table for this connection. Confirmed (ai_draft = false) rels
    // are preserved on both sides.
    const connectionTableIds = Array.from(tableIdMap.values());
    if (connectionTableIds.length > 0) {
      await db('table_relationships')
        .where({ ai_draft: true })
        .where(function () {
          this.whereIn('from_table_id', connectionTableIds)
              .orWhereIn('to_table_id', connectionTableIds);
        })
        .delete();
    }

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
        tenantId:       req.user!.tenantId,
      });
      // Mirror each new draft into Postgres with explicit id = Neo4j pgId.
      await db('table_relationships')
        .insert({
          id:                pgId,
          from_table_id:     fromTablePgId,
          from_column_id:    fromColPgId ?? null,
          to_table_id:       toTablePgId,
          to_column_id:      toColPgId ?? null,
          relationship_type: rel.type,
          description:       rel.reason ?? `${rel.from_table}.${rel.via_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`,
          ai_draft:          true,
        })
        .onConflict('id').merge();
      inserted++;
      emit({ phase: 'storing', message: `Stored: ${rel.from_table}.${rel.via_column} → ${rel.to_table}.${rel.to_column}` });
    }
    // Keep the Postgres sequence ahead of every pgId we just inserted.
    await db.raw(
      `SELECT setval('table_relationships_id_seq', (SELECT COALESCE(MAX(id), 1) FROM table_relationships))`,
    );

    emit({ phase: 'done', message: `Done — ${inserted} relationships created` });

    if (sse) sse.end();
    else res.json({ ok: true, data: { inserted } });
  } catch (err) {
    if (sse) {
      emit({ phase: 'error', message: err instanceof Error ? err.message : 'Re-suggest failed' });
      sse.end();
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
    const connectionId = Number(req.query.connectionId);
    if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;
    const rows = await graph.getKpisByConnection(connectionId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/semantic/kpis
router.post('/kpis', requireAuth, requireRole('admin'), validate(createKpiSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { connection_id, name, description, formula_plain_text, formula_sql, owner_name } =
      req.body as Record<string, unknown>;
    // connection_id is body-supplied and becomes the KPI's owner in the graph.
    if (!await denyUnlessOwned(req, res, 'connections', connection_id)) return;
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
      tenantId:        req.user!.tenantId,
    });

    const snapshot = { connection_id, name, description, formula_plain_text, formula_sql, owner_name };
    await recordVersion(db, req.user!.tenantId, 'kpi', pgId, snapshot, null, req.user!.sub);
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'create', 'kpi', pgId, String(name ?? ''));

    res.status(201).json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/kpis/:id
router.patch('/kpis/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    if (!await denyUnlessOwned(req, res, 'kpi_definitions', id)) return;

    const old = await db('definition_versions')
      .where({ entity_type: 'kpi', entity_id: id })
      .orderBy('version', 'desc').first();
    const oldSnapshot = old?.snapshot ? (typeof old.snapshot === 'string' ? JSON.parse(old.snapshot) : old.snapshot) : {};

    await graph.updateKpi(id, body);
    await invalidateSemanticCache(await connectionIdForEntity(db, 'kpi_definitions', id) ?? undefined);

    const changes = computeChanges(oldSnapshot, body);
    await recordVersion(db, req.user!.tenantId, 'kpi', id, { ...oldSnapshot, ...body }, changes, req.user!.sub);
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'kpi', id, body.name as string, { fields: Object.keys(changes) });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Business Glossary — tenant-wide term/meaning store, fed into AI prompts.
// admin + analyst can write; viewer is read-only.
// ---------------------------------------------------------------------------

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

function normalizeGlossaryRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    term: row.term,
    meaning: row.meaning,
    examples: parseJsonArray(row.examples),
    tags: parseJsonArray(row.tags),
    ai_draft: row.ai_draft,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/semantic/glossary
router.get('/glossary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const rows = await db('business_glossary').orderBy('term', 'asc');
    res.json({ ok: true, data: rows.map(normalizeGlossaryRow) });
  } catch (err) { next(err); }
});

// POST /api/semantic/glossary
router.post('/glossary', requireAuth, requireRole('admin', 'analyst'), validate(createGlossarySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { term, meaning, examples, tags } = req.body as Record<string, unknown>;
    const trimmedTerm = String(term ?? '').trim();
    const trimmedMeaning = String(meaning ?? '').trim();
    if (!trimmedTerm || !trimmedMeaning) {
      res.status(400).json({ ok: false, error: 'term and meaning are required' });
      return;
    }
    const [row] = await db('business_glossary')
      .insert({
        tenant_id: req.user!.tenantId,
        term: trimmedTerm,
        meaning: trimmedMeaning,
        examples: JSON.stringify(parseJsonArray(examples)),
        tags: JSON.stringify(parseJsonArray(tags)),
        ai_draft: false,
        created_by_user_id: req.user!.sub,
      })
      .returning('*');
    res.status(201).json({ ok: true, data: normalizeGlossaryRow(row) });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      res.status(409).json({ ok: false, error: 'A glossary entry with this term already exists' });
      return;
    }
    next(err);
  }
});

// PATCH /api/semantic/glossary/:id
router.patch('/glossary/:id', requireAuth, requireRole('admin', 'analyst'), validate(updateGlossarySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (typeof body.term === 'string')    update.term = body.term.trim();
    if (typeof body.meaning === 'string') update.meaning = body.meaning.trim();
    if (body.examples !== undefined)      update.examples = JSON.stringify(parseJsonArray(body.examples));
    if (body.tags !== undefined)          update.tags = JSON.stringify(parseJsonArray(body.tags));
    if (typeof body.ai_draft === 'boolean') update.ai_draft = body.ai_draft;

    const [row] = await db('business_glossary')
      .where({ id })
      .update(update)
      .returning('*');
    if (!row) { res.status(404).json({ ok: false, error: 'Glossary entry not found' }); return; }
    res.json({ ok: true, data: normalizeGlossaryRow(row) });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      res.status(409).json({ ok: false, error: 'A glossary entry with this term already exists' });
      return;
    }
    next(err);
  }
});

// DELETE /api/semantic/glossary/:id
router.delete('/glossary/:id', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    const deleted = await db('business_glossary').where({ id }).delete();
    if (!deleted) { res.status(404).json({ ok: false, error: 'Glossary entry not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/semantic/preview?connectionId=1&table=orders&limit=10
// (reads from SQLite source — unchanged)
// ---------------------------------------------------------------------------

router.get('/preview', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
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

    const connection = await db('connections').where({ id: connectionId }).first();
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
// Revert to a previous version
// ---------------------------------------------------------------------------

// POST /api/semantic/revert
router.post('/revert', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { entityType, entityId, version } = req.body as {
      entityType: 'table' | 'column' | 'kpi';
      entityId: number;
      version: number;
    };

    if (!entityType || !entityId || !version) {
      res.status(400).json({ ok: false, error: 'entityType, entityId, and version are required' });
      return;
    }

    if (!['table', 'column', 'kpi'].includes(entityType)) {
      res.status(400).json({ ok: false, error: 'entityType must be table, column, or kpi' });
      return;
    }

    // entityId is body-supplied and reaches unscoped graph writes below.
    if (!await denyUnlessOwnedEntity(req, res, entityType, entityId)) return;

    // Look up the target version
    const targetVersion = await db('definition_versions')
      .where({ entity_type: entityType, entity_id: entityId, version })
      .first();

    if (!targetVersion) {
      res.status(404).json({ ok: false, error: `Version ${version} not found for ${entityType} #${entityId}` });
      return;
    }

    const snapshot = typeof targetVersion.snapshot === 'string'
      ? JSON.parse(targetVersion.snapshot)
      : targetVersion.snapshot;

    // Get the current state for diff
    const currentVersion = await db('definition_versions')
      .where({ entity_type: entityType, entity_id: entityId })
      .orderBy('version', 'desc')
      .first();
    const currentSnapshot = currentVersion?.snapshot
      ? (typeof currentVersion.snapshot === 'string' ? JSON.parse(currentVersion.snapshot) : currentVersion.snapshot)
      : {};

    // Apply the snapshot to the entity. Each entity type writes to Neo4j
    // (source of truth) AND mirrors to Postgres (source_tables /
    // source_columns / kpi_definitions) so Home health counts and /review
    // queue aggregates pick up reverts. See "Dual-write contract" in
    // CLAUDE.md for the full list of mirrored surfaces.
    if (entityType === 'table') {
      const patch: Record<string, unknown> = {};
      if (snapshot.display_name !== undefined) patch.display_name = snapshot.display_name;
      if (snapshot.description !== undefined) patch.description = snapshot.description;
      if (snapshot.owner_name !== undefined) patch.owner_name = snapshot.owner_name;
      if (snapshot.domains !== undefined) patch.domains = snapshot.domains;
      if (snapshot.grain !== undefined) patch.grain = snapshot.grain;
      if (snapshot.is_active !== undefined) patch.is_active = snapshot.is_active;
      await graph.updateTable(entityId, patch);
      // Mirror to Postgres
      const pgPatch: Record<string, unknown> = {};
      if (snapshot.display_name !== undefined) pgPatch.display_name = snapshot.display_name;
      if (snapshot.description !== undefined) pgPatch.description = snapshot.description;
      if (snapshot.is_active !== undefined) pgPatch.is_active = !!snapshot.is_active;
      if (snapshot.domains !== undefined) {
        pgPatch.domains = Array.isArray(snapshot.domains) ? JSON.stringify(snapshot.domains) : snapshot.domains;
      }
      if (Object.keys(pgPatch).length > 0) {
        await db('source_tables').where({ id: entityId }).update(pgPatch);
      }
    } else if (entityType === 'column') {
      const patch: Record<string, unknown> = {};
      if (snapshot.display_name !== undefined) patch.display_name = snapshot.display_name;
      if (snapshot.description !== undefined) patch.description = snapshot.description;
      if (snapshot.owner_name !== undefined) patch.owner_name = snapshot.owner_name;
      if (snapshot.is_dimension !== undefined) patch.is_dimension = snapshot.is_dimension;
      if (snapshot.is_measure !== undefined) patch.is_measure = snapshot.is_measure;
      await graph.updateColumn(entityId, patch);
      // Mirror to Postgres
      const pgPatch: Record<string, unknown> = {};
      if (snapshot.display_name !== undefined) pgPatch.display_name = snapshot.display_name;
      if (snapshot.description !== undefined) pgPatch.description = snapshot.description;
      if (snapshot.is_dimension !== undefined) pgPatch.is_dimension = !!snapshot.is_dimension;
      if (snapshot.is_measure !== undefined) pgPatch.is_measure = !!snapshot.is_measure;
      if (Object.keys(pgPatch).length > 0) {
        await db('source_columns').where({ id: entityId }).update(pgPatch);
      }
    } else if (entityType === 'kpi') {
      const patch: Record<string, unknown> = {};
      if (snapshot.name !== undefined) patch.name = snapshot.name;
      if (snapshot.description !== undefined) patch.description = snapshot.description;
      if (snapshot.formula_plain_text !== undefined) patch.formula_plain_text = snapshot.formula_plain_text;
      if (snapshot.formula_sql !== undefined) patch.formula_sql = snapshot.formula_sql;
      if (snapshot.owner_name !== undefined) patch.owner_name = snapshot.owner_name;
      await graph.updateKpi(entityId, patch);
      // Mirror to Postgres kpi_definitions if present (table is dual-
      // written today; some old tenants may not have it but the column
      // set is stable). Tolerate missing rows / table.
      try {
        const pgPatch: Record<string, unknown> = {};
        if (snapshot.name !== undefined) pgPatch.name = snapshot.name;
        if (snapshot.description !== undefined) pgPatch.description = snapshot.description;
        if (snapshot.formula_plain_text !== undefined) pgPatch.formula_plain_text = snapshot.formula_plain_text;
        if (snapshot.formula_sql !== undefined) pgPatch.formula_sql = snapshot.formula_sql;
        if (Object.keys(pgPatch).length > 0) {
          await db('kpi_definitions').where({ id: entityId }).update(pgPatch);
        }
      } catch { /* kpi_definitions table optional in Phase 7 */ }
    }

    await invalidateSemanticCache(await scopeForEntity(db, entityType, entityId));

    // Record a new version entry for the revert
    const changes = computeChanges(currentSnapshot, snapshot);
    await recordVersion(
      db,
      req.user!.tenantId,
      entityType,
      entityId,
      snapshot,
      changes,
      req.user!.sub,
      `Reverted to version ${version}`,
    );

    // Record audit log
    await auditLog(
      db,
      req.user!.tenantId,
      req.user!.sub,
      req.user!.name as string,
      'revert',
      entityType,
      entityId,
      null,
      { reverted_to_version: version },
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Version History + Diff
// ---------------------------------------------------------------------------

// GET /api/semantic/history?entityType=table&entityId=5
router.get('/history', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { entityType, entityId } = req.query as { entityType: string; entityId: string };
    if (!entityType || !entityId) {
      res.status(400).json({ ok: false, error: 'entityType and entityId required' });
      return;
    }

    const rows = await db('definition_versions')
      .where({ entity_type: entityType, entity_id: Number(entityId) })
      .orderBy('version', 'desc')
      .limit(50);

    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/semantic/diff?entityType=table&entityId=5&v1=1&v2=2
router.get('/diff', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { entityType, entityId, v1, v2 } = req.query as Record<string, string>;
    if (!entityType || !entityId || !v1 || !v2) {
      res.status(400).json({ ok: false, error: 'entityType, entityId, v1, v2 required' });
      return;
    }

    const [snap1, snap2] = await Promise.all([
      db('definition_versions')
        .where({ entity_type: entityType, entity_id: Number(entityId), version: Number(v1) })
        .first(),
      db('definition_versions')
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
    const db = reqDb(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entityType = req.query.entityType as string | undefined;
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;

    let query = db('audit_log').orderBy('created_at', 'desc').limit(limit);
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
    const db = reqDb(req);
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

    if (!['table', 'column', 'kpi', 'product_table', 'product_column'].includes(entityType)) {
      res.status(400).json({ ok: false, error: 'Invalid entityType' });
      return;
    }

    // entityId is body-supplied and reaches an unscoped graph write below.
    if (!await denyUnlessOwnedEntity(req, res, entityType, entityId)) return;

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

    await graph.updateApprovalStatus(entityType as 'table' | 'column' | 'kpi' | 'product_table' | 'product_column', entityId, updates);

    // Mirror approval status to Postgres for the entity types that have
    // approval columns. Home health counts + /review queue read these
    // directly. table/column/kpi each have approval_status; product_*
    // entities live only in Neo4j today (no Postgres mirror needed).
    try {
        const pgPatch: Record<string, unknown> = {
        approval_status: updates.approval_status,
        approved_by: updates.approved_by ?? null,
        approved_at: updates.approved_at ?? null,
        rejection_reason: updates.rejection_reason ?? null,
      };
      // Approving an AI draft also clears the draft flag — same
      // semantic as PATCH /tables/:id, /columns/:id confirm flow.
      if (action === 'approve') pgPatch.ai_draft = false;
      if (entityType === 'table') {
        await db('source_tables').where({ id: entityId }).update(pgPatch);
      } else if (entityType === 'column') {
        await db('source_columns').where({ id: entityId }).update(pgPatch);
      } else if (entityType === 'kpi') {
        await db('kpi_definitions').where({ id: entityId }).update(pgPatch).catch(() => { /* table optional */ });
      }
    } catch (e) {
      log.error({ err: e }, '[semantic POST /approve] postgres mirror failed');
    }

    await invalidateSemanticCache(await scopeForEntity(db, entityType, entityId));
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, action, entityType, entityId, null, { reason });

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
    const db = reqDb(req);
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
    // Table/column ids below are resolved from this connection, so authorising
    // the connection authorises the whole batch.
    if (!await denyUnlessOwned(req, res, 'connections', connectionId)) return;

    let updated = 0;
    let skipped = 0;

    // Tenant-scope so the Postgres mirror writes pass RLS.

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
          // Mirror to Postgres source_columns. Importing a CSV is a
          // confirm-style action — clear ai_draft so Home counts pick
          // it up. Tolerate any single-row mismatch.
          await db('source_columns')
            .where({ id: col.id })
            .update({ ...patch, ai_draft: false })
            .catch(() => { /* skip silently — Neo4j write already succeeded */ });
          await recordVersion(db, req.user!.tenantId, 'column', col.id, patch, null, req.user!.sub, 'bulk import');
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
          // Mirror to Postgres source_tables.
          const pgPatch: Record<string, unknown> = { ai_draft: false };
          if (def.display_name !== undefined) pgPatch.display_name = def.display_name;
          if (def.description !== undefined) pgPatch.description = def.description;
          if (def.domains !== undefined) pgPatch.domains = JSON.stringify(def.domains);
          // grain has no Postgres column today — Neo4j-only. Skip silently.
          await db('source_tables')
            .where({ id: table.id as number })
            .update(pgPatch)
            .catch(() => { /* skip silently — Neo4j write already succeeded */ });
          await recordVersion(db, req.user!.tenantId, 'table', table.id as number, patch, null, req.user!.sub, 'bulk import');
          updated++;
        }
      }
    }

    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'import', 'table', null, null, { updated, skipped, total: definitions.length });

    res.json({ ok: true, data: { updated, skipped } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Data Dictionary Export
// ---------------------------------------------------------------------------

// GET /api/semantic/dictionary?connectionId=1&format=html|json
router.get('/dictionary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
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
      const conn = await db('connections').where({ id: connectionId }).first();
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

      html += `<div class="footer">Clarion Data Dictionary — auto-generated</div></body></html>`;

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

// ---------------------------------------------------------------------------
// Data Dictionary Export — CSV
// ---------------------------------------------------------------------------

// GET /api/semantic/export/csv?connectionId=1
router.get('/export/csv', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const connectionId = Number(req.query.connectionId);
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const tables = await graph.getTablesByConnection(connectionId);
    const allColumns = await graph.getColumnsByConnection(connectionId);

    type TableRow = { id: number; table_name: string; display_name: string; description: string; row_count: number | null };
    type ColRow = { table_id: number; table_name?: string; column_name: string; display_name: string; data_type: string; description: string; is_dimension: boolean; is_measure: boolean; column_role: string };

    // Build a table_name lookup
    const tableNameMap = new Map((tables as TableRow[]).map((t) => [t.id, t.table_name]));

    // Flat CSV: one row per column
    const headers = ['table_name', 'column_name', 'display_name', 'data_type', 'description', 'is_dimension', 'is_measure'];
    const rows = (allColumns as ColRow[]).map((c) => [
      tableNameMap.get(c.table_id) ?? '',
      c.column_name ?? '',
      c.display_name ?? '',
      c.data_type ?? '',
      c.description ?? '',
      String(c.is_dimension ?? false),
      String(c.is_measure ?? false),
    ]);

    const csv = buildCsv(headers, rows);
    const filename = `data-dictionary-${connectionId}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Data Dictionary Export — XLSX (multi-sheet)
// ---------------------------------------------------------------------------

// GET /api/semantic/export/xlsx?connectionId=1
router.get('/export/xlsx', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const connectionId = Number(req.query.connectionId);
    if (!connectionId) {
      res.status(400).json({ ok: false, error: 'connectionId required' });
      return;
    }

    const tables = await graph.getTablesByConnection(connectionId);
    const allColumns = await graph.getColumnsByConnection(connectionId);
    const relationships = await graph.getRelationshipsForConnection(connectionId);
    const kpis = await graph.getKpisByConnection(connectionId);

    type TableRow = { id: number; table_name: string; display_name: string; description: string; domains: string[] | string; row_count: number | null; approval_status: string };
    type ColRow = { table_id: number; column_name: string; display_name: string; data_type: string; description: string; column_role: string; is_nullable: boolean; is_dimension: boolean; is_measure: boolean; approval_status: string };
    type RelRow = { from_table: string; from_column: string; to_table: string; to_column: string; relationship_type: string };
    type KpiRow = { name: string; description: string; formula_sql: string; target_value: number | null; unit: string | null };

    const tableNameMap = new Map((tables as TableRow[]).map((t) => [t.id, t.table_name]));

    // Sheet 1: Tables
    const tablesSheet = {
      name: 'Tables',
      headers: ['table_name', 'display_name', 'description', 'domain', 'row_count', 'approval_status'],
      rows: (tables as TableRow[]).map((t) => {
        const domains = Array.isArray(t.domains) ? t.domains.join(', ') : (t.domains ?? '');
        return [t.table_name, t.display_name ?? '', t.description ?? '', domains, t.row_count ?? '', t.approval_status ?? ''];
      }),
    };

    // Sheet 2: Columns
    const columnsSheet = {
      name: 'Columns',
      headers: ['table_name', 'column_name', 'display_name', 'data_type', 'description', 'column_role', 'is_nullable', 'approval_status'],
      rows: (allColumns as ColRow[]).map((c) => {
        const role = c.column_role ?? (c.is_dimension ? 'dimension' : c.is_measure ? 'measure' : '');
        return [
          tableNameMap.get(c.table_id) ?? '',
          c.column_name, c.display_name ?? '', c.data_type ?? '', c.description ?? '',
          role, String(c.is_nullable ?? ''), c.approval_status ?? '',
        ];
      }),
    };

    // Sheet 3: Relationships
    const relsSheet = {
      name: 'Relationships',
      headers: ['from_table', 'from_column', 'to_table', 'to_column', 'relationship_type'],
      rows: (relationships as RelRow[]).map((r) => [
        r.from_table ?? '', r.from_column ?? '', r.to_table ?? '', r.to_column ?? '', r.relationship_type ?? '',
      ]),
    };

    // Sheet 4: KPIs
    const kpisSheet = {
      name: 'KPIs',
      headers: ['name', 'description', 'formula', 'target_value', 'unit'],
      rows: (kpis as KpiRow[]).map((k) => [
        k.name ?? '', k.description ?? '', k.formula_sql ?? '', k.target_value ?? '', k.unit ?? '',
      ]),
    };

    const xlsx = buildXlsx([tablesSheet, columnsSheet, relsSheet, kpisSheet]);
    const filename = `data-dictionary-${connectionId}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsx);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Product Tables — mirrored in Neo4j for governance
// ---------------------------------------------------------------------------

// GET /api/semantic/product-tree — Hierarchical product tree for sidebar
router.get('/product-tree', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { products: allProducts } = await graph.getProductTree();

    // getProductTree() is unscoped — it returns EVERY tenant's products, and the
    // enrichment below tolerates a missing Postgres row ("Product <id>"), so
    // without this filter another tenant's star schemas and table lists were
    // returned verbatim to any authenticated caller. Keep only what we own.
    const owned = await ownedIds(db, 'data_products', allProducts.map((p) => p.dataProductId), req.user?.tenantId);
    const products = allProducts.filter((p) => owned.has(Number(p.dataProductId)));

    // Enrich with product/schema names from Postgres
    const allProductIds = products.map((p) => p.dataProductId);
    const productRows = allProductIds.length
      ? await db('data_products').whereIn('id', allProductIds).select('id', 'name', 'connection_id', 'status')
      : [];
    const productMap = new Map(productRows.map((p: { id: number; name: string; connection_id: number; status: string }) => [p.id, p]));

    // Get star schema names
    const schemaRows = allProductIds.length
      ? await db('star_schemas').whereIn('data_product_id', allProductIds).select('id', 'data_product_id', 'name')
      : [];
    const schemaMap = new Map(schemaRows.map((s: { id: number; data_product_id: number; name: string }) => [s.id, s]));

    // The graph's table `id` is the MINTED neo4j_pg_id, not the Postgres
    // product_tables.id — but the detail panel's preview/SQL/lineage calls
    // need the Postgres id. Resolve it here (neo4j_pg_id → id) and ship it as
    // `pg_table_id` on every table, so consumers never have to guess which id
    // space they hold. Works for existing data — no graph rewrite needed.
    const schemaIds = schemaRows.map((s: { id: number }) => s.id);
    const pgRows = schemaIds.length
      ? await db('product_tables').whereIn('star_schema_id', schemaIds).select('id', 'neo4j_pg_id')
      : [];
    const pgByGraphId = new Map<number, number>();
    for (const r of pgRows as Array<{ id: number; neo4j_pg_id: number | null }>) {
      if (r.neo4j_pg_id != null) pgByGraphId.set(Number(r.neo4j_pg_id), Number(r.id));
    }

    const tree = products.map((p) => {
      const product = productMap.get(p.dataProductId);
      // Group tables by star_schema_id
      const schemaGroups = new Map<number, { schemaId: number; schemaName: string; tables: Record<string, unknown>[] }>();
      for (const table of p.tables) {
        const ssid = table.star_schema_id as number;
        if (!schemaGroups.has(ssid)) {
          const schema = schemaMap.get(ssid);
          schemaGroups.set(ssid, {
            schemaId: ssid,
            schemaName: schema?.name ?? 'Schema',
            tables: [],
          });
        }
        const pgTableId = pgByGraphId.get(Number(table.id)) ?? null;
        schemaGroups.get(ssid)!.tables.push({ ...table, pg_table_id: pgTableId });
      }

      return {
        productId: p.dataProductId,
        productName: product?.name ?? `Product ${p.dataProductId}`,
        connectionId: product?.connection_id ?? null,
        status: product?.status ?? 'unknown',
        starSchemas: Array.from(schemaGroups.values()),
      };
    });

    res.json({ ok: true, data: tree });
  } catch (err) { next(err); }
});

// GET /api/semantic/product-tables?dataProductId=X — Product tables from Neo4j
router.get('/product-tables', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const dataProductId = Number(req.query.dataProductId);
    if (!dataProductId) {
      res.status(400).json({ ok: false, error: 'dataProductId required' });
      return;
    }
    if (!await denyUnlessOwned(req, res, 'data_products', dataProductId)) return;
    const rows = await graph.getProductTablesByProduct(dataProductId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/semantic/product-columns?tablePgId=X — Product columns from Neo4j
router.get('/product-columns', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tablePgId = Number(req.query.tablePgId);
    if (!tablePgId) {
      res.status(400).json({ ok: false, error: 'tablePgId required' });
      return;
    }
    if (!await denyUnlessOwned(req, res, 'product_tables', tablePgId)) return;
    const rows = await graph.getProductColumnsByTablePgId(tablePgId);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/product-tables/:id — Update product table definition
router.patch('/product-tables/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const pgId = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    if (!await denyUnlessOwned(req, res, 'product_tables', pgId)) return;

    await graph.updateProductTable(pgId, {
      display_name: body.display_name,
      description:  body.description,
      owner_name:   body.owner_name,
      domains:      body.domains,
    });

    await invalidateSemanticCache(await connectionIdForEntity(db, 'product_tables', pgId) ?? undefined);
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'product_table', pgId, body.display_name as string ?? null, body);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/semantic/product-columns/:id — Update product column definition
router.patch('/product-columns/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const pgId = Number(req.params.id);
    const body = req.body as Record<string, unknown>;

    if (!await denyUnlessOwned(req, res, 'product_columns', pgId)) return;

    await graph.updateProductColumn(pgId, {
      display_name: body.display_name,
      description:  body.description,
      owner_name:   body.owner_name,
      column_role:  body.column_role,
    });

    await invalidateSemanticCache(await connectionIdForEntity(db, 'product_columns', pgId) ?? undefined);
    await auditLog(db, req.user!.tenantId, req.user!.sub, req.user!.name as string, 'update', 'product_column', pgId, body.display_name as string ?? null, body);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/semantic/product-tables/:id/improve-description  { instruction }
router.post('/product-tables/:id/improve-description', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'Invalid id' }); return; }
    const instruction = readInstruction(req, res);
    if (instruction === null) return;

    // The catalog panel holds the graph-minted id (neo4j_pg_id) — accept both
    // id spaces. RLS on reqDb keeps this tenant-scoped either way.
    const table = await db('product_tables')
      .where((qb) => { qb.where('id', id).orWhere('neo4j_pg_id', id); })
      .first();
    if (!table) { res.status(404).json({ ok: false, error: 'Table not found' }); return; }

    const proposal = await improveDescription({
      entityType: 'table',
      name: String(table.display_name || table.table_name || 'table'),
      currentDescription: String(table.description ?? ''),
      instruction,
    });

    res.json({ ok: true, data: { current_description: String(table.description ?? ''), ai_proposal: proposal, instruction } });
  } catch (err) { next(err); }
});

// POST /api/semantic/product-columns/:id/improve-description  { instruction }
router.post('/product-columns/:id/improve-description', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: 'Invalid id' }); return; }
    const instruction = readInstruction(req, res);
    if (instruction === null) return;

    // Same dual-id tolerance as product-tables above: the catalog panel sends
    // the graph-minted id.
    const col = await db('product_columns')
      .where((qb) => { qb.where('id', id).orWhere('neo4j_pg_id', id); })
      .first();
    if (!col) { res.status(404).json({ ok: false, error: 'Column not found' }); return; }
    const parent = col.product_table_id
      ? await db('product_tables').where({ id: col.product_table_id }).first()
      : null;

    const proposal = await improveDescription({
      entityType: 'column',
      name: String(col.display_name || col.column_name || 'column'),
      tableName: parent ? String(parent.display_name || parent.table_name) : null,
      dataType: col.data_type ?? null,
      currentDescription: String(col.description ?? ''),
      instruction,
    });

    res.json({ ok: true, data: { current_description: String(col.description ?? ''), ai_proposal: proposal, instruction } });
  } catch (err) { next(err); }
});

// POST /api/semantic/improve-text  { entityType, name, currentDescription, instruction, tableName?, dataType? }
// Generic, id-less variant for surfaces that tune an in-memory draft (e.g. a
// new KPI's description before it's saved). No DB lookup — operates purely on
// the supplied text via the same safe schema-class AI call.
router.post('/improve-text', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const instruction = readInstruction(req, res);
    if (instruction === null) return;
    const b = req.body as Record<string, unknown>;
    const entityType = (typeof b.entityType === 'string' && b.entityType.trim()) ? b.entityType.trim().slice(0, 32) : 'item';
    const name = typeof b.name === 'string' ? b.name.slice(0, 200) : '';
    const currentDescription = typeof b.currentDescription === 'string' ? b.currentDescription.slice(0, 4000) : '';

    const proposal = await improveDescription({
      entityType,
      name,
      tableName: typeof b.tableName === 'string' ? b.tableName.slice(0, 200) : null,
      dataType: typeof b.dataType === 'string' ? b.dataType.slice(0, 64) : null,
      currentDescription,
      instruction,
    });

    res.json({ ok: true, data: { current_description: currentDescription, ai_proposal: proposal, instruction } });
  } catch (err) { next(err); }
});

// GET /api/semantic/product-preview?productTableId=123&limit=10
//
// ALL ROLES on purpose (owner decision, 2026-08-27 — data-experience
// consolidation Release A): this returns ROWS of the tenant's own product
// tables, which every role can already read through Ask AI; the
// non-negotiable is about SQL, not data. It was admin-only while two
// consumer catalog panels advertised a Sample tab — a 403 as UX. Tenant
// scoping is unchanged (resolveProductTableById matches tenant_id).
router.get('/product-preview', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { productTableId, limit = '10' } = req.query as Record<string, string>;
    if (!productTableId) {
      res.status(400).json({ ok: false, error: 'productTableId is required' });
      return;
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

    // Resolve via the table catalog. If the row is missing or hasn't
    // been materialised yet, the catalog returns null; if it has, we
    // get a host-usable URI without touching delta_path or the schema
    // directly. Try neo4j_pg_id first (frontend uses pg ids), then
    // the row's own primary key.
    const pgIdNum = Number(productTableId);
    const { resolveProductTableById } = await import('../services/tableCatalog');
    const idLookup = await db('product_tables')
      .where({ neo4j_pg_id: pgIdNum })
      .select('id')
      .first();
    const internalId = idLookup ? Number(idLookup.id) : pgIdNum;
    const resolved = await resolveProductTableById(req.user!.tenantId, internalId);

    if (!resolved) {
      // Distinguish between "row doesn't exist" vs "exists but not materialised".
      const exists = await db('product_tables').where({ id: internalId }).first();
      if (!exists) {
        res.status(404).json({ ok: false, error: 'Product table not found' });
      } else {
        res.status(400).json({ ok: false, error: 'No data yet — run the transformation for this table first.' });
      }
      return;
    }

    const tableName = resolved.tableName;
    const deltaPath = resolved.uri;
    const pathMod = await import('path');
    const fsMod = await import('fs');
    const isAzure = isAzurePath(deltaPath);
    const parentDir = pathMod.dirname(deltaPath);

    // Local-only sanity check — surface a clear message rather than a DuckDB error.
    if (!isAzure && !fsMod.existsSync(deltaPath)) {
      res.status(400).json({
        ok: false,
        error: `Data files not found at ${deltaPath}. Re-run the transformation, or check that the warehouse path is mounted on this host.`,
      });
      return;
    }

    // Create DuckDB connector with the parent dir as warehouse and the table name
    const { DuckDBConnector } = await import('../connectors/DuckDBConnector');
    const tablePaths = new Map<string, string>();
    tablePaths.set(tableName, deltaPath);
    const connector = new DuckDBConnector(parentDir, [tableName], tablePaths);

    try {
      await connector.connect();
      const result = await connector.executeQuery(
        `SELECT * FROM "${tableName}" LIMIT ${safeLimit}`,
      );

      res.json({
        ok: true,
        data: {
          rows: result.rows,
          columns: result.rows.length ? Object.keys(result.rows[0] as object) : [],
        },
      });
    } catch (queryErr) {
      const msg = queryErr instanceof Error ? queryErr.message : 'Preview query failed';
      res.status(400).json({
        ok: false,
        error: `Could not read "${tableName}" from ${deltaPath}: ${msg}`,
      });
    } finally {
      try { connector.disconnect(); } catch { /* ignore */ }
    }
  } catch (err) { next(err); }
});

// GET /api/semantic/product-tables/:id/sql — Return transformation SQL for a product table.
// Resolves by neo4j_pg_id first (frontend uses pgId), then falls back to native id.
router.get('/product-tables/:id/sql', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const idNum = Number(req.params.id);
    if (!idNum) {
      res.status(400).json({ ok: false, error: 'id required' });
      return;
    }

    let row = await db('product_tables')
      .where({ neo4j_pg_id: idNum })
      .first('id', 'table_name', 'transformation_sql', 'transformation_status', 'last_run_at', 'last_run_error');
    if (!row) {
      row = await db('product_tables')
        .where({ id: idNum })
        .first('id', 'table_name', 'transformation_sql', 'transformation_status', 'last_run_at', 'last_run_error');
    }
    if (!row) {
      res.status(404).json({ ok: false, error: 'Product table not found' });
      return;
    }

    res.json({
      ok: true,
      data: {
        table_name: row.table_name,
        transformation_sql: row.transformation_sql ?? null,
        transformation_status: row.transformation_status ?? null,
        last_run_at: row.last_run_at ?? null,
        last_run_error: row.last_run_error ?? null,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Pending approvals — items waiting for human review
// ---------------------------------------------------------------------------

router.get('/pending-approvals', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const items: Array<{ id: number; type: string; name: string; description: string; status: string; updated_at: string }> = [];

    // Tables with ai_draft=true or approval_status='pending'
    const tables = await db('source_tables')
      .where(function() {
        this.where('ai_draft', true).orWhere('approval_status', 'pending');
      })
      .select('id', 'table_name', 'display_name', 'description', 'approval_status', 'ai_draft', 'updated_at')
      .orderBy('updated_at', 'desc')
      .limit(50);
    for (const t of tables) {
      items.push({ id: t.id, type: 'table', name: t.display_name || t.table_name, description: t.description ?? '', status: t.ai_draft ? 'ai_draft' : (t.approval_status ?? 'pending'), updated_at: t.updated_at });
    }

    // Columns with ai_draft=true or approval_status='pending'
    const columns = await db('source_columns as c')
      .join('source_tables as t', 'c.table_id', 't.id')
      .where(function() {
        this.where('c.ai_draft', true).orWhere('c.approval_status', 'pending');
      })
      .select('c.id', 'c.column_name', 'c.display_name', 'c.description', 'c.approval_status', 'c.ai_draft', 'c.updated_at', 't.table_name as parent_table')
      .orderBy('c.updated_at', 'desc')
      .limit(100);
    for (const c of columns) {
      items.push({ id: c.id, type: 'column', name: `${c.parent_table}.${c.display_name || c.column_name}`, description: c.description ?? '', status: c.ai_draft ? 'ai_draft' : (c.approval_status ?? 'pending'), updated_at: c.updated_at });
    }

    // Relationships with ai_draft=true. Different shape: no approval_status,
    // no updated_at column on table_relationships (only id + ai_draft).
    // We synthesise a name that reads naturally in the review queue:
    //   "orders.customer_id → customers.id  (many_to_one)"
    // and use the row id as a stable sort key (highest id = most recently
    // discovered, since the SchemaProfiler inserts them in batches).
    const relationships = await db('table_relationships as r')
      .leftJoin('source_tables as ft', 'r.from_table_id', 'ft.id')
      .leftJoin('source_columns as fc', 'r.from_column_id', 'fc.id')
      .leftJoin('source_tables as tt', 'r.to_table_id',   'tt.id')
      .leftJoin('source_columns as tc', 'r.to_column_id',   'tc.id')
      .where('r.ai_draft', true)
      .select(
        'r.id',
        'r.relationship_type',
        'r.description',
        'ft.table_name as from_table',
        'fc.column_name as from_column',
        'tt.table_name as to_table',
        'tc.column_name as to_column',
      )
      .orderBy('r.id', 'desc')
      .limit(100);
    for (const r of relationships) {
      const fromText = r.from_table && r.from_column ? `${r.from_table}.${r.from_column}` : '?';
      const toText   = r.to_table   && r.to_column   ? `${r.to_table}.${r.to_column}`     : '?';
      const typeText = r.relationship_type ? ` (${String(r.relationship_type).replace(/_/g, '-')})` : '';
      items.push({
        id: Number(r.id),
        type: 'relationship',
        name: `${fromText} → ${toText}${typeText}`,
        description: r.description ?? '',
        status: 'ai_draft',
        // Synthesise a sort timestamp from the id so the cross-type sort
        // below still works (newer id = more recent). Using a fixed
        // future epoch offset ensures relationships group at the end of
        // the timeline rather than dominating it; clients sort by
        // updated_at desc so they appear after fresh table/column edits.
        updated_at: new Date(0).toISOString(),
      });
    }

    // Sort by most recent. Relationships carry epoch-0 so they sort
    // last; within their own group the slice ordering is preserved
    // (highest-id-first via the orderBy above).
    items.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    res.json({ ok: true, data: items.slice(0, 200) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Global search — Cmd+K palette
// ---------------------------------------------------------------------------

router.get('/search', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 10, 20);
    if (!q) { res.json({ ok: true, data: [] }); return; }

    const results: Array<{ type: string; id: number; name: string; parent?: string; connectionName?: string }> = [];

    // Search source tables
    const tables = await db('source_tables as t')
      .join('connections as c', 't.connection_id', 'c.id')
      .whereRaw('LOWER(t.table_name) LIKE ? OR LOWER(t.display_name) LIKE ?', [`%${q}%`, `%${q}%`])
      .select('t.id', 't.table_name', 't.display_name', 'c.name as connection_name')
      .limit(limit);
    for (const t of tables) {
      results.push({ type: 'table', id: t.id, name: t.display_name || t.table_name, connectionName: t.connection_name });
    }

    // Search source columns
    const columns = await db('source_columns as col')
      .join('source_tables as t', 'col.table_id', 't.id')
      .whereRaw('LOWER(col.column_name) LIKE ? OR LOWER(col.display_name) LIKE ?', [`%${q}%`, `%${q}%`])
      .select('col.id', 'col.column_name', 'col.display_name', 't.display_name as table_display_name', 't.table_name')
      .limit(limit);
    for (const c of columns) {
      results.push({ type: 'column', id: c.id, name: c.display_name || c.column_name, parent: c.table_display_name || c.table_name });
    }

    // Search KPIs
    const kpis = await db('kpi_definitions')
      .whereRaw('LOWER(name) LIKE ? OR LOWER(description) LIKE ?', [`%${q}%`, `%${q}%`])
      .select('id', 'name')
      .limit(limit);
    for (const k of kpis) {
      results.push({ type: 'kpi', id: k.id, name: k.name });
    }

    // Search dashboards
    const dashboards = await db('dashboards')
      .whereRaw('LOWER(name) LIKE ?', [`%${q}%`])
      .select('id', 'name')
      .limit(limit);
    for (const d of dashboards) {
      results.push({ type: 'dashboard', id: d.id, name: d.name });
    }

    // Search data products
    const products = await db('data_products')
      .whereRaw('LOWER(name) LIKE ?', [`%${q}%`])
      .select('id', 'name')
      .limit(limit);
    for (const p of products) {
      results.push({ type: 'product', id: p.id, name: p.name });
    }

    // Sort by relevance (exact prefix match first, then contains)
    results.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    });

    res.json({ ok: true, data: results.slice(0, limit) });
  } catch (err) { next(err); }
});

export default router;
