/**
 * Saved questions — Ask AI Release 3 ("answers go somewhere").
 *
 *   GET    /api/saved-questions            — list (all roles; running one is
 *                                            just asking a question)
 *   POST   /api/saved-questions            — save a question + its SQL (all
 *                                            roles; `verified` honoured only
 *                                            for admin/analyst)
 *   PATCH  /api/saved-questions/:id/verify — curator approve/unapprove
 *   DELETE /api/saved-questions/:id        — creator or curator
 *
 * The verified tier is human-attributed trust: Ask AI reuses a verified
 * question's SQL on an exact normalized match (services/savedQuestions.ts)
 * and the answer card says "Verified by your team". The SQL is checked with
 * assertSafeReadQuery at SAVE time — an unsafe query must never be stored,
 * because a verified row bypasses generation on every future match.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createSavedQuestionSchema,
  verifySavedQuestionSchema,
  deleteSavedQuestionSchema,
} from '../middleware/schemas';
import { reqDb } from '../db/reqDb';
import { assertSafeReadQuery } from '../utils/sqlGuard';
import { normalizeQuestion } from '../services/savedQuestions';

const router = Router();
router.use(requireAuth);

// ─── List ────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const rows = await db('saved_questions as sq')
      .leftJoin('users as u', 'u.id', 'sq.created_by')
      .where('sq.tenant_id', req.user!.tenantId)
      .select(
        'sq.id', 'sq.question', 'sq.connection_id', 'sq.data_layer',
        'sq.verified', 'sq.times_used', 'sq.last_used_at', 'sq.created_at',
        'sq.created_by', 'u.display_name as creator_name',
      )
      .orderBy([{ column: 'sq.verified', order: 'desc' }, { column: 'sq.created_at', order: 'desc' }])
      .limit(200);
    res.json({ ok: true, data: rows });
  } catch (err) { next(err); }
});

// ─── Save ────────────────────────────────────────────────────────────────────
router.post('/', validate(createSavedQuestionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { question, sql, tablesUsed, visualization, connectionId, dataLayer, verified } = req.body as {
      question: string; sql: string; tablesUsed?: string[];
      visualization?: Record<string, unknown>; connectionId: number;
      dataLayer?: 'product' | 'source'; verified?: boolean;
    };

    // Never store a query that isn't a safe read — a verified row bypasses
    // generation on every future exact match.
    try {
      assertSafeReadQuery(sql);
    } catch {
      res.status(400).json({ ok: false, error: 'Only read-only queries can be saved.' });
      return;
    }

    // The connection must be the tenant's own (RLS scopes the read; a miss
    // is a plain 404 either way).
    const conn = await db('connections').where({ id: connectionId }).first();
    if (!conn) { res.status(404).json({ ok: false, error: 'Connection not found' }); return; }

    const isCurator = req.user!.role === 'admin' || req.user!.role === 'analyst';
    const makeVerified = !!verified && isCurator;

    try {
      const [row] = await db('saved_questions')
        .insert({
          tenant_id: req.user!.tenantId,
          created_by: req.user!.sub,
          question: question.trim(),
          normalized_question: normalizeQuestion(question),
          sql,
          tables_used: tablesUsed ? JSON.stringify(tablesUsed) : null,
          visualization: visualization ? JSON.stringify(visualization) : null,
          connection_id: connectionId,
          data_layer: dataLayer === 'source' ? 'source' : 'product',
          verified: makeVerified,
          ...(makeVerified ? { verified_by: req.user!.sub, verified_at: new Date().toISOString() } : {}),
        })
        .returning('*');
      res.status(201).json({ ok: true, data: row });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ ok: false, error: 'This question is already saved.' });
        return;
      }
      throw err;
    }
  } catch (err) { next(err); }
});

// ─── Verify / unverify (curator) ─────────────────────────────────────────────
router.patch('/:id/verify', requireRole('admin', 'analyst'), validate(verifySavedQuestionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { verified } = req.body as { verified: boolean };
    const count = await db('saved_questions')
      .where({ id: Number(req.params.id), tenant_id: req.user!.tenantId })
      .update({
        verified,
        verified_by: verified ? req.user!.sub : null,
        verified_at: verified ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      });
    if (count === 0) { res.status(404).json({ ok: false, error: 'Saved question not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Delete (creator or curator) ─────────────────────────────────────────────
router.delete('/:id', validate(deleteSavedQuestionSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const row = await db('saved_questions')
      .where({ id: Number(req.params.id), tenant_id: req.user!.tenantId })
      .first();
    if (!row) { res.status(404).json({ ok: false, error: 'Saved question not found' }); return; }
    const isCurator = req.user!.role === 'admin' || req.user!.role === 'analyst';
    if (!isCurator && Number(row.created_by) !== Number(req.user!.sub)) {
      res.status(403).json({ ok: false, error: 'Only the creator or a curator can delete this.' });
      return;
    }
    await db('saved_questions').where({ id: row.id }).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
