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
import { validate } from '../middleware/validate';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../middleware/schemas';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/auth/register — Create a new tenant + first admin user
// ---------------------------------------------------------------------------

router.post('/register', validate(registerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { companyName, email, password, displayName } = req.body as {
      companyName: string;
      email: string;    // already lowercased + trimmed by Zod
      password: string;
      displayName: string;
    };

    const normalizedEmail = email; // already normalized by Zod transform

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

router.post('/login', validate(loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    const normalizedEmail = email; // already normalized by Zod transform

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
  } catch (err) { console.error('[auth/login] Error:', err); next(err); }
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

router.post('/forgot-password', validate(forgotPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as { email: string };

    const normalizedEmail = email; // already normalized by Zod
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

    // Send the reset email. emailService is a no-op when SMTP isn't
    // configured (dev), and we still log the URL so devs can paste it
    // into their browser. Wrapped in try/catch — a delivery failure
    // shouldn't leak the existence of the account or 500 the request.
    const baseUrl = process.env.FRONTEND_URL
      ?? process.env.PUBLIC_APP_URL
      ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000');
    const resetUrl = `${baseUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;
    try {
      const { sendEmail } = await import('../services/emailService');
      await sendEmail({
        to: normalizedEmail,
        subject: 'Reset your Clarion password',
        text:
          `Hi ${user.name ?? 'there'},\n\n` +
          `We received a request to reset your Clarion password.\n\n` +
          `Click the link below to set a new one (valid for 1 hour):\n${resetUrl}\n\n` +
          `If you didn't request this, you can safely ignore this email — your password won't change.\n\n` +
          `— Clarion`,
        html:
          `<p>Hi ${user.name ?? 'there'},</p>` +
          `<p>We received a request to reset your Clarion password.</p>` +
          `<p><a href="${resetUrl}" style="background:#0d4a6f;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;display:inline-block">Set a new password</a></p>` +
          `<p style="color:#666;font-size:12px">Or paste this link in your browser (valid for 1 hour):<br>${resetUrl}</p>` +
          `<p style="color:#999;font-size:12px">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[auth] forgot-password email send failed', e);
      // Fall through — we still respond with the generic message so we
      // don't leak whether SMTP is broken vs the account doesn't exist.
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[auth] Password reset token for ${normalizedEmail}: ${rawToken}`);
      console.log(`[auth] Reset URL: ${resetUrl}`);
    }

    res.json({ ok: true, data: { message: 'If an account exists, a reset link has been sent.' } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password — Set a new password with reset token
// ---------------------------------------------------------------------------

router.post('/reset-password', validate(resetPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Zod schema uses 'password' but the route originally used 'newPassword'
    const { email, token, password: newPassword } = req.body as {
      email: string;
      token: string;
      password: string;
    };

    const normalizedEmail = email; // already normalized by Zod
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
