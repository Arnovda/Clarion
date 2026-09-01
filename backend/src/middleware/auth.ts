import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Knex } from 'knex';
import { JwtPayload, UserRole } from '../shared/types';
import { semanticDb } from '../db/knex';
import { config, requireJwtSecret } from '../config';
import { withTenantAiContext } from '../services/aiBudget';
import { checkAccountStatus } from '../services/accountStatus';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Re-export types for convenience
// ---------------------------------------------------------------------------

export type { JwtPayload, UserRole };

// ---------------------------------------------------------------------------
// Express augmentation
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      /**
       * Per-request, tenant-scoped Knex transaction. Opened by requireAuth
       * immediately after JWT verify; committed automatically when the
       * response completes. Routes that adopt `req.dbTrx` instead of the
       * global `semanticDb` are bulletproof against the connection-pool
       * leak that affects session-level `SET app.current_tenant` (see
       * security audit, May 2026). New / sensitive routes SHOULD use
       * this; existing routes are migrated incrementally.
       */
      dbTrx?: Knex.Transaction;
    }
  }
}

// ---------------------------------------------------------------------------
// Password helpers
// ---------------------------------------------------------------------------

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

// The JWT secret + production weak-secret guard now live in config.ts so every
// token operation (access, MFA challenge, WebAuthn) shares the same check.
const getSecret = requireJwtSecret;

/**
 * Sign an access token. Short-lived (15 minutes by default) — pair with
 * a refresh token to extend a session without re-login. Old single-
 * token callers can still use `signToken` (alias kept for back-compat
 * during the transition; existing 8-hour tokens issued before this
 * commit remain valid until their natural expiry).
 */
export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, getSecret(), {
    expiresIn: config.jwt.accessExpiresIn,
  } as jwt.SignOptions);
}

/**
 * Back-compat alias. Existing call sites still using `signToken` continue
 * to work but now issue a short-lived access token. They should pair the
 * issuance with `createRefreshToken()` from authTokens.ts.
 */
export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, getSecret(), { expiresIn: config.jwt.accessExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as unknown as JwtPayload;
}

/**
 * Impersonation tokens (P1-5 operator console) are HARD time-boxed at 15
 * minutes regardless of JWT_ACCESS_EXPIRES_IN — the whole point of a
 * support session is a window that closes itself, and no refresh token is
 * ever issued alongside one, so there is no way to extend it. The
 * `impersonatedBy` claim rides in the payload so request logs and audit
 * rows written during the session can name the real actor.
 */
export function signImpersonationToken(
  payload: Omit<JwtPayload, 'iat' | 'exp'> & { impersonatedBy: string },
): string {
  return jwt.sign(payload, getSecret(), { expiresIn: '15m' } as jwt.SignOptions);
}

// ---------------------------------------------------------------------------
// User lookup helpers
// ---------------------------------------------------------------------------

export async function findUserByEmail(tenantId: number, email: string) {
  return semanticDb('users')
    .where({ tenant_id: tenantId, email: email.toLowerCase(), is_active: true })
    .first();
}

export async function findUserByEmailAcrossTenants(email: string) {
  return semanticDb('users')
    .where({ email: email.toLowerCase(), is_active: true })
    .first();
}

