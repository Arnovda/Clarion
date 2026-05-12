/**
 * Pick the right Knex instance for a request handler.
 *
 * Returns `req.dbTrx` (the per-request, SET-LOCAL-scoped transaction
 * opened by requireAuth) when available, otherwise falls back to the
 * global `semanticDb` (which relies on the session-level SET that has
 * the documented connection-pool race condition).
 *
 * Use in every authenticated route handler that touches Postgres:
 *
 *   import { reqDb } from '../db/reqDb';
 *   router.post('/foo', requireAuth, async (req, res) => {
 *     const db = reqDb(req);
 *     const rows = await db('table').select('*');
 *     ...
 *   });
 *
 * For unauthenticated routes (e.g. /auth/login pre-token), use
 * `semanticDb` directly — there's no tenant context to scope yet.
 */

import type { Knex } from 'knex';
import type { Request } from 'express';
import { semanticDb } from './knex';

export function reqDb(req: Request): Knex | Knex.Transaction {
  return req.dbTrx ?? semanticDb;
}
