/**
 * Relationship canvas API.
 *
 * The surface behind the cross-source relationship pane, built around one
 * interaction: drag a line between two columns and get a real answer from the
 * data instead of a form asking you to declare the cardinality yourself.
 *
 *   GET  /graph          the tenant's whole relationship graph, across sources
 *   POST /measure        does this JOIN hold? containment, cardinality, orphans
 *   POST /match-preview  how well do two SOURCES line up? rate + the misses
 *
 * `/measure` and `/match-preview` are separate because a join and a match are
 * different objects (see docs/backlog/relationship-canvas.md §2.2): one is
 * verified by containment against a key, the other by how many rows find a
 * partner. Answering both with one endpoint would mean answering one of them
 * with the wrong question.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  measureRelationshipSchema, matchPreviewSchema, checkRelationshipSchema,
  flagRelationshipSchema,
} from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { owns } from '../db/tenantOwnership';
import { createConnector } from '../connectors/ConnectorFactory';
import { measureRelationship } from '../services/relationshipMeasure';
import { compareColumnValues } from '../services/columnValues';
import { buildGraph, neighbourhood } from '../services/relationshipGraph';
import { measureMatch, type Normalisation } from '../services/matchMeasure';
import { buildTwoSourceConnector } from '../services/crossSourceSession';
import * as graph from '../db/semanticGraph';
import { connectionIdForEntity } from '../db/semanticCacheScope';
import { logger as rootLogger } from '../utils/logger';

const router = Router();
const log = rootLogger.child({ mod: 'routes/relationships' });

/**
 * Ownership gate — see db/tenantOwnership.ts.
 *
 * Table and column ids arrive in the request body and are used to read real
 * data out of a warehouse, so they must be proven to belong to the caller's
 * tenant before anything is resolved. Refuses with 404, never 403: a 403 would
 * confirm the id exists and belongs to someone else.
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

interface ColumnRow { id: number; table_id: number; column_name: string }
interface TableRow  { id: number; connection_id: number; table_name: string }

// ---------------------------------------------------------------------------
// GET /api/relationships/graph — the tenant's whole relationship graph
// ---------------------------------------------------------------------------
//
// Tenant-scoped, not connection-scoped: the canvas exists to show how sources
// connect to each other, so a per-connection view cannot express its subject.
//
// Reads Postgres rather than Neo4j — see services/relationshipGraph.ts for why
// that is deliberate and not an oversight.
//
// Query params, all optional:
//   connectionId   narrow to one source
//   anchorTableId  return only this table's neighbourhood
//   depth          hops from the anchor (default 1, max 3)
//   withColumns=1  include columns for the returned tables
router.get('/graph', requireAuth, requireRole('admin', 'analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const tenantId = req.user?.tenantId;
      if (!tenantId) { res.status(404).json({ ok: false, error: 'Not found' }); return; }

      const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;
      const anchorTableId = req.query.anchorTableId ? Number(req.query.anchorTableId) : undefined;
      const depth = Math.min(Math.max(Number(req.query.depth) || 1, 1), 3);
      const withColumns = req.query.withColumns === '1';

      if (connectionId !== undefined && !await denyUnlessOwned(req, res, 'connections', connectionId)) return;
      if (anchorTableId !== undefined && !await denyUnlessOwned(req, res, 'source_tables', anchorTableId)) return;

      // Every query filters tenant_id explicitly. RLS is the backstop, not the
      // control — reqDb can fall back to the global pool whose session-level
      // tenant variable has a documented race.
      const tableQuery = db('source_tables')
        .where({ tenant_id: tenantId, is_active: true })
        .select('id', 'connection_id', 'table_name', 'display_name', 'description');
      if (connectionId !== undefined) tableQuery.andWhere({ connection_id: connectionId });
      const tableRows = await tableQuery;

      const tableIds = tableRows.map((t: { id: number }) => t.id);

      // Relationships are fetched for the tenant and then filtered to the
      // visible tables in buildGraph, rather than filtered here: an edge is only
      // drawable when BOTH endpoints are in scope, and expressing that as SQL
      // costs a self-join for no benefit at this size.
      const relRows = tableIds.length
        ? await db('table_relationships')
            .where({ tenant_id: tenantId })
            .andWhere(function () {
              this.whereIn('from_table_id', tableIds).orWhereIn('to_table_id', tableIds);
            })
            .select(
              'id', 'kind', 'from_table_id', 'from_column_id', 'to_table_id', 'to_column_id',
              'relationship_type', 'description', 'ai_draft', 'confirmed_by_user',
              'measured', 'match_keys', 'flagged_at', 'flagged_reason', 'semantic_source',
            )
        : [];

      const visibleTableIds = anchorTableId !== undefined
        ? neighbourhood(anchorTableId, relRows, depth)
        : undefined;

      const graph = buildGraph(tableRows, relRows, { visibleTableIds });

      const sources = await db('connections')
        .where({ tenant_id: tenantId })
        .whereIn('id', [...new Set(graph.tables.map((t) => t.connectionId))])
        .select('id', 'name', 'type');

      let columns: unknown[] | undefined;
      if (withColumns && graph.tables.length) {
        columns = await db('source_columns')
          .where({ tenant_id: tenantId })
          .whereIn('table_id', graph.tables.map((t) => t.id))
          .select('id', 'table_id', 'column_name', 'data_type', 'display_name', 'is_dimension', 'is_measure');
      }

      res.json({
        ok: true,
        data: {
          sources: sources.map((s: { id: number; name: string; type: string }) => ({
            id: s.id, name: s.name, connectorType: s.type,
          })),
          ...graph,
          ...(columns ? { columns } : {}),
        },
      });
    } catch (err) { next(err); }
  },
);

// ---------------------------------------------------------------------------
// POST /api/relationships/measure — does this relationship hold in the data?
// ---------------------------------------------------------------------------
//
// Returns a measurement, never a verdict on whether the user may proceed. A
// weak or broken result is information: the source may not have finished
// syncing, or the user may know something the data does not show yet. The
// canvas reports and the human decides.
router.post('/measure', requireAuth, requireRole('admin', 'analyst'),
  validate(measureRelationshipSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const { fromTableId, fromColumnId, toTableId, toColumnId } = req.body as {
        fromTableId: number; fromColumnId: number; toTableId: number; toColumnId: number;
      };

      // Gate every id before it is resolved — all four, not just the tables:
      // a column id from another tenant would otherwise name a column we then
      // read data from.
      for (const [table, id] of [
        ['source_tables', fromTableId],
        ['source_tables', toTableId],
        ['source_columns', fromColumnId],
        ['source_columns', toColumnId],
      ] as const) {
        if (!await denyUnlessOwned(req, res, table, id)) return;
      }

      const tables: TableRow[] = await db('source_tables')
        .whereIn('id', [fromTableId, toTableId])
        .select('id', 'connection_id', 'table_name');
      const columns: ColumnRow[] = await db('source_columns')
        .whereIn('id', [fromColumnId, toColumnId])
        .select('id', 'table_id', 'column_name');

      const fromTable = tables.find((t) => t.id === Number(fromTableId));
      const toTable   = tables.find((t) => t.id === Number(toTableId));
      const fromCol   = columns.find((c) => c.id === Number(fromColumnId));
      const toCol     = columns.find((c) => c.id === Number(toColumnId));

      if (!fromTable || !toTable || !fromCol || !toCol) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }

      // A column must belong to the table it was submitted with. Without this
      // the caller could pair a table with a column from a different table they
      // also own, and we would compose SQL naming a column that does not exist
      // there — a confusing failure rather than a clear refusal.
      if (fromCol.table_id !== fromTable.id || toCol.table_id !== toTable.id) {
        res.status(400).json({ ok: false, error: 'Column does not belong to the table it was submitted with' });
        return;
      }

      // Cross-source measurement needs views from two connections registered in
      // one DuckDB session; `createConnector` is connection-scoped. That is a
      // later slice, and saying so plainly beats measuring the wrong thing.
      if (fromTable.connection_id !== toTable.connection_id) {
        res.status(400).json({
          ok: false,
          error: 'Measuring a relationship between two different sources is not available yet.',
          code: 'cross_source_unsupported',
        });
        return;
      }

      const connRow = await db('connections').where({ id: fromTable.connection_id }).first();
      if (!connRow) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }

      const connector = await createConnector(connRow as unknown as Parameters<typeof createConnector>[0]);
      try {
        await connector.connect();
        const measurement = await measureRelationship(
          connector,
          fromTable.table_name, fromCol.column_name,
          toTable.table_name, toCol.column_name,
        );
        log.info(
          {
            from: `${fromTable.table_name}.${fromCol.column_name}`,
            to: `${toTable.table_name}.${toCol.column_name}`,
            verdict: measurement.verdict,
            ms: measurement.elapsedMs,
          },
          'measured relationship',
        );
        res.json({ ok: true, data: measurement });
      } finally {
        // Always release, including when measurement threw internally — a
        // leaked warehouse session outlives the popover that asked for it.
        // `disconnect` is synchronous and may throw on an already-closed
        // handle, which must not mask the response we are about to send.
        try { connector.disconnect(); } catch { /* already closed */ }
      }
    } catch (err) { next(err); }
  },
);


