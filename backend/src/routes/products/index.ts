/**
 * /api/products router — composed from focused sub-modules (Phase 6 of the
 * code-quality plan; split from the former 4,561-line routes/products.ts).
 *
 * ORDER IS LOAD-BEARING. Express matches routes in registration order, and
 * several literal routes (e.g. GET /dependency-graph, GET
 * /by-source-table/:sourceTableId) must be registered before the /:id param
 * routes that would otherwise capture them. The sub-routers below are
 * mounted in the EXACT order the handlers appeared in the original
 * single-file router — every module is a contiguous slice of that order.
 * Do not reorder a mount, and do not move a handler between modules without
 * checking the effective match order stays identical.
 *
 * Module map (mounting order = original registration order):
 *   catalog.ts    — GET / list, catalog-by-source, /tables/:tableId/used-by
 *   topic.ts      — GET /:id/topic (the topic page's single read model)
 *   core.ts       — POST /, dependency-graph, by-source-table,
 *                   GET/PUT/DELETE /:id, GET /:id/sources
 *   design.ts     — /:id/design-stream, /:id/design, /:id/run
 *   tables.ts     — /tables/:tableId run/patch/sql/approve/checks/
 *                   refresh-history, POST /:id/tables, PUT /columns/:columnId
 *   refine.ts     — /refine, /:id/refine, /:id/refine/apply
 *   kpis.ts       — /:id/kpis (+ai-draft), /:id/starters, /kpis/:kpiId
 *   build.ts      — /tables/:tableId/load-mode, /:id/run-full,
 *                   propose-single, /:id/refresh-start, bus-matrix/*,
 *                   bus-matrix-stream, build-bus-matrix, propose-stream,
 *                   propose, build-proposed
 *   refineChat.ts — /:id/refinements, /refinements/:id approve/reject/preview
 *   cells.ts      — /tables/:tableId/cells*, /tables/cells/:cellId*,
 *                   /tables/:tableId/deploy, /:id/deploy-all
 */
import { Router } from 'express';
import catalogRouter from './catalog';
import topicRouter from './topic';
import coreRouter from './core';
import designRouter from './design';
import tablesRouter from './tables';
import refineRouter from './refine';
import kpisRouter from './kpis';
import buildRouter from './build';
import refineChatRouter from './refineChat';
import cellsRouter from './cells';

const router = Router();

router.use(catalogRouter);
// GET /:id/topic — deeper than /:id, so it cannot be captured by core's
// /:id handler regardless of order; mounted here to keep the read-model
// routes adjacent.
router.use(topicRouter);
router.use(coreRouter);
router.use(designRouter);
router.use(tablesRouter);
router.use(refineRouter);
router.use(kpisRouter);
router.use(buildRouter);
router.use(refineChatRouter);
router.use(cellsRouter);

export default router;
