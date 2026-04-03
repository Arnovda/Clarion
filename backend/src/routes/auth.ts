import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { semanticDb } from '../db/knex';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
} from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/auth/register — Create a new tenant + first admin user
// ---------------------------------------------------------------------------

router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { companyName, email, password, displayName } = req.body as {
      companyName: string;
      email: string;
      password: string;
      displayName: string;
    };

    // Validation
    if (!companyName?.trim()) {
      res.status(400).json({ ok: false, error: 'Company name is required' });
      return;
    }
    if (!email?.trim() || !email.includes('@')) {
      res.status(400).json({ ok: false, error: 'Valid email is required' });
      return;
    }
    if (!password || password.length < 8) {
      res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
      return;
    }
    if (!displayName?.trim()) {
      res.status(400).json({ ok: false, error: 'Display name is required' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await semanticDb('users').where({ email: normalizedEmail }).first();
    if (existing) {
      res.status(409).json({ ok: false, error: 'An account with this email already exists' });
      return;
    }

    // Create tenant
    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const [tenantRow] = await semanticDb('tenants')
      .insert({
        name: companyName.trim(),
        slug,
        status: 'active',
      })
      .returning('id');

    const tenantId: number = typeof tenantRow === 'object' ? (tenantRow as { id: number }).id : (tenantRow as number);

    // Create admin user
    const passwordHash = await hashPassword(password);

    const [userRow] = await semanticDb('users')
      .insert({
        tenant_id: tenantId,
        email: normalizedEmail,
        password_hash: passwordHash,
        display_name: displayName.trim(),
        role: 'admin',
        is_active: true,
      })
      .returning('id');

    const userId: number = typeof userRow === 'object' ? (userRow as { id: number }).id : (userRow as number);

    // Sign JWT
    const token = signToken({
      sub: userId,
      tenantId,
      email: normalizedEmail,
      displayName: displayName.trim(),
      role: 'admin',
    });

    res.status(201).json({
      ok: true,
      data: {
        token,
        user: {
          id: userId,
          tenantId,
          email: normalizedEmail,
          displayName: displayName.trim(),
          role: 'admin',
        },
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login — Authenticate with email + password
// ---------------------------------------------------------------------------

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      res.status(400).json({ ok: false, error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user (across all tenants — email is unique per tenant but we look up globally for login)
    const user = await semanticDb('users')
      .where({ email: normalizedEmail, is_active: true })
      .first();

    if (!user) {
      res.status(401).json({ ok: false, error: 'Invalid email or password' });
      return;
    }

    // Verify password
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ ok: false, error: 'Invalid email or password' });
      return;
    }

    // Check tenant is active
    const tenant = await semanticDb('tenants').where({ id: user.tenant_id }).first();
    if (!tenant || tenant.status !== 'active') {
      res.status(403).json({ ok: false, error: 'Your organization has been suspended' });
      return;
    }

    // Sign JWT
    const token = signToken({
      sub: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    });

    res.json({
      ok: true,
      data: {
        token,
        user: {
          id: user.id,
          tenantId: user.tenant_id,
          email: user.email,
          displayName: user.display_name,
          role: user.role,
        },
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — Returns current user info
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await semanticDb('users').where({ id: req.user!.sub, is_active: true }).first();
    if (!user) {
      res.status(401).json({ ok: false, error: 'User not found' });
      return;
    }

    const tenant = await semanticDb('tenants').where({ id: user.tenant_id }).first();

    res.json({
      ok: true,
      data: {
        id: user.id,
        tenantId: user.tenant_id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        tenantName: tenant?.name,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh — Extend session without re-login
// ---------------------------------------------------------------------------

router.post('/refresh', requireAuth, (req: Request, res: Response) => {
  // Re-sign with fresh expiry using the same payload
  const token = signToken({
    sub: req.user!.sub,
    tenantId: req.user!.tenantId,
    email: req.user!.email,
    displayName: req.user!.displayName,
    role: req.user!.role,
  });

  res.json({ ok: true, data: { token } });
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password — Request a password reset email
// ---------------------------------------------------------------------------

router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as { email: string };

    if (!email) {
      res.status(400).json({ ok: false, error: 'Email is required' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await semanticDb('users').where({ email: normalizedEmail, is_active: true }).first();

    // Always return success to prevent email enumeration
    if (!user) {
      res.json({ ok: true, data: { message: 'If an account exists, a reset link has been sent.' } });
      return;
    }

    // Generate reset token (random 32 bytes → hex)
    const rawToken = crypto.randomBytes(32).toString('hex');
    // Store a hash of the token (never store raw tokens in DB)
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await semanticDb('users').where({ id: user.id }).update({
      password_reset_token: tokenHash,
      password_reset_expires: expires.toISOString(),
    });

    // TODO: Send email with reset link containing rawToken
    // For now, log it (dev only)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[auth] Password reset token for ${normalizedEmail}: ${rawToken}`);
      console.log(`[auth] Reset URL: http://localhost:3000/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`);
    }

    res.json({ ok: true, data: { message: 'If an account exists, a reset link has been sent.' } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password — Set a new password with reset token
// ---------------------------------------------------------------------------

router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, token, newPassword } = req.body as {
      email: string;
      token: string;
      newPassword: string;
    };

    if (!email || !token || !newPassword) {
      res.status(400).json({ ok: false, error: 'Email, token, and new password are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const user = await semanticDb('users')
      .where({
        email: normalizedEmail,
        password_reset_token: tokenHash,
        is_active: true,
      })
      .where('password_reset_expires', '>', new Date().toISOString())
      .first();

    if (!user) {
      res.status(400).json({ ok: false, error: 'Invalid or expired reset token' });
      return;
    }

    // Update password and clear reset token
    const passwordHash = await hashPassword(newPassword);
    await semanticDb('users').where({ id: user.id }).update({
      password_hash: passwordHash,
      password_reset_token: null,
      password_reset_expires: null,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true, data: { message: 'Password has been reset. You can now log in.' } });
  } catch (err) { next(err); }
});

export default router;
