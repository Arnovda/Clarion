/**
 * Personal API tokens — the user-facing half.
 *
 *   GET    /api/api-tokens        — the caller's own tokens (never a hash)
 *   POST   /api/api-tokens        — mint one; the plaintext is returned ONCE
 *   DELETE /api/api-tokens/:id    — revoke one of the caller's own
 *
 * Every route is scoped to the CALLER. There is no admin view of other
 * people's tokens and no way to mint a token for someone else: a token acts
 * as its owner, so issuing one on another user's behalf would be a way to
 * act as them that leaves the wrong name on the audit trail.
 *
 * All roles may create tokens. A viewer's token can do exactly what a viewer
 * can do — the token carries no authority of its own, it borrows its owner's,
 * resolved live on every request.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, refuseDuringSupportSession } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createApiTokenSchema, revokeApiTokenSchema } from '../middleware/schemas';
import { listTokens, mintToken, revokeToken } from '../services/apiTokens';
import { recordAudit } from '../services/auditService';
import { reqDb } from '../db/reqDb';

const router = Router();
router.use(requireAuth);

/** Default lifetime. Long enough to be practical, short enough to expire. */
const DEFAULT_TTL_DAYS = 180;

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tokens = await listTokens(reqDb(req), req.user!.tenantId, req.user!.sub);
    res.json({ ok: true, data: tokens });
  } catch (err) {
    next(err);
  }
});

router.post('/', refuseDuringSupportSession, validate(createApiTokenSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, ttlDays } = req.body as { name: string; ttlDays?: number };
    const minted = await mintToken(reqDb(req), {
      tenantId: req.user!.tenantId,
      userId: req.user!.sub,
      name,
      ttlDays: ttlDays ?? DEFAULT_TTL_DAYS,
    });

    await recordAudit(req, {
      action: 'api_token.create',
      entityType: 'api_token',
      entityId: minted.id,
      context: { name, expiresAt: minted.expiresAt.toISOString() },
    });

    // The ONLY time the plaintext exists outside the client's hands. The
    // response says so explicitly so the UI can be built around it.
    res.status(201).json({
      ok: true,
      data: {
        id: minted.id,
        name: minted.name,
        prefix: minted.prefix,
        expiresAt: minted.expiresAt,
        token: minted.plaintext,
        shownOnce: true,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', refuseDuringSupportSession, validate(revokeApiTokenSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const ok = await revokeToken(reqDb(req), req.user!.tenantId, req.user!.sub, id);
    if (!ok) {
      // Someone else's id and a non-existent id look identical from here, on
      // purpose — a 404 either way tells a prober nothing.
      res.status(404).json({ ok: false, error: 'Token not found' });
      return;
    }
    await recordAudit(req, { action: 'api_token.revoke', entityType: 'api_token', entityId: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
