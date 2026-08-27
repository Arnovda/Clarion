/**
 * Saved questions — the named, re-runnable questions behind the chat's
 * "Save question" action and the VERIFIED trust tier (Ask AI Release 3).
 *
 * The load-bearing rule lives here: a verified question is reused on an
 * EXACT match of the normalized question text only (owner decision
 * 2026-08-27 §8.3). Normalization is deliberately conservative — lowercase,
 * collapse whitespace, strip trailing punctuation — because a false match
 * serves someone ELSE's approved SQL for a question that merely looks
 * similar, which is worse than a cache miss. Fuzzy matching is a later,
 * measured step.
 */

import type { Knex } from 'knex';

export interface SavedQuestionRow {
  id: number;
  tenant_id: number;
  created_by: number | null;
  question: string;
  normalized_question: string;
  sql: string;
  tables_used: string[] | null;
  visualization: Record<string, unknown> | null;
  connection_id: number;
  data_layer: 'product' | 'source';
  verified: boolean;
  verified_by: number | null;
  verified_at: string | null;
  times_used: number;
  last_used_at: string | null;
}

/** Lowercase, collapse whitespace, strip trailing punctuation. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?!.\s]+$/g, '');
}

/**
 * Exact-match lookup of a VERIFIED question for this tenant + connection.
 * One indexed read — this sits on the hot path of every chat question.
 * Explicit tenant filter (the standing reqDb pool-race rule).
 */
export async function findVerifiedQuestion(
  db: Knex | Knex.Transaction,
  tenantId: number | undefined,
  connectionId: number,
  question: string,
): Promise<SavedQuestionRow | null> {
  const normalized = normalizeQuestion(question);
  if (!normalized) return null;
  const query = db('saved_questions')
    .where({ connection_id: connectionId, normalized_question: normalized, verified: true });
  if (tenantId != null) query.where({ tenant_id: tenantId });
  const row = await query.first();
  if (!row) return null;
  return {
    ...row,
    tables_used: row.tables_used
      ? (typeof row.tables_used === 'string' ? JSON.parse(row.tables_used) : row.tables_used)
      : null,
    visualization: row.visualization
      ? (typeof row.visualization === 'string' ? JSON.parse(row.visualization) : row.visualization)
      : null,
  } as SavedQuestionRow;
}

/** Bump usage counters after a verified answer was served. Best-effort. */
export async function recordVerifiedUse(
  db: Knex | Knex.Transaction,
  id: number,
): Promise<void> {
  try {
    await db('saved_questions').where({ id }).update({
      times_used: db.raw('times_used + 1'),
      last_used_at: new Date().toISOString(),
    });
  } catch { /* usage accounting must never fail a question */ }
}
