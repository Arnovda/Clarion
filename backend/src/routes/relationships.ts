/**
 * Relationship canvas API.
 *
 * The surface behind the cross-source relationship pane. Today it serves one
 * endpoint — measurement — because that is the interaction the whole pane is
 * built around: drag a line between two columns and get a real answer from the
 * data instead of a form asking you to declare the cardinality yourself.
 *
 * Slices still to land here (see docs/backlog/relationship-canvas.md):
 * a tenant-scoped graph read, and match edges for cross-source relations.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { measureRelationshipSchema } from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { owns } from '../db/tenantOwnership';
import { createConnector } from '../connectors/ConnectorFactory';
import { measureRelationship } from '../services/relationshipMeasure';
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

export default router;
