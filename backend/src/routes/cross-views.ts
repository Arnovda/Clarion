import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import * as graph from '../db/semanticGraph';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/cross-views — list all views (optionally filter by connectionId)
// ---------------------------------------------------------------------------
router.get('/', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connectionId = req.query.connectionId ? Number(req.query.connectionId) : undefined;
    const views = await graph.getCrossSourceViews(connectionId);
    res.json({ ok: true, data: views });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/cross-views — create a view
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description, connectionId } = req.body as { name: string; description?: string; connectionId?: number };
    const pgId = await graph.nextPgId();
    await graph.createCrossSourceView({ pgId, name, description: description ?? null, connectionId: connectionId ?? null, userId: req.user!.sub });
    res.status(201).json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/cross-views/related-tables/:tableId — 1-hop neighbourhood of a table
// ---------------------------------------------------------------------------
router.get('/related-tables/:tableId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await graph.getRelatedTables(Number(req.params.tableId));
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/cross-views/:id — full view with tables, columns, relationships
// ---------------------------------------------------------------------------
router.get('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const detail = await graph.getCrossSourceViewDetail(Number(req.params.id));
    if (!detail) { res.status(404).json({ ok: false, error: 'View not found' }); return; }
    res.json({ ok: true, data: detail });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/cross-views/:id — rename / redescribe
// ---------------------------------------------------------------------------
router.patch('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    await graph.updateCrossSourceView(Number(req.params.id), { name, description });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/cross-views/:id
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.deleteCrossSourceView(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/cross-views/:id/tables — add a table to the canvas
// ---------------------------------------------------------------------------
router.post('/:id/tables', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewPgId  = Number(req.params.id);
    const { tableId, posX = 80, posY = 80 } = req.body as { tableId: number; posX?: number; posY?: number };
    const tablePgId = Number(tableId);

    await graph.addTableToView(viewPgId, tablePgId, posX, posY);

    // Auto-import existing RELATES_TO edges between this table and tables already on the canvas.
    const detail = await graph.getCrossSourceViewDetail(viewPgId);
    if (detail) {
      const existingTablePgIds = detail.viewTables
        .map((t) => t.table_id as number)
        .filter((id) => id !== tablePgId);

      if (existingTablePgIds.length) {
        const rels = await graph.getRelationshipsBetweenTables(tablePgId, existingTablePgIds);
        const existingRelPairs = new Set(
          detail.relationships.map((r) => `${r.from_table_id}:${r.to_table_id}`),
        );
        for (const rel of rels) {
          const key = `${rel.from_table_id}:${rel.to_table_id}`;
          if (!existingRelPairs.has(key)) {
            const pgId = await graph.nextPgId();
            await graph.addCrossViewRelationship({
              pgId,
              viewPgId,
              fromTablePgId:   rel.from_table_id,
              fromColumnPgId:  rel.from_column_id,
              toTablePgId:     rel.to_table_id,
              toColumnPgId:    rel.to_column_id,
              relationshipType: rel.relationship_type,
            });
            existingRelPairs.add(key);
          }
        }
      }
    }

    res.json({ ok: true, data: { id: tablePgId } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/cross-views/:id/tables/:tableId — remove a table from canvas
// ---------------------------------------------------------------------------
router.delete('/:id/tables/:tableId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.removeTableFromView(Number(req.params.id), Number(req.params.tableId));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/cross-views/:id/tables/:tableId/position — save drag position
// ---------------------------------------------------------------------------
router.patch('/:id/tables/:tableId/position', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { posX, posY } = req.body as { posX: number; posY: number };
    await graph.updateTablePositionInView(Number(req.params.id), Number(req.params.tableId), posX, posY);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/cross-views/:id/relationships — draw a relationship line
// ---------------------------------------------------------------------------
router.post('/:id/relationships', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewPgId = Number(req.params.id);
    const { fromTableId, fromColumnId, toTableId, toColumnId, relationshipType = 'many_to_one', label } =
      req.body as { fromTableId: number; fromColumnId?: number; toTableId: number; toColumnId?: number; relationshipType?: string; label?: string };

    const [fromCol, toCol] = await Promise.all([
      fromColumnId ? graph.getColumnByPgId(Number(fromColumnId)) : Promise.resolve(null),
      toColumnId   ? graph.getColumnByPgId(Number(toColumnId))   : Promise.resolve(null),
    ]);

    const pgId = await graph.nextPgId();
    await graph.addCrossViewRelationship({
      pgId,
      viewPgId,
      fromTablePgId:   Number(fromTableId),
      fromColumnPgId:  fromColumnId ?? null,
      fromColName:     fromCol?.column_name ?? null,
      toTablePgId:     Number(toTableId),
      toColumnPgId:    toColumnId ?? null,
      toColName:       toCol?.column_name ?? null,
      relationshipType,
      label: label ?? null,
    });
    res.json({ ok: true, data: { id: pgId } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/cross-views/:id/relationships/:relId
// ---------------------------------------------------------------------------
router.delete('/:id/relationships/:relId', requireAuth, requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await graph.deleteCrossViewRelationship(Number(req.params.relId));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
