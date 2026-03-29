import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { semanticDb } from '../db/knex';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/cross-views — list all views
// ---------------------------------------------------------------------------
router.get('/', requireAuth, requireRole('epicdata_admin'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const views = await semanticDb('cross_source_views').select('*').orderBy('updated_at', 'desc');
    res.json({ ok: true, data: views });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/cross-views — create a view
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description } = req.body as { name: string; description?: string };
    const [row] = await semanticDb('cross_source_views')
      .insert({ name, description, user_id: req.user!.sub })
      .returning('id');
    const id: number = typeof row === 'object' ? (row as { id: number }).id : row;
    res.status(201).json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/cross-views/:id — full view with tables, columns, relationships
// ---------------------------------------------------------------------------
router.get('/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const view = await semanticDb('cross_source_views').where({ id: req.params.id }).first();
    if (!view) { res.status(404).json({ ok: false, error: 'View not found' }); return; }

    // Tables on this canvas with their source info and connection
    const viewTables = await semanticDb('cross_view_tables as vt')
      .join('source_tables as st', 'vt.table_id', 'st.id')
      .join('connections as c', 'st.connection_id', 'c.id')
      .where('vt.view_id', req.params.id)
      .select(
        'vt.id as view_table_id',
        'vt.pos_x',
        'vt.pos_y',
        'st.id as table_id',
        'st.table_name',
        'st.display_name',
        'st.connection_id',
        'c.name as connection_name',
      );

    // Columns for every table
    const tableIds = viewTables.map((t: { table_id: number }) => t.table_id);
    const columns = tableIds.length
      ? await semanticDb('source_columns').whereIn('table_id', tableIds).orderBy('id')
      : [];

    // Cross-source relationships
    const relationships = await semanticDb('cross_view_relationships').where({ view_id: req.params.id });

    res.json({ ok: true, data: { view, viewTables, columns, relationships } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/cross-views/:id — rename / redescribe
// ---------------------------------------------------------------------------
router.patch('/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    await semanticDb('cross_source_views').where({ id: req.params.id }).update({ name, description, updated_at: semanticDb.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/cross-views/:id
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await semanticDb('cross_source_views').where({ id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/cross-views/:id/tables — add a table to the canvas
// ---------------------------------------------------------------------------
router.post('/:id/tables', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tableId, posX = 80, posY = 80 } = req.body as { tableId: number; posX?: number; posY?: number };
    const viewId = req.params.id;

    // Prevent duplicates
    const existing = await semanticDb('cross_view_tables').where({ view_id: viewId, table_id: tableId }).first();
    if (existing) { res.json({ ok: true, data: { id: existing.id } }); return; }

    const [row] = await semanticDb('cross_view_tables')
      .insert({ view_id: viewId, table_id: tableId, pos_x: posX, pos_y: posY })
      .returning('id');
    const id: number = typeof row === 'object' ? (row as { id: number }).id : row;

    // Auto-import existing table_relationships between this table and any table already on the canvas.
    // This surfaces Definitions → Relationships connections automatically.
    const existingTableRows = await semanticDb('cross_view_tables')
      .where({ view_id: viewId })
      .whereNot({ table_id: tableId })
      .select('table_id');
    const existingTableIds: number[] = existingTableRows.map((r: { table_id: number }) => r.table_id);

    if (existingTableIds.length) {
      // Find relationships where the new table is on either side and the other table is already on the canvas
      const rels = await semanticDb('table_relationships')
        .where(function () {
          this.where({ from_table_id: tableId }).whereIn('to_table_id', existingTableIds)
            .orWhere(function () {
              this.where({ to_table_id: tableId }).whereIn('from_table_id', existingTableIds);
            });
        })
        .select('from_table_id', 'from_column_id', 'to_table_id', 'to_column_id', 'relationship_type');

      for (const rel of rels as { from_table_id: number; from_column_id: number | null; to_table_id: number; to_column_id: number | null; relationship_type: string }[]) {
        // Only insert if this exact relationship doesn't already exist in the view
        const alreadyExists = await semanticDb('cross_view_relationships')
          .where({
            view_id:       viewId,
            from_table_id: rel.from_table_id,
            to_table_id:   rel.to_table_id,
          })
          .first();
        if (!alreadyExists) {
          await semanticDb('cross_view_relationships').insert({
            view_id:           viewId,
            from_table_id:     rel.from_table_id,
            from_column_id:    rel.from_column_id ?? null,
            to_table_id:       rel.to_table_id,
            to_column_id:      rel.to_column_id ?? null,
            relationship_type: rel.relationship_type,
            label:             null,
          });
        }
      }
    }

    res.json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/cross-views/:id/tables/:tableId — remove a table from canvas
// ---------------------------------------------------------------------------
router.delete('/:id/tables/:tableId', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tableId = Number(req.params.tableId);
    // Remove relationships involving this table
    await semanticDb('cross_view_relationships')
      .where({ view_id: req.params.id })
      .where(function () { this.where({ from_table_id: tableId }).orWhere({ to_table_id: tableId }); })
      .delete();
    await semanticDb('cross_view_tables').where({ view_id: req.params.id, table_id: tableId }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/cross-views/:id/tables/:tableId/position — save drag position
// ---------------------------------------------------------------------------
router.patch('/:id/tables/:tableId/position', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { posX, posY } = req.body as { posX: number; posY: number };
    await semanticDb('cross_view_tables')
      .where({ view_id: req.params.id, table_id: Number(req.params.tableId) })
      .update({ pos_x: posX, pos_y: posY });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/cross-views/:id/relationships — draw a relationship line
// ---------------------------------------------------------------------------
router.post('/:id/relationships', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fromTableId, fromColumnId, toTableId, toColumnId, relationshipType = 'many_to_one', label } =
      req.body as { fromTableId: number; fromColumnId?: number; toTableId: number; toColumnId?: number; relationshipType?: string; label?: string };
    const [row] = await semanticDb('cross_view_relationships')
      .insert({ view_id: req.params.id, from_table_id: fromTableId, from_column_id: fromColumnId ?? null, to_table_id: toTableId, to_column_id: toColumnId ?? null, relationship_type: relationshipType, label: label ?? null })
      .returning('id');
    const id: number = typeof row === 'object' ? (row as { id: number }).id : row;
    res.json({ ok: true, data: { id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/cross-views/:id/relationships/:relId
// ---------------------------------------------------------------------------
router.delete('/:id/relationships/:relId', requireAuth, requireRole('epicdata_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await semanticDb('cross_view_relationships').where({ id: req.params.relId, view_id: req.params.id }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
