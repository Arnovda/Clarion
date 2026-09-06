/**
 * /api/legal — acceptance of the Terms, Privacy Policy and DPA (P0-7).
 *
 *   GET  /status  — is acceptance required of THIS user right now?
 *   POST /accept  — record acceptance of the current versions.
 *
 * Both are inert while LEGAL_IN_FORCE is false (status says so, accept
 * refuses: an acceptance of a draft must never be recorded as one).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { reqDb } from '../db/reqDb';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { legalAcceptSchema } from '../middleware/schemas';
import { legalInForce, legalStatusForUser, recordLegalAcceptance } from '../services/legal';
import { recordAudit } from '../services/auditService';

const router = Router();
router.use(requireAuth);

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await legalStatusForUser(reqDb(req), req.user!.tenantId, req.user!.sub);
    res.json({ ok: true, data: status });
  } catch (err) { next(err); }
});

router.post('/accept', validate(legalAcceptSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!legalInForce()) {
      res.status(409).json({ ok: false, error: 'The legal documents are not in force yet — there is nothing to accept', code: 'not_in_force' });
      return;
    }
    const db = reqDb(req);
    const versions = await recordLegalAcceptance(db, {
      tenantId: req.user!.tenantId, userId: req.user!.sub, source: 'login', req,
    });
    await recordAudit(req, { action: 'legal.accept', entityType: 'user', entityId: req.user!.sub, context: { ...versions, source: 'login' } });
    const status = await legalStatusForUser(db, req.user!.tenantId, req.user!.sub);
    res.json({ ok: true, data: status });
  } catch (err) { next(err); }
});

export default router;
