/**
 * Source-connector routes — drives the "Add source" wizard.
 *
 *   GET  /api/source-types                       → list registered connectors + their schemas
 *   POST /api/source-types/:type/test            → testConnection
 *   POST /api/source-types/:type/list-entities   → listEntities
 *
 * All routes are admin-only and tenant-scoped via the standard middleware
 * stack. The connector framework runs in-process for these endpoints —
 * isolation only matters during sync (the long-running job that runs in
 * the dedicated worker container).
 *
 * Sync triggering and run history live in `routes/connections.ts`
 * (POST /api/connections/:id/sync, etc.) so they sit next to the existing
 * connection CRUD.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  createAdapterLogger,
  getConnector,
  listConnectorCatalog,
  ConfigValidationError,
} from '@databridge/connectors';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { logger } from '../utils/logger';

const router = Router();

// ─── GET /api/source-types ────────────────────────────────────────────────
/**
 * Returns the catalog of connector types the platform supports — drives
 * the "pick a source" grid in the wizard. Public schema data only;
 * never includes credentials or runtime state.
 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  const catalog = listConnectorCatalog();
  res.json({
    ok: true,
    data: catalog.map((c) => ({
      type: c.type,
      displayName: c.displayName,
      iconSvg: c.iconSvg,
      configSchema: c.configSchema,
      egressAllowList: c.egressAllowList,
    })),
  });
});

// ─── Shared validation ────────────────────────────────────────────────────
/**
 * Both test and list-entities accept a raw config object whose shape is
 * connector-specific. We don't validate the contents at the route layer
 * (the connector's own JSON Schema does that, with better error messages);
 * we just enforce that there IS a config object.
 */
const probeSchema = z.object({
  body: z.object({
    config: z.record(z.unknown()),
  }),
  params: z.object({
    type: z.string().min(1),
  }),
});

// ─── POST /api/source-types/:type/test ────────────────────────────────────
/**
 * Validates credentials by calling `connector.testConnection`. Always
 * returns 200 with `{ ok, error?, details? }` — failures here are an
 * expected user-error path (bad token, wrong region), not a server error.
 */
router.post(
  '/:type/test',
  requireAuth,
  requireRole('admin', 'analyst'),
  validate(probeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type } = req.params;
      const { config } = req.body as { config: Record<string, unknown> };

      const connector = getConnector(type);
      const result = await connector.testConnection(config, {
        log: createAdapterLogger(logger.child({
          mod: 'connector-probe',
          connector: type,
          tenantId: req.user?.tenantId,
        })),
      });
      res.json({ ok: true, data: result });
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      if (err instanceof Error && err.message.startsWith('Unknown connector type')) {
        res.status(404).json({ ok: false, error: err.message });
        return;
      }
      next(err);
    }
  },
);

// ─── POST /api/source-types/:type/list-entities ───────────────────────────
/**
 * Returns the entity catalog for the wizard's multi-select. Curated for
 * connectors today; will become dynamic ($metadata-driven) without API
 * change later.
 */
router.post(
  '/:type/list-entities',
  requireAuth,
  requireRole('admin', 'analyst'),
  validate(probeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type } = req.params;
      const { config } = req.body as { config: Record<string, unknown> };

      const connector = getConnector(type);
      const entities = await connector.listEntities(config, {
        log: createAdapterLogger(logger.child({
          mod: 'connector-list-entities',
          connector: type,
          tenantId: req.user?.tenantId,
        })),
      });
      res.json({ ok: true, data: entities });
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ ok: false, error: err.message });
        return;
      }
      if (err instanceof Error && err.message.startsWith('Unknown connector type')) {
        res.status(404).json({ ok: false, error: err.message });
        return;
      }
      next(err);
    }
  },
);

export default router;
