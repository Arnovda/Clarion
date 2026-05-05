import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { JwtPayload, UserRole } from '../shared/types';
import { semanticDb } from '../db/knex';
import { withTenantAiContext } from '../services/aiBudget';

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

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set');
  return secret;
}

export function signToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, getSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as unknown as JwtPayload;
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

  try {
    const token = header.slice(7);
    const payload = verifyToken(token);
    req.user = payload;

    // Set Postgres RLS tenant context so queries are automatically filtered
    if (payload.tenantId) {
      // SET doesn't support parameterized queries in Postgres — Number() coercion prevents injection
      await semanticDb.raw(`SET app.current_tenant = '${Number(payload.tenantId)}'`);
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
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
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
