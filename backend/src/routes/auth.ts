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
import {
  createRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
} from '../services/refreshTokenService';

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

    // Sign JWT access token (short-lived) + create refresh token
    // (long-lived, server-side revocable).
    const token = signToken({
      sub: userId,
      tenantId,
      email: normalizedEmail,
      displayName: displayName.trim(),
      role: 'admin',
    });
    const refresh = await createRefreshToken({
      userId,
      tenantId,
      email: normalizedEmail,
      displayName: displayName.trim(),
      role: 'admin',
    }, req);

    res.status(201).json({
      ok: true,
      data: {
        token,
        refreshToken: refresh.raw,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
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

    // Issue access + refresh tokens. The access token expires in 15min
    // (default); when the frontend gets a 401 on an expired access
    // token, it POSTs /auth/refresh with the refresh token to swap for
    // a fresh access token. Refresh tokens are stored hashed and can
    // be revoked server-side (logout, password change, admin action).
    const token = signToken({
      sub: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    });
    const refresh = await createRefreshToken({
      userId:      user.id,
      tenantId:    user.tenant_id,
      email:       user.email,
      displayName: user.display_name,
      role:        user.role,
    }, req);

    res.json({
      ok: true,
      data: {
        token,
        refreshToken: refresh.raw,
        refreshExpiresAt: refresh.expiresAt.toISOString(),
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
// POST /api/auth/refresh — Exchange a refresh token for a fresh access token
//
// Body: { refreshToken: string }
//
// Public endpoint (no requireAuth) — the whole point is that the access
// token has expired. Validates the refresh token against refresh_tokens
// (hash match + not revoked + not expired + user still active), then
// issues a new access token. The refresh token itself stays valid
// until its natural expiry (no rotation in v1).
// ---------------------------------------------------------------------------

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (!refreshToken) {
      res.status(400).json({ ok: false, error: 'refreshToken is required' });
      return;
    }
    const payload = await validateRefreshToken(refreshToken, req);
    if (!payload) {
      // Single error message for every failure mode to avoid leaking
      // which step failed (unknown vs revoked vs expired vs deactivated).
      res.status(401).json({ ok: false, error: 'Invalid or expired refresh token' });
      return;
    }
    const token = signToken({
      sub:         payload.userId,
      tenantId:    payload.tenantId,
      email:       payload.email,
      displayName: payload.displayName ?? '',
      role:        payload.role,
    });
    res.json({ ok: true, data: { token } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout — Revoke the caller's refresh token
//
// Body: { refreshToken: string }
//
// Public endpoint (the access token may already be expired by the time
// the user clicks logout). Idempotent — revoking an already-revoked
// token is a no-op.
// ---------------------------------------------------------------------------

router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (refreshToken) {
      await revokeRefreshToken(refreshToken, 'logout');
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout-all — Revoke all refresh tokens for the caller
//
// Useful for "log me out everywhere" UX + the password-change cascade.
// Requires a valid access token (so we know who's asking).
// ---------------------------------------------------------------------------

router.post('/logout-all', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ ok: false, error: 'No user' });
      return;
    }
    const revoked = await revokeAllForUser(userId, 'logout_all');
    res.json({ ok: true, data: { revoked } });
  } catch (err) { next(err); }
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
    // Dev convenience: log the reset URL to stdout so a developer can
    // grab it without running SMTP locally. Gated tightly on NODE_ENV
    // === 'development' (NOT just != 'production') — staging logs are
    // routinely searched by ops people, and a reset URL is a credential.
    if (process.env.NODE_ENV === 'development') {
      console.log(`[auth-dev] Password reset URL for ${normalizedEmail}: ${resetUrl}`);
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

    // Revoke every active refresh token for this user. A password
    // reset commonly follows a suspected compromise — the user should
    // be logged out of every device. Best-effort; non-fatal.
    try {
      await revokeAllForUser(user.id, 'password_reset');
    } catch (err) {
      console.warn('[auth/reset-password] revokeAllForUser failed', err);
    }

    res.json({ ok: true, data: { message: 'Password has been reset. You can now log in.' } });
  } catch (err) { next(err); }
});

export default router;
