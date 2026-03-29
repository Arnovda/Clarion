import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload, UserRole } from '../../../shared/types';

// Two hardcoded users for the POC — replace with DB-backed auth in production
export const USERS: Record<string, { password: string; role: UserRole }> = {
  admin:  { password: 'admin123',  role: 'epicdata_admin' },
  client: { password: 'client123', role: 'client_user'    },
};

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

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

// Middleware: require a valid JWT
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'Missing or invalid Authorization header' });
    return;
  }

  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, getSecret()) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

// Middleware: require a specific role (call after requireAuth)
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ ok: false, error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