// ---------------------------------------------------------------------------
// POST /api/relationships/match-preview — how well do two SOURCES line up?
// ---------------------------------------------------------------------------
//
// The cross-source counterpart of /measure. A link between two sources is not a
// foreign key, so containment is the wrong question; this answers "how many rows
// actually find a partner", in both directions, with a sample of the ones that
// do not.
//
// The samples are the useful part. A rate on its own tells you there is a gap;
// seeing that every miss is formatted `BE 0123.456.789` against `BE0123456789`
// tells you it is a formatting problem, not a data problem.
router.post('/match-preview', requireAuth, requireRole('admin', 'analyst'),
  validate(matchPreviewSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const { fromTableId, fromColumnId, toTableId, toColumnId, normalisation } = req.body as {
        fromTableId: number; fromColumnId: number; toTableId: number; toColumnId: number;
        normalisation?: Normalisation;
      };

      for (const [table, id] of [
        ['source_tables', fromTableId],
        ['source_tables', toTableId],
        ['source_columns', fromColumnId],
        ['source_columns', toColumnId],
      ] as const) {
        if (!await denyUnlessOwned(req, res, table, id)) return;
      }

      const tables: TableRow[] = await db('source_tables')
        .whereIn('id', [fromTableId, toTableId])
        .select('id', 'connection_id', 'table_name');
      const columns: ColumnRow[] = await db('source_columns')
        .whereIn('id', [fromColumnId, toColumnId])
        .select('id', 'table_id', 'column_name');

      const fromTable = tables.find((t) => t.id === Number(fromTableId));
      const toTable = tables.find((t) => t.id === Number(toTableId));
      const fromCol = columns.find((c) => c.id === Number(fromColumnId));
      const toCol = columns.find((c) => c.id === Number(toColumnId));

      if (!fromTable || !toTable || !fromCol || !toCol) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      if (fromCol.table_id !== fromTable.id || toCol.table_id !== toTable.id) {
        res.status(400).json({ ok: false, error: 'Column does not belong to the table it was submitted with' });
        return;
      }

      const connector = await buildTwoSourceConnector(
        req.user?.tenantId,
        { connectionId: fromTable.connection_id, tableName: fromTable.table_name },
        { connectionId: toTable.connection_id, tableName: toTable.table_name },
      );
      if (!connector) {
        // Not an error: one of the sources has not been synced into the
        // warehouse yet, which is a state the user can fix.
        res.json({
          ok: true,
          data: {
            ok: false, reason: 'table-not-found',
            normalisation: normalisation ?? 'loose',
            left: null, right: null, matchRate: null, elapsedMs: 0,
          },
        });
        return;
      }

      try {
        await connector.connect();
        const result = await measureMatch(
          connector, fromCol.column_name, toCol.column_name, normalisation ?? 'loose',
        );
        log.info(
          {
            from: `${fromTable.table_name}.${fromCol.column_name}`,
            to: `${toTable.table_name}.${toCol.column_name}`,
            rate: result.matchRate, ms: result.elapsedMs,
          },
          'measured cross-source match',
        );
        res.json({ ok: true, data: result });
      } finally {
        try { connector.disconnect(); } catch { /* already closed */ }
      }
    } catch (err) { next(err); }
  },
);

