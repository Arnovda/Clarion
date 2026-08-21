/**
 * /api/grids — managed grids, the in-Clarion spreadsheet place.
 *
 * The truth a user edits lives in Postgres (`managed_grids` +
 * `managed_grid_rows`, RLS-forced); on every save the rows are materialised
 * to the tenant's warehouse as an ordinary Parquet table so Ask AI and
 * dashboards read the grid like any other data (see services/managedGrids).
 *
 * Materialisation is deliberately NON-FATAL on the save path: the user's
 * rows are committed first, and a warehouse hiccup lands in
 * `materialize_error` for the UI to show — never a lost edit. Every query
 * filters tenant_id EXPLICITLY (the reqDb pool-race rule), and cross-tenant
 * ids refuse with 404, never 403.
 *
 * Roles: admin + analyst throughout. Viewers meet grid data the same way
 * they meet all data — through answers and dashboards — not through the
 * editor.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createManagedGridSchema,
  updateManagedGridSchema,
  saveManagedGridRowsSchema,
  gridIdParamsSchema,
} from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { recordAudit } from '../services/auditService';
import {
  normalizeColumns,
  deriveGridSlug,
  isValidGridSlug,
  coerceRow,
  materializeGrid,
  GridValidationError,
  GRID_MAX_ROWS,
  type GridColumn,
  type GridKind,
} from '../services/managedGrids';
import { gridViewName, deleteWarehousePath } from '../services/warehouse';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'routes-managed-grids' });
const router = Router();

interface GridRowRecord {
  id: number;
  tenant_id: number;
  name: string;
  slug: string;
  description: string | null;
  kind: GridKind;
  columns: GridColumn[];
  row_count: number;
  warehouse_path: string | null;
  materialize_version: number;
  materialized_at: string | null;
  materialize_error: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toApi(g: GridRowRecord) {
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    viewName: gridViewName(g.slug),
    description: g.description,
    kind: g.kind,
    columns: g.columns,
    rowCount: g.row_count,
    materializedAt: g.materialized_at,
    materializeError: g.materialize_error,
    updatedAt: g.updated_at,
    updatedBy: g.updated_by,
    createdAt: g.created_at,
  };
}

/**
 * Re-materialise a grid from its current Postgres truth, recording either
 * the new location or the error. Never throws — the caller's save already
 * committed.
 */
async function rematerialize(
  db: ReturnType<typeof reqDb>,
  tenantId: number,
  gridId: number,
): Promise<void> {
  const grid = (await db('managed_grids')
    .where({ id: gridId, tenant_id: tenantId })
    .first()) as GridRowRecord | undefined;
  if (!grid) return;

  const rowRecords = (await db('managed_grid_rows')
    .where({ grid_id: gridId, tenant_id: tenantId })
    .orderBy('position', 'asc')
    .select('data')) as Array<{ data: Record<string, unknown> }>;

  const version = grid.materialize_version + 1;
  try {
    const dir = await materializeGrid({
      tenantId,
      gridId,
      version,
      columns: grid.columns,
      rows: rowRecords.map((r) => r.data),
      previousPath: grid.warehouse_path,
    });
    await db('managed_grids').where({ id: gridId, tenant_id: tenantId }).update({
      warehouse_path: dir,
      materialize_version: version,
      materialized_at: db.fn.now(),
      materialize_error: null,
    });
  } catch (err) {
    log.warn({ err, gridId }, 'grid materialisation failed — rows are saved, table not yet queryable');
    await db('managed_grids').where({ id: gridId, tenant_id: tenantId }).update({
      materialize_error: err instanceof Error ? err.message.slice(0, 500) : 'Unknown error',
    });
  }
}

// ─── List ───────────────────────────────────────────────────────────────────

router.get('/', requireAuth, requireRole('admin', 'analyst'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const grids = (await db('managed_grids')
      .where({ tenant_id: tenantId })
      .orderBy('updated_at', 'desc')) as GridRowRecord[];
    res.json({ ok: true, data: grids.map(toApi) });
  } catch (err) { next(err); }
});

// ─── Create ─────────────────────────────────────────────────────────────────

router.post('/', requireAuth, requireRole('admin', 'analyst'), validate(createManagedGridSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const { name, kind, description, columns } = req.body as {
      name: string;
      kind?: GridKind;
      description?: string | null;
      columns: Array<{ key?: string | null; name: string; type: string }>;
    };

    let normalized: GridColumn[];
    try {
      normalized = normalizeColumns(columns);
    } catch (e) {
      if (e instanceof GridValidationError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      throw e;
    }

    const slug = deriveGridSlug(name);
    if (!isValidGridSlug(slug)) {
      res.status(400).json({ ok: false, error: 'That name cannot be turned into a table name — add a letter or two.' });
      return;
    }

    const collision = await db('managed_grids')
      .where({ tenant_id: tenantId, slug })
      .first();
    if (collision) {
      res.status(409).json({ ok: false, error: `A table named like "${name}" already exists — pick a different name.` });
      return;
    }

    let id: number;
    try {
      const [row] = await db('managed_grids')
        .insert({
          tenant_id: tenantId,
          name: name.trim(),
          slug,
          kind: kind ?? 'list',
          description: description ?? null,
          columns: JSON.stringify(normalized),
          created_by: req.user?.email ?? null,
          updated_by: req.user?.email ?? null,
        })
        .returning('id');
      id = Number((row as { id?: number }).id ?? row);
    } catch (e) {
      // Unique (tenant_id, slug) — a concurrent create with the same name
      // loses the race; same answer as the pre-check above.
      if ((e as { code?: string }).code === '23505') {
        res.status(409).json({ ok: false, error: `A table named like "${name}" already exists — pick a different name.` });
        return;
      }
      throw e;
    }

    await recordAudit(req, {
      action: 'managed_grid.create',
      entityType: 'managed_grid',
      entityId: id,
      context: { name: name.trim(), kind: kind ?? 'list' },
    });

    // Materialise the empty schema so the view exists (with real columns)
    // from the moment the grid does.
    await rematerialize(db, tenantId, id);

    const created = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord;
    res.json({ ok: true, data: toApi(created) });
  } catch (err) { next(err); }
});

