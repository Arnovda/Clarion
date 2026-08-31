/**
 * Accept a personal API token where a session JWT is normally required.
 *
 * THE WHOLE DESIGN IS THE HAND-OFF. Rather than re-implementing what
 * `requireAuth` does — session tenant context, the request-scoped transaction
 * that makes RLS reliable, the role plumbing — this middleware verifies the
 * token, mints a short-lived access token for the user it belongs to, REPLACES
 * the Authorization header with it, and steps aside. `requireAuth` then runs
 * completely unchanged.
 *
 * That is worth more than the few lines it saves. Every guarantee the session
 * path has, the token path now has by construction, and the two can never
 * drift apart — the failure mode of a second auth path is that it slowly
 * stops matching the first one, usually in the direction of being weaker.
 *
 * Mount it BEFORE `requireAuth` on the routers that accept tokens. It is a
 * no-op for a request that carries an ordinary JWT, so a router behind it
 * still serves the web app normally.
 */

import type { NextFunction, Request, Response } from 'express';
import { signAccessToken } from './auth';
import { resolveToken, touchToken } from '../services/apiTokens';
import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

const log = logger.child({ mod: 'api-token-auth' });

/** Personal tokens are recognisable by their prefix; JWTs never start with it. */
const TOKEN_MARKER = 'Bearer clr_';

export async function resolveApiToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith(TOKEN_MARKER)) {
    // Not a personal token — leave the request exactly as it was so a normal
    // session JWT (or a missing header, which requireAuth will refuse) flows
    // through untouched.
    next();
    return;
  }

  let resolved;
  try {
    resolved = await resolveToken(header.slice('Bearer '.length));
  } catch (err) {
    log.warn({ err }, 'token verification failed');
    res.status(401).json({ ok: false, error: 'Invalid or expired API token' });
    return;
  }

  if (!resolved) {
    // Unknown, revoked, expired, or belonging to a deactivated user — one
    // message for all of them. A client cannot act differently on the
    // difference, and telling it only helps someone probing.
    res.status(401).json({ ok: false, error: 'Invalid or expired API token' });
    return;
  }

  // The role and tenant come from the live `users` row, not from anything
  // stored with the token, so a role change or deactivation takes effect on
  // the next request rather than whenever the token happens to expire.
  req.headers.authorization = `Bearer ${signAccessToken({
    sub: resolved.userId,
    tenantId: resolved.tenantId,
    email: resolved.email,
    displayName: resolved.displayName,
    role: resolved.role as 'admin' | 'analyst' | 'viewer',
  })}`;

  // Fire-and-forget: a failed bookkeeping write must never turn a valid
  // request into a 401.
  touchToken(semanticDb, resolved.tenantId, resolved.tokenId);

  next();
}