// ---------------------------------------------------------------------------
// POST /api/relationships/:id/check
// ---------------------------------------------------------------------------
//
// Re-measure an EXISTING relationship and cache the result on the row.
//
// **Measuring is not deciding, and that distinction is the whole reason this
// route exists.** The obvious way to store a measurement is
// `PATCH /semantic/relationships/:id { measured }` — but that handler treats
// any patch as a human acting on the relationship: it stamps
// `confirmed_by_user = true` and clears `ai_draft`. So "check this again"
// silently confirmed an AI suggestion nobody had looked at, and a
// check-the-whole-table run would have emptied the review queue as a side
// effect of asking a question. This writes `measured` and nothing else.
//
// `withExamples` is false for a table-wide sweep: sampling values costs a
// third query per relationship, and in a list of pass/fail the values are what
// you look at afterwards, on the one that failed.
router.post('/:id/check', requireAuth, requireRole('admin', 'analyst'),
  validate(checkRelationshipSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ ok: false, error: 'Invalid id' });
        return;
      }
      const withExamples = req.body?.withExamples !== false;

      // Scope resolves through from_table_id — table_relationships carries no
      // connection_id, and adding a second path to the same answer is how the
      // two drift apart.
      const rel = await db('table_relationships')
        .where({ id })
        .select('id', 'from_table_id', 'to_table_id', 'from_column_id', 'to_column_id', 'kind')
        .first();
      if (!rel) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      // BOTH endpoints, not just the one scope resolves through: a relationship
      // reaching into another tenant's table would otherwise have that table's
      // data read and its column names composed into SQL.
      if (!await denyUnlessOwned(req, res, 'source_tables', rel.from_table_id)) return;
      if (!await denyUnlessOwned(req, res, 'source_tables', rel.to_table_id)) return;

      // A relationship with an endpoint column missing cannot express a join,
      // so there is nothing to measure — say so rather than measuring
      // something else. Same for a match, which is a different test entirely.
      if (!rel.from_column_id || !rel.to_column_id) {
        res.status(400).json({ ok: false, error: 'This link does not name a column on both sides yet.', code: 'no_columns' });
        return;
      }
      if (rel.kind === 'match') {
        res.status(400).json({ ok: false, error: 'A cross-source match is checked differently.', code: 'is_match' });
        return;
      }

      const tables: TableRow[] = await db('source_tables')
        .whereIn('id', [rel.from_table_id, rel.to_table_id])
        .select('id', 'connection_id', 'table_name');
      const columns: ColumnRow[] = await db('source_columns')
        .whereIn('id', [rel.from_column_id, rel.to_column_id])
        .select('id', 'table_id', 'column_name');

      const fromTable = tables.find((t) => t.id === rel.from_table_id);
      const toTable   = tables.find((t) => t.id === rel.to_table_id);
      const fromCol   = columns.find((c) => c.id === rel.from_column_id);
      const toCol     = columns.find((c) => c.id === rel.to_column_id);
      if (!fromTable || !toTable || !fromCol || !toCol) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      if (fromTable.connection_id !== toTable.connection_id) {
        res.status(400).json({
          ok: false,
          error: 'Measuring a relationship between two different sources is not available yet.',
          code: 'cross_source_unsupported',
        });
        return;
      }

      const connRow = await db('connections').where({ id: fromTable.connection_id }).first();
      if (!connRow) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }

      const connector = await createConnector(connRow as unknown as Parameters<typeof createConnector>[0]);
      let measurement;
      try {
        await connector.connect();
        measurement = await measureRelationship(
          connector,
          fromTable.table_name, fromCol.column_name,
          toTable.table_name, toCol.column_name,
          { examples: withExamples },
        );
      } finally {
        try { connector.disconnect(); } catch { /* already closed */ }
      }

      await db('table_relationships').where({ id })
        .update({ measured: JSON.stringify(measurement) });

      log.info(
        {
          id,
          from: `${fromTable.table_name}.${fromCol.column_name}`,
          to: `${toTable.table_name}.${toCol.column_name}`,
          verdict: measurement.verdict,
          ms: measurement.elapsedMs,
        },
        'checked relationship',
      );
      res.json({ ok: true, data: measurement });
    } catch (err) { next(err); }
  },
);

