/**
 * /api/definitions — ONE list of everything a tenant has written down about
 * what its words mean, read from the three stores that hold it:
 *
 *   • business_glossary  — terms ("Active customer"), with their links into
 *                          the topic layer
 *   • product_kpis       — metrics per subject, with the question they answer
 *   • saved_questions    — VERIFIED answers: a question whose SQL a curator
 *                          approved
 *
 * The Definitions pane is documentation, not execution (owner decision,
 * 2026-09-22): nothing here runs SQL. The stores stay where they are and
 * keep their own write routes; this is the read model that puts them on one
 * screen. Every query filters `tenant_id` explicitly — the reqDb pool-race
 * rule — and RLS is the second line.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { parseGlossaryLinks, resolveGlossaryLinks } from '../services/glossaryLinks';

const router = Router();

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const tenantId = req.user!.tenantId;

    const [termRows, metricRows, answerRows] = await Promise.all([
      db('business_glossary')
        .where({ tenant_id: tenantId })
        .orderBy('term', 'asc')
        .select('id', 'term', 'meaning', 'examples', 'tags', 'links', 'ai_draft', 'updated_at'),
      db('product_kpis as k')
        .join('data_products as dp', 'k.data_product_id', 'dp.id')
        .where('k.tenant_id', tenantId)
        .orderBy([{ column: 'dp.name', order: 'asc' }, { column: 'k.name', order: 'asc' }])
        .select(
          'k.id', 'k.name', 'k.description', 'k.question_text', 'k.formula_plain_text', 'k.ai_draft', 'k.updated_at',
          'dp.id as product_id', 'dp.name as product_name', 'dp.hidden as product_hidden',
        ),
      db('saved_questions as sq')
        .leftJoin('users as u', 'u.id', 'sq.verified_by')
        .leftJoin('connections as c', 'c.id', 'sq.connection_id')
        .where('sq.tenant_id', tenantId)
        .andWhere('sq.verified', true)
        .orderBy('sq.question', 'asc')
        .select(
          'sq.id', 'sq.question', 'sq.connection_id', 'sq.data_layer', 'sq.verified_at', 'sq.times_used',
          'u.display_name as verified_by_name', 'c.name as connection_name',
        ),
    ]);

    // Resolve every term's links in one pass (three queries however many terms).
    const parsed = termRows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      term: String(r.term ?? ''),
      meaning: String(r.meaning ?? ''),
      examples: parseJsonArray(r.examples),
      tags: parseJsonArray(r.tags),
      links: parseGlossaryLinks(r.links),
      ai_draft: !!r.ai_draft,
      updated_at: r.updated_at ? String(r.updated_at) : null,
    }));
    const allLinks = parsed.flatMap((t) => t.links);
    const resolved = await resolveGlossaryLinks(db, tenantId, allLinks);
    // resolveGlossaryLinks keeps input order, so slice it back per term.
    let cursor = 0;
    const terms = parsed.map((t) => {
      const links = resolved.slice(cursor, cursor + t.links.length);
      cursor += t.links.length;
      return { ...t, links };
    });

    res.json({
      ok: true,
      data: {
        terms,
        metrics: metricRows.map((m: Record<string, unknown>) => ({
          id: Number(m.id),
          name: String(m.name ?? ''),
          description: m.description ? String(m.description) : null,
          question_text: m.question_text ? String(m.question_text) : null,
          formula_plain_text: m.formula_plain_text ? String(m.formula_plain_text) : null,
          ai_draft: !!m.ai_draft,
          updated_at: m.updated_at ? String(m.updated_at) : null,
          product: { id: Number(m.product_id), name: String(m.product_name ?? ''), hidden: m.product_hidden === true },
        })),
        verifiedAnswers: answerRows.map((a: Record<string, unknown>) => ({
          id: Number(a.id),
          question: String(a.question ?? ''),
          connection_id: a.connection_id != null ? Number(a.connection_id) : null,
          connection_name: a.connection_name ? String(a.connection_name) : null,
          data_layer: a.data_layer ? String(a.data_layer) : null,
          verified_at: a.verified_at ? String(a.verified_at) : null,
          verified_by_name: a.verified_by_name ? String(a.verified_by_name) : null,
          times_used: Number(a.times_used ?? 0),
        })),
      },
    });
  } catch (err) { next(err); }
});

export default router;