// ─── Read one (with rows) ───────────────────────────────────────────────────

router.get('/:id', requireAuth, requireRole('admin', 'analyst'), validate(gridIdParamsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const grid = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord | undefined;
    if (!grid) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }
    const rows = (await db('managed_grid_rows')
      .where({ grid_id: id, tenant_id: tenantId })
      .orderBy('position', 'asc')
      .select('id', 'data')) as Array<{ id: number; data: Record<string, unknown> }>;
    res.json({ ok: true, data: { ...toApi(grid), rows } });
  } catch (err) { next(err); }
});

// ─── Update metadata / columns ──────────────────────────────────────────────

router.put('/:id', requireAuth, requireRole('admin', 'analyst'), validate(updateManagedGridSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const grid = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord | undefined;
    if (!grid) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    const { name, description, columns } = req.body as {
      name?: string;
      description?: string | null;
      columns?: Array<{ key?: string | null; name: string; type: string }>;
    };

    const patch: Record<string, unknown> = { updated_by: req.user?.email ?? null, updated_at: db.fn.now() };
    // Renames change the display name only — the slug (and so the view name
    // saved dashboards reference) is fixed at creation.
    if (name !== undefined) patch.name = name.trim();
    if (description !== undefined) patch.description = description;

    let columnsChanged = false;
    if (columns !== undefined) {
      try {
        const normalized = normalizeColumns(columns);
        columnsChanged = JSON.stringify(normalized) !== JSON.stringify(grid.columns);
        patch.columns = JSON.stringify(normalized);
      } catch (e) {
        if (e instanceof GridValidationError) {
          res.status(400).json({ ok: false, error: e.message });
          return;
        }
        throw e;
      }
    }

    await db('managed_grids').where({ id, tenant_id: tenantId }).update(patch);
    if (columnsChanged) await rematerialize(db, tenantId, id);

    const updated = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord;
    res.json({ ok: true, data: toApi(updated) });
  } catch (err) { next(err); }
});

// ─── Save rows (full replacement) ───────────────────────────────────────────

router.put('/:id/rows', requireAuth, requireRole('admin', 'analyst'), validate(saveManagedGridRowsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const grid = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord | undefined;
    if (!grid) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    const { rows } = req.body as { rows: Array<{ data: Record<string, unknown> }> };
    if (rows.length > GRID_MAX_ROWS) {
      res.status(400).json({
        ok: false,
        error: `A table can hold at most ${GRID_MAX_ROWS.toLocaleString('en-GB')} rows — for data that size, add it as a source instead.`,
      });
      return;
    }

    let clean: Array<Record<string, unknown>>;
    try {
      clean = rows.map((r, i) => coerceRow(r.data, grid.columns, i));
    } catch (e) {
      if (e instanceof GridValidationError) {
        res.status(400).json({ ok: false, error: e.message });
        return;
      }
      throw e;
    }

    // Full replacement in the request transaction: the save model is "the
    // grid exactly as the editor shows it".
    await db('managed_grid_rows').where({ grid_id: id, tenant_id: tenantId }).del();
    const BATCH = 500;
    for (let i = 0; i < clean.length; i += BATCH) {
      const batch = clean.slice(i, i + BATCH).map((data, j) => ({
        tenant_id: tenantId,
        grid_id: id,
        position: i + j,
        data: JSON.stringify(data),
        updated_by: req.user?.email ?? null,
      }));
      if (batch.length > 0) await db('managed_grid_rows').insert(batch);
    }
    await db('managed_grids').where({ id, tenant_id: tenantId }).update({
      row_count: clean.length,
      updated_by: req.user?.email ?? null,
      updated_at: db.fn.now(),
    });

    await rematerialize(db, tenantId, id);

    const updated = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord;
    res.json({ ok: true, data: toApi(updated) });
  } catch (err) { next(err); }
});

// ─── Delete ─────────────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, requireRole('admin', 'analyst'), validate(gridIdParamsSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;
    const id = Number(req.params.id);
    const grid = (await db('managed_grids')
      .where({ id, tenant_id: tenantId })
      .first()) as GridRowRecord | undefined;
    if (!grid) {
      res.status(404).json({ ok: false, error: 'Table not found' });
      return;
    }

    await db('managed_grids').where({ id, tenant_id: tenantId }).del();

    await recordAudit(req, {
      action: 'managed_grid.delete',
      entityType: 'managed_grid',
      entityId: id,
      context: { name: grid.name },
    });

    if (grid.warehouse_path) {
      deleteWarehousePath(grid.warehouse_path).catch((err) => {
        log.warn({ err, path: grid.warehouse_path }, 'grid warehouse cleanup failed (non-fatal)');
      });
    }

    res.json({ ok: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