// ---------------------------------------------------------------------------
// POST /api/relationships/:id/flag
// ---------------------------------------------------------------------------
//
// The third thing a person can say about a relationship.
//
// Before this there were two: confirm it, or delete it. Neither fits the most
// common real finding — *"the data says this does not hold, but I am not
// deleting it, the source has probably not finished syncing."* Deleting throws
// away a link that is very likely real; confirming asserts something the data
// contradicts. So people did neither, and the finding died with the panel.
//
// **A flag has teeth**: a flagged relationship is dropped from the AI context
// (`getRelationshipsForContext`). That is the whole reason to flag rather than
// to leave a note somewhere — a link a person says does not hold must stop
// being offered to the model as a joinable key. One click puts it back.
//
// It does NOT touch `confirmed_by_user` or `ai_draft`: flagging is an
// observation, not a decision about whether the relationship is real.
router.post('/:id/flag', requireAuth, requireRole('admin', 'analyst'),
  validate(flagRelationshipSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ ok: false, error: 'Invalid id' });
        return;
      }
      const { flagged, reason } = req.body as { flagged: boolean; reason?: string | null };

      const rel = await db('table_relationships')
        .where({ id }).select('id', 'from_table_id').first();
      if (!rel) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      if (!await denyUnlessOwned(req, res, 'source_tables', rel.from_table_id)) return;

      await db('table_relationships').where({ id }).update({
        flagged_at: flagged ? db.fn.now() : null,
        flagged_reason: flagged ? (reason?.trim() || null) : null,
      });
      // Mirror to the graph so the AI-context read can filter in its own MATCH.
      // Best-effort: the flag is recorded either way, and a graph that is down
      // must not make raising one fail.
      try {
        await graph.setRelationshipFlagged(id, flagged);
      } catch (err) {
        log.warn({ err, id }, 'could not mirror relationship flag to the graph');
      }

      await graph.invalidateSemanticCache(
        await connectionIdForEntity(db, 'table_relationships', id) ?? undefined,
      );
      log.info({ id, flagged }, 'relationship flag changed');
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