// ---------------------------------------------------------------------------
// Middleware: require a valid JWT
// ---------------------------------------------------------------------------

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'Missing or invalid Authorization header' });
    return;
  }

  let payload: JwtPayload;
  try {
    const token = header.slice(7);
    payload = verifyToken(token);
    req.user = payload;
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
    return;
  }

  // P1-3 fast suspension: a verified signature says who the caller WAS
  // when the token was signed — the account must still be in good
  // standing NOW. Cached (AUTH_STATUS_TTL_MS, default 30s) so this costs
  // one indexed read per user per TTL, not per request; a query error
  // fails OPEN inside checkAccountStatus (a DB blip must not 401 the
  // whole product). 401 — not 403 — on purpose: the frontend's 401
  // interceptor attempts a token refresh (which refuses too, see
  // refreshTokenService) and then clears the session and returns the
  // user to the sign-in screen, where login states the real reason.
  // Placed BEFORE the tenant transaction below so a refused request
  // never spends a pool connection.
  if (payload.tenantId && payload.sub) {
    const status = await checkAccountStatus(payload.tenantId, payload.sub);
    if (status === 'refused') {
      res.status(401).json({ ok: false, error: 'This account is no longer active' });
      return;
    }
  }

  // Session-level SET on the pool. Existing routes that use the global
  // `semanticDb` rely on this. It is racy under pool reuse (a connection
  // returned from request A may be acquired by request B before B's SET
  // runs). The PROPER fix is `req.dbTrx` below — but we keep this here
  // during the migration period so unmigrated routes still see SOMETHING.
  // SET doesn't support parameterized queries in Postgres — Number()
  // coercion prevents injection.
  if (payload.tenantId) {
    try {
      await semanticDb.raw(`SET app.current_tenant = '${Number(payload.tenantId)}'`);
    } catch (err) {
      logger.warn({ err }, 'failed to set session-level tenant context (non-fatal)');
    }
  }

  // Open a request-scoped transaction with SET LOCAL. Every query that
  // uses `req.dbTrx` is guaranteed to run with this tenant's context —
  // immune to the connection-pool leak class of bug because a Knex
  // transaction holds the same physical connection for its lifetime.
  //
  // The transaction commits when the response completes (res 'finish'
  // or 'close'). On unexpected error before commit, it rolls back —
  // this is read-mostly so rollback is safe.
  //
  // Cost: 1 dedicated pool connection held per in-flight request.
  // Backend pool size needs to be ≥ peak concurrent requests. Tune
  // `KNEX_POOL_MAX` if you see acquire timeouts at peak.
  if (payload.tenantId) {
    let resolvedDone = false;
    let releaseTrx: (() => void) | null = null;
    let abortTrx: ((e: Error) => void) | null = null;

    const trxReady = new Promise<void>((resolveReady, rejectReady) => {
      // We hold the transaction inside a knex.transaction() callback so
      // it can't accidentally outlive its physical connection. The
      // callback only resolves when the response is about to be sent
      // (see the res.end patch below) or the client disconnects.
      const trxSettled = semanticDb.transaction(async (trx) => {
        try {
          await trx.raw(`SET LOCAL app.current_tenant = '${Number(payload.tenantId)}'`);
        } catch (err) {
          rejectReady(err);
          return;
        }
        req.dbTrx = trx;
        resolveReady();
        // Block this callback until released — throwing causes Knex to
        // rollback, returning causes commit.
        await new Promise<void>((finishResolve, finishReject) => {
          releaseTrx = finishResolve;
          abortTrx = finishReject;
        });
      }).catch((err) => {
        // Swallow the rollback marker; surface real errors as logger.warn.
        if (err?.message !== 'request_closed_before_finish') {
          logger.warn({ err }, 'tenant transaction rolled back unexpectedly');
        }
      });

      // ── Read-your-writes ordering: COMMIT BEFORE the response leaves ──
      // The previous design committed on res 'finish' — i.e. AFTER the
      // client already received the response. A client that saved and
      // immediately re-fetched could start its next request before our
      // COMMIT landed, and read the pre-write snapshot (surfaced as the
      // CI-only DELETE-then-GET-returns-200 flake; real frontends do
      // save-then-reload constantly). We now intercept the FINAL send:
      // release the transaction, wait for the commit to settle, then let
      // the last bytes go out. Streaming writes (SSE res.write) are
      // unaffected — only res.end is deferred, so a stream's final close
      // simply waits for the commit like any other response.
      const origEnd = res.end.bind(res) as (...args: unknown[]) => Response;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).end = (...args: unknown[]): Response => {
        if (resolvedDone) return origEnd(...args);
        resolvedDone = true;
        releaseTrx?.();
        void trxSettled.finally(() => origEnd(...args));
        return res;
      };

      // Client disconnected before we sent anything — roll back.
      res.once('close', () => {
        if (resolvedDone) return;
        resolvedDone = true;
        abortTrx?.(new Error('request_closed_before_finish'));
      });
    });

    try {
      await trxReady;
    } catch (err) {
      logger.error({ err }, 'failed to open tenant transaction');
      res.status(500).json({ ok: false, error: 'Internal server error' });
      return;
    }
  }

  // Run the rest of the request in an AsyncLocalStorage scope carrying
  // the tenantId + userId. AIService.callClaude reads this to (a) enforce
  // the per-tenant monthly budget, (b) attribute the call to the right
  // user in `ai_call_log` for the cost dashboard. Every async operation
  // inside `next()` inherits the scope automatically.
  if (payload.tenantId) {
    withTenantAiContext(
      { tenantId: payload.tenantId, userId: payload.sub ?? null },
      async () => { next(); },
    ).catch(next);
  } else {
    next();
  }
}

// ---------------------------------------------------------------------------
// Middleware: require a specific role (call after requireAuth)
// ---------------------------------------------------------------------------

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ ok: false, error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
