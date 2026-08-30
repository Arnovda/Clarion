/**
 * Feature flags — two surfaces with deliberately different audiences.
 *
 *   GET /api/features                       — ANY authenticated user.
 *     What is switched on for MY tenant. The client hides UI accordingly.
 *     Leaks nothing: a caller learns the state of their own tenant only.
 *
 *   GET    /api/admin/feature-flags         — PLATFORM OPERATOR only.
 *   PUT    /api/admin/feature-flags/:key    — PLATFORM OPERATOR only.
 *   DELETE /api/admin/feature-flags/:key    — PLATFORM OPERATOR only.
 *     The console: every flag, who sees it, and the switch.
 *
 * WHY OPERATOR AND NOT ADMIN. Everywhere else in this codebase 'admin' is the
 * top of the ladder, and it would have been one word to reuse it here. It is
 * the wrong word: a tenant admin administers THEIR OWN COMPANY, and a flag
 * decides which companies can see unreleased work. An admin who can grant
 * themselves preview features turns the flag from a release mechanism into a
 * settings screen, which is precisely the thing this exists to prevent.
 * `isPlatformOperator` reads an environment allowlist and answers false when
 * that list is empty, so a deployment that forgets to configure it has a
 * console nobody can open — the safe direction.
 *
 * This gate is also the ONLY access control on the table. `feature_flags` has
 * no `tenant_id` and therefore no row-level security behind it (see the
 * migration header for why). Unlike every other mutating route in this app,
 * a mistake here is not caught by Postgres. Hence the tests in
 * `feature-flags.test.ts` that assert refusal for viewer, analyst and admin
 * alike, and the explicit 404-not-403 on the console.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { setFeatureRolloutSchema, featureKeyParamsSchema } from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { semanticDb } from '../db/knex';
import { recordAudit } from '../services/auditService';
import {
  getFeaturesForTenant,
  listFlagState,
  setFlagRollout,
  deleteFlagRow,
  isPlatformOperator,
  operatorsConfigured,
} from '../services/featureFlags';
import { FEATURE_FLAGS, type FeatureRollout } from '../shared/contract';

// ───────────────────────── the tenant-facing router ─────────────────────────

export const featuresRouter = Router();
featuresRouter.use(requireAuth);

featuresRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const features = await getFeaturesForTenant(req.user!.tenantId, reqDb(req));
    res.json({
      ok: true,
      data: { features, isOperator: isPlatformOperator(req.user!.email) },
    });
  } catch (err) { next(err); }
});

// ─────────────────────────── the operator console ───────────────────────────

export const featureFlagsRouter = Router();
featureFlagsRouter.use(requireAuth);

/**
 * 404, not 403. A 403 would confirm the console exists to a tenant admin
 * probing for it; there is nothing here they are entitled to know about.
 */
featureFlagsRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!isPlatformOperator(req.user?.email)) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }
  next();
});

/**
 * The console reads and writes ACROSS tenants, so it deliberately uses the
 * root pool rather than `reqDb`: the request-scoped connection carries the
 * operator's own tenant in `app.current_tenant`, which would filter the tenant
 * list down to just theirs. `feature_flags` itself has no RLS, and the tenant
 * lookup below selects nothing but id and name — no tenant-owned data crosses
 * this boundary.
 */
featureFlagsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [state, tenants] = await Promise.all([
      listFlagState(semanticDb),
      semanticDb('tenants')
        .whereNot('status', 'deleted')
        .select('id', 'name')
        .orderBy('name'),
    ]);

    const nameById = new Map<number, string>(
      (tenants as Array<{ id: number; name: string }>).map((t) => [t.id, t.name]),
    );

    // Orphan rows — a flag deleted from the code registry whose row survives —
    // are dropped here rather than shown. They enable nothing (resolution only
    // ever consults registered keys), so surfacing them would put a code-cleanup
    // chore on a screen whose job is choosing an audience.
    const flags = state.filter((f) => f.known).map((f) => ({
      key: f.key,
      kind: FEATURE_FLAGS[f.key as keyof typeof FEATURE_FLAGS].kind,
      name: FEATURE_FLAGS[f.key as keyof typeof FEATURE_FLAGS].name,
      description: FEATURE_FLAGS[f.key as keyof typeof FEATURE_FLAGS].description,
      known: f.known,
      rollout: f.rollout,
      tenants: f.tenantIds.map((id) => ({
        id,
        // A tenant that was deleted after being added to a flag. Shown rather
        // than dropped, so the operator can see why the count looks wrong.
        name: nameById.get(id) ?? `Tenant ${id} (removed)`,
      })),
      updated_at: f.updatedAt,
      updated_by: f.updatedBy,
    }));

    res.json({ ok: true, data: { flags, tenants, operatorsConfigured: operatorsConfigured() } });
  } catch (err) { next(err); }
});

featureFlagsRouter.put(
  '/:key',
  validate(setFeatureRolloutSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.params.key;
      const { rollout, tenantIds } = req.body as { rollout: FeatureRollout; tenantIds?: number[] };

      if (!(key in FEATURE_FLAGS)) {
        res.status(404).json({
          ok: false,
          error: `Unknown flag "${key}". Flags are declared in code — add it to FEATURE_FLAGS and deploy first.`,
        });
        return;
      }

      // Naming a tenant that does not exist is a typo, not a rollout. Checked
      // rather than stored, because a stale id is invisible on the switch and
      // reads as "released to someone" when it is released to nobody.
      const ids = tenantIds ?? [];
      if (ids.length > 0) {
        const found = await semanticDb('tenants').whereIn('id', ids).select('id');
        const foundIds = new Set((found as Array<{ id: number }>).map((t) => t.id));
        const missing = ids.filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          res.status(400).json({ ok: false, error: `No such tenant: ${missing.join(', ')}` });
          return;
        }
      }

      await setFlagRollout(semanticDb, key, rollout, ids, req.user!.email);

      await recordAudit(req, {
        action: 'feature_flag.rollout_changed',
        entityType: 'feature_flag',
        entityId: key,
        context: { rollout, tenantIds: ids },
      });

      res.json({ ok: true, data: { key, rollout, tenantIds: ids } });
    } catch (err) { next(err); }
  },
);

featureFlagsRouter.delete(
  '/:key',
  validate(featureKeyParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = req.params.key;
      const removed = await deleteFlagRow(semanticDb, key);
      if (removed === 0) {
        res.status(404).json({ ok: false, error: 'No rollout stored for that flag' });
        return;
      }
      await recordAudit(req, {
        action: 'feature_flag.deleted',
        entityType: 'feature_flag',
        entityId: key,
        context: {},
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);