// ---------------------------------------------------------------------------
// GET /api/relationships/:id/values
// ---------------------------------------------------------------------------
//
// The distinct values of both columns, so a person can read them against each
// other. The measurement says how much overlaps; only the values say why it
// does not — a formatting difference, the wrong column, or an absent parent all
// look identical as a percentage.
//
// Read-only and cached nowhere: values change with every sync, and a stale
// column of data is worse than a slower dialog.
router.get('/:id/values', requireAuth, requireRole('admin', 'analyst'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = reqDb(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ ok: false, error: 'Invalid id' });
        return;
      }

      const rel = await db('table_relationships')
        .where({ id })
        .select('id', 'from_table_id', 'to_table_id', 'from_column_id', 'to_column_id')
        .first();
      if (!rel) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      if (!await denyUnlessOwned(req, res, 'source_tables', rel.from_table_id)) return;
      if (!await denyUnlessOwned(req, res, 'source_tables', rel.to_table_id)) return;

      if (!rel.from_column_id || !rel.to_column_id) {
        res.status(400).json({ ok: false, error: 'This link does not name a column on both sides yet.', code: 'no_columns' });
        return;
      }

      const tables: TableRow[] = await db('source_tables')
        .whereIn('id', [rel.from_table_id, rel.to_table_id])
        .select('id', 'connection_id', 'table_name');
      const columns: ColumnRow[] = await db('source_columns')
        .whereIn('id', [rel.from_column_id, rel.to_column_id])
        .select('id', 'table_id', 'column_name');

      const fromTable = tables.find((t) => t.id === rel.from_table_id);
      const toTable   = tables.find((t) => t.id === rel.to_table_id);
      const fromCol   = columns.find((c) => c.id === rel.from_column_id);
      const toCol     = columns.find((c) => c.id === rel.to_column_id);
      if (!fromTable || !toTable || !fromCol || !toCol) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }
      if (fromTable.connection_id !== toTable.connection_id) {
        res.status(400).json({
          ok: false,
          error: 'Comparing values across two different sources is not available yet.',
          code: 'cross_source_unsupported',
        });
        return;
      }

      const connRow = await db('connections').where({ id: fromTable.connection_id }).first();
      if (!connRow) {
        res.status(404).json({ ok: false, error: 'Not found' });
        return;
      }

      const connector = await createConnector(connRow as unknown as Parameters<typeof createConnector>[0]);
      try {
        await connector.connect();
        const result = await compareColumnValues(
          connector,
          fromTable.table_name, fromCol.column_name,
          toTable.table_name, toCol.column_name,
        );
        res.json({ ok: true, data: result });
      } finally {
        try { connector.disconnect(); } catch { /* already closed */ }
      }
    } catch (err) { next(err); }
  },
);

export default router;
