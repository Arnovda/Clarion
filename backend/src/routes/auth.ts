import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { semanticDb } from '../db/knex';
import { config, requireJwtSecret } from '../config';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth, refuseDuringSupportSession } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
} from '../middleware/schemas';
import {
  emailVerificationRequired,
  issueVerificationToken,
  hashVerificationToken,
  sendVerificationEmail,
  defaultMonthlyTokenBudget,
  slugCandidates,
} from '../services/signup';
import { sendEmail } from '../services/emailService';
import {
  createRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
} from '../services/refreshTokenService';
import jwt from 'jsonwebtoken';
import {
  setupMfa,
  enableMfa,
  verifyMfaCode,
  disableMfa,
  regenerateBackupCodes,
  isMfaEnabled,
} from '../services/mfaService';
import {
  buildRegistrationOptions,
  verifyAndStoreRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  listUserCredentials,
  deleteCredential,
  userHasWebauthn,
} from '../services/webauthnService';
import { verifyPassword as verifyPasswordFn } from '../middleware/auth';
import { reqDb } from '../db/reqDb';
import { unauthQuery } from '../db/unauthQuery';
import { tenantScopedWrite } from '../db/tenantScopedWrite';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'auth' });

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

    // Check if email already exists. Wrapped in unauthQuery so the
    // SELECT runs with a clean tenant context — a pool connection that
    // still carries an old `app.current_tenant` from a prior
    // authenticated request would otherwise hide the existing user
    // under RLS and we'd happily let a duplicate register go through.
    const existing = await unauthQuery((trx) =>
      trx('users').where({ email: normalizedEmail }).first(),
    );
    if (existing) {
      res.status(409).json({ ok: false, error: 'An account with this email already exists' });
      return;
    }

    // Create tenant. The slug lands in a UNIQUE column, so the second
    // customer with the same company name used to 500 on the raw 23505.
    // Insert-and-retry over the candidate list rather than check-then-insert
    // — two concurrent registrations for the same name would both pass the
    // check and one would still hit the constraint.
    //
    // monthly_token_budget is stamped NON-NULL on purpose: NULL means
    // unlimited to the budget enforcement in services/aiBudget.ts, and an
    // unauthenticated stranger must not be able to register into unlimited
    // AI spend. Operators raise the budget per tenant when a real customer
    // needs more.
    const tokenBudget = defaultMonthlyTokenBudget();
    let tenantId: number | null = null;
    for (const slug of slugCandidates(companyName)) {
      try {
        const [tenantRow] = await semanticDb('tenants')
          .insert({
            name: companyName.trim(),
            slug,
            status: 'active',
            monthly_token_budget: tokenBudget,
          })
          .returning('id');
        tenantId = typeof tenantRow === 'object' ? (tenantRow as { id: number }).id : (tenantRow as number);
        break;
      } catch (err) {
        const pgCode = (err as { code?: string })?.code;
        if (pgCode === '23505') continue; // slug taken — try the next candidate
        throw err;
      }
    }
    if (tenantId == null) {
      // Every candidate — including a random suffix — collided. Not a state
      // reachable outside deliberate abuse; refuse rather than loop forever.
      res.status(409).json({ ok: false, error: 'Could not allocate a workspace identifier — please try again' });
      return;
    }

    // Email verification: when enforcement is on, the account starts
    // unverified, gets an emailed confirmation link, and receives NO tokens
    // until the address is proven (login refuses with `email_unverified`).
    // When it is off — no email provider, so nothing could ever deliver the
    // link — the user is created pre-verified, which also means a later
    // enforcement flip cannot retroactively lock existing accounts out.
    const requiresVerification = emailVerificationRequired();
    const verification = requiresVerification ? issueVerificationToken() : null;

    // RLS WITH CHECK on `users` requires tenant_id to match
    // app.current_tenant. /register is unauthenticated so we haven't
    // set it yet — set it now to the freshly-created tenant before
    // INSERT. Done inside a transaction so SET LOCAL is scoped and
    // doesn't leak to other pool consumers.
    const passwordHash = await hashPassword(password);
    const userRow = await semanticDb.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);
      const [row] = await trx('users')
        .insert({
          tenant_id: tenantId,
          email: normalizedEmail,
          password_hash: passwordHash,
          display_name: displayName.trim(),
          role: 'admin',
          is_active: true,
          email_verified_at: requiresVerification ? null : new Date().toISOString(),
          email_verification_token: verification?.hash ?? null,
          email_verification_expires: verification?.expiresAt.toISOString() ?? null,
        })
        .returning('id');
      return row;
    });

    const userId: number = typeof userRow === 'object' ? (userRow as { id: number }).id : (userRow as number);

    if (requiresVerification && verification) {
      // Send the confirmation link and stop here — no tokens until the
      // inbox is proven. The frontend renders the check-your-email state
      // off `requiresVerification`.
      await sendVerificationEmail(normalizedEmail, displayName.trim(), verification.raw);
      res.status(201).json({
        ok: true,
        data: {
          requiresVerification: true,
          message: 'Check your inbox — confirm your email address to activate the workspace.',
        },
      });
      return;
    }

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

    // Find user (across all tenants — email is unique per tenant but we look
    // up globally for login). Runs under `unauthQuery` so the connection's
    // tenant context is reset to empty for this transaction — without it,
    // a stale `app.current_tenant` left on a pooled connection by a prior
    // authenticated request would cause RLS to filter the user OUT and
    // we'd return a spurious 401 even with the correct password. The
    // session-level-SET pool-race fix; see backend/src/db/unauthQuery.ts.
    const user = await unauthQuery((trx) =>
      trx('users')
        .where({ email: normalizedEmail, is_active: true })
        .first(),
    );

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

    // Check tenant is active. `tenants` has no RLS so the read is safe
    // outside the unauthQuery, but we keep it inside for symmetry.
    const tenant = await unauthQuery((trx) =>
      trx('tenants').where({ id: user.tenant_id }).first(),
    );
    if (!tenant || tenant.status !== 'active') {
      res.status(403).json({ ok: false, error: 'Your organization has been suspended' });
      return;
    }

    // Email-verification gate — only while enforcement is on (see
    // services/signup.ts). Checked AFTER the password so the answer leaks
    // nothing to someone who doesn't hold the credentials, and BEFORE the
    // MFA gate so an unverified account is told the actual blocker instead
    // of being walked through a second factor it then fails anyway. The
    // machine-readable `code` is what the frontend keys the resend UI on.
    if (emailVerificationRequired() && !user.email_verified_at) {
      res.status(403).json({
        ok: false,
        error: 'Please confirm your email address first — check your inbox for the verification link.',
        code: 'email_unverified',
      });
      return;
    }

    // 2FA gate — if the user has enrolled TOTP or a WebAuthn credential,
    // we don't issue real tokens yet. Instead we return a short-lived
    // challenge: a JWT for TOTP completion plus, when applicable, a
    // navigator.credentials.get() options bundle for WebAuthn. The
    // frontend offers whichever methods are available; the user picks.
    // POST to /auth/mfa/verify (TOTP) or /auth/webauthn/login-verify
    // (WebAuthn) completes the login and issues real access + refresh
    // tokens.
    const hasWebauthn = await userHasWebauthn(user.id);
    if (user.mfa_enabled_at || hasWebauthn) {
      const payload: {
        mfaRequired: boolean;
        mfaChallengeToken?: string;
        webauthnRequired?: boolean;
        webauthnOptions?: unknown;
        webauthnChallengeToken?: string;
      } = { mfaRequired: !!user.mfa_enabled_at };

      if (user.mfa_enabled_at) {
        payload.mfaChallengeToken = jwt.sign(
          {
            purpose: 'mfa_challenge',
            sub:     user.id,
            tenant:  user.tenant_id,
          },
          getMfaChallengeSecret(),
          { expiresIn: '5m' },
        );
      }

      if (hasWebauthn) {
        const opts = await buildAuthenticationOptions(user.id);
        if (opts) {
          payload.webauthnRequired = true;
          payload.webauthnOptions = opts.options;
          payload.webauthnChallengeToken = opts.challengeToken;
        }
      }

      res.json({ ok: true, data: payload });
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
  } catch (err) { log.error({ err }, '[auth/login] Error'); next(err); }
});

/**
 * Helper — the secret used for the short-lived MFA challenge token.
 * We use the same JWT_SECRET as for access tokens. The challenge token
 * is purpose-tagged (`purpose: 'mfa_challenge'`) so we can distinguish
 * it from a real access token at verification time.
 */
function getMfaChallengeSecret(): string {
  return requireJwtSecret();
}

// ---------------------------------------------------------------------------
// GET /api/auth/me — Returns current user info
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Use the request-scoped trx so the query runs inside SET LOCAL
    // app.current_tenant, immune to the pool-race window. The user's
    // own row is RLS-allowed within their tenant; no auth_lookup carve-out
    // is needed because we have authenticated context here.
    const db = reqDb(req);
    const user = await db('users').where({ id: req.user!.sub, is_active: true }).first();
    if (!user) {
      res.status(401).json({ ok: false, error: 'User not found' });
      return;
    }

    const tenant = await db('tenants').where({ id: user.tenant_id }).first();

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
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) {
      res.status(401).json({ ok: false, error: 'No user' });
      return;
    }
    const revoked = await revokeAllForUser(userId, tenantId, 'logout_all');
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
    // SELECT runs inside unauthQuery — see login route for the rationale
    // (pool-race on session-level app.current_tenant). The follow-up
    // UPDATE switches to tenantScopedWrite using the user's tenant_id:
    // the `auth_lookup` RLS policy on `users` is FOR SELECT only, so a
    // write under empty current_tenant context silently affects 0 rows.
    // See backend/src/db/tenantScopedWrite.ts.
    const user = await unauthQuery((trx) =>
      trx('users').where({ email: normalizedEmail, is_active: true }).first(),
    );

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

    await tenantScopedWrite(user.tenant_id, (trx) =>
      trx('users').where({ id: user.id }).update({
        password_reset_token: tokenHash,
        password_reset_expires: expires.toISOString(),
      }),
    );

    // Send the reset email. emailService is a no-op when SMTP isn't
    // configured (dev), and we still log the URL so devs can paste it
    // into their browser. Wrapped in try/catch — a delivery failure
    // shouldn't leak the existence of the account or 500 the request.
    // Resolve the absolute base URL for the reset link. ORDER MATTERS:
    // if any of these is missing or returns an empty string, the link in
    // the email is relative ("/reset-password?...") and email clients are
    // free to rewrite the host (Telenet's webmail in particular wraps
    // relative URLs in mail.telenet.be → 404s). Always emit an absolute
    // URL — defaulting to '' in prod was the bug that locked the user
    // out after the very first forgot-password attempt in prod.
    const resetUrl = `${config.appUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;
    try {
      await sendEmail({
        to: normalizedEmail,
        subject: 'Reset your Clarion password',
        text:
          `Hi ${user.display_name ?? 'there'},\n\n` +
          `We received a request to reset your Clarion password.\n\n` +
          `Click the link below to set a new one (valid for 1 hour):\n${resetUrl}\n\n` +
          `If you didn't request this, you can safely ignore this email — your password won't change.\n\n` +
          `— Clarion`,
        html:
          `<p>Hi ${user.display_name ?? 'there'},</p>` +
          `<p>We received a request to reset your Clarion password.</p>` +
          `<p><a href="${resetUrl}" style="background:#0d4a6f;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;display:inline-block">Set a new password</a></p>` +
          `<p style="color:#666;font-size:12px">Or paste this link in your browser (valid for 1 hour):<br>${resetUrl}</p>` +
          `<p style="color:#999;font-size:12px">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
      });
    } catch (e) {
      log.error({ err: e }, 'forgot-password email send failed');
      // Fall through — we still respond with the generic message so we
      // don't leak whether SMTP is broken vs the account doesn't exist.
    }
    // Dev convenience: log the reset URL to stdout so a developer can
    // grab it without running SMTP locally. Gated tightly on NODE_ENV
    // === 'development' (NOT just != 'production') — staging logs are
    // routinely searched by ops people, and a reset URL is a credential.
    if (process.env.NODE_ENV === 'development') {
      log.info(`[auth-dev] Password reset URL for ${normalizedEmail}: ${resetUrl}`);
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

    // Lookup + UPDATE both unauthQuery'd — see login route comment.
    const user = await unauthQuery((trx) =>
      trx('users')
        .where({
          email: normalizedEmail,
          password_reset_token: tokenHash,
          is_active: true,
        })
        .where('password_reset_expires', '>', new Date().toISOString())
        .first(),
    );

    if (!user) {
      res.status(400).json({ ok: false, error: 'Invalid or expired reset token' });
      return;
    }

    // Update password and clear reset token. tenantScopedWrite is
    // mandatory here: the same RLS-blocks-unauth-UPDATE issue that
    // affects forgot-password applies — see tenantScopedWrite.ts.
    const passwordHash = await hashPassword(newPassword);
    await tenantScopedWrite(user.tenant_id, (trx) =>
      trx('users').where({ id: user.id }).update({
        password_hash: passwordHash,
        password_reset_token: null,
        password_reset_expires: null,
        // Redeeming a token that only ever existed inside an email IS proof
        // of inbox control — the same proof /verify-email collects. Without
        // this, an INVITED user (created unverified, onboarded through this
        // very route) could never log in while verification is enforced.
        email_verified_at: user.email_verified_at ?? new Date().toISOString(),
        email_verification_token: null,
        email_verification_expires: null,
        updated_at: new Date().toISOString(),
      }),
    );

    // Revoke every active refresh token for this user. A password
    // reset commonly follows a suspected compromise — the user should
    // be logged out of every device. Best-effort; non-fatal.
    try {
      await revokeAllForUser(user.id, user.tenant_id, 'password_reset');
    } catch (err) {
      log.warn({ err }, '[auth/reset-password] revokeAllForUser failed');
    }

    res.json({ ok: true, data: { message: 'Password has been reset. You can now log in.' } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-email — Prove control of the registered address
//
// Body: { email, token }. The raw token arrives from the emailed link;
// the row stores its SHA-256 (same discipline as password reset). On a
// match inside the expiry window the account is marked verified and the
// login gate opens. Unauthenticated by construction — the whole point is
// that the user cannot log in yet.
// ---------------------------------------------------------------------------

router.post('/verify-email', validate(verifyEmailSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, token } = req.body as { email: string; token: string };
    const tokenHash = hashVerificationToken(token);

    // Lookup under unauthQuery (auth_lookup carve-out), write under
    // tenantScopedWrite — the same two-phase shape as reset-password and
    // for the same reason: auth_lookup is FOR SELECT only.
    const user = await unauthQuery((trx) =>
      trx('users')
        .where({ email, email_verification_token: tokenHash, is_active: true })
        .where('email_verification_expires', '>', new Date().toISOString())
        .first(),
    );

    if (!user) {
      res.status(400).json({ ok: false, error: 'Invalid or expired verification link' });
      return;
    }

    await tenantScopedWrite(user.tenant_id, (trx) =>
      trx('users').where({ id: user.id }).update({
        email_verified_at: user.email_verified_at ?? new Date().toISOString(),
        email_verification_token: null,
        email_verification_expires: null,
        updated_at: new Date().toISOString(),
      }),
    );

    res.json({ ok: true, data: { message: 'Email confirmed. You can now sign in.' } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/auth/resend-verification — Re-send the confirmation link
//
// Body: { email }. Enumeration-safe like forgot-password: the response is
// identical whether the address exists, is already verified, or was never
// registered. Rotates the stored token so only the newest link works.
// ---------------------------------------------------------------------------

router.post('/resend-verification', validate(resendVerificationSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as { email: string };
    const generic = { ok: true, data: { message: 'If an unverified account exists, a new link has been sent.' } };

    const user = await unauthQuery((trx) =>
      trx('users').where({ email, is_active: true }).first(),
    );
    if (!user || user.email_verified_at) {
      res.json(generic);
      return;
    }

    const verification = issueVerificationToken();
    await tenantScopedWrite(user.tenant_id, (trx) =>
      trx('users').where({ id: user.id }).update({
        email_verification_token: verification.hash,
        email_verification_expires: verification.expiresAt.toISOString(),
      }),
    );
    await sendVerificationEmail(email, user.display_name ?? null, verification.raw);

    res.json(generic);
  } catch (err) { next(err); }
});

// ===========================================================================
// MFA (TOTP) endpoints
// ===========================================================================

interface MfaChallengePayload {
  purpose: 'mfa_challenge';
  sub: number;
  tenant: number;
}

function verifyMfaChallenge(token: string): MfaChallengePayload {
  const payload = jwt.verify(token, getMfaChallengeSecret()) as unknown as MfaChallengePayload;
  if (payload?.purpose !== 'mfa_challenge') {
    throw new Error('Invalid MFA challenge token');
  }
  return payload;
}

/**
 * POST /api/auth/mfa/verify
 * Body: { mfaChallengeToken, code }
 *
 * Completes a login when the user has MFA enabled. The challenge token
 * was issued by /auth/login after a successful password check. On
 * valid code: issues real access + refresh tokens (same shape as a
 * non-MFA login response).
 */
router.post('/mfa/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { mfaChallengeToken, code } = req.body as {
      mfaChallengeToken?: string;
      code?: string;
    };
    if (!mfaChallengeToken || !code) {
      res.status(400).json({ ok: false, error: 'mfaChallengeToken and code are required' });
      return;
    }
    let challenge: MfaChallengePayload;
    try {
      challenge = verifyMfaChallenge(mfaChallengeToken);
    } catch {
      res.status(401).json({ ok: false, error: 'Invalid or expired challenge token' });
      return;
    }

    const ok = await verifyMfaCode(challenge.sub, code);
    if (!ok) {
      res.status(401).json({ ok: false, error: 'Invalid MFA code' });
      return;
    }

    // MFA-verify is unauthenticated (the user is mid-login). Same
    // pool-race protection as the password login route.
    const user = await unauthQuery((trx) =>
      trx('users').where({ id: challenge.sub, is_active: true }).first(),
    );
    if (!user) {
      res.status(401).json({ ok: false, error: 'User not found' });
      return;
    }

    const token = signToken({
      sub:         user.id,
      tenantId:    user.tenant_id,
      email:       user.email,
      displayName: user.display_name,
      role:        user.role,
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
  } catch (err) { next(err); }
});

/**
 * POST /api/auth/mfa/setup
 * Auth: bearer token (user enrolling for the first time)
 *
 * Returns the TOTP secret + a QR-code data URL. User scans, then
 * confirms via /mfa/enable with the first valid code.
 */
router.post('/mfa/setup', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const email = req.user!.email;
    const enrolment = await setupMfa(userId, email);
    res.json({ ok: true, data: enrolment });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to start MFA setup';
    res.status(400).json({ ok: false, error: msg });
  }
});

/**
 * POST /api/auth/mfa/enable
 * Body: { code }
 * Auth: bearer token
 *
 * Activates MFA. Returns 10 single-use backup codes. The frontend MUST
 * display these to the user EXACTLY ONCE — they're never retrievable
 * again, only regenerable (which invalidates the prior set).
 */
router.post('/mfa/enable', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ ok: false, error: 'code is required' });
      return;
    }
    const result = await enableMfa(req.user!.sub, code);
    // Audit the MFA enable as a security-significant action.
    await recordAuditSafe(req, 'mfa.enable');
    res.json({ ok: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to enable MFA';
    res.status(400).json({ ok: false, error: msg });
  }
});

/**
 * POST /api/auth/mfa/disable
 * Body: { password, code? }
 * Auth: bearer token
 *
 * Disables MFA. Requires password re-auth — otherwise an attacker who
 * compromised a session could turn off MFA. If MFA is currently
 * enforced for this user, also requires a current TOTP code.
 */
router.post('/mfa/disable', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password, code } = req.body as { password?: string; code?: string };
    if (!password) {
      res.status(400).json({ ok: false, error: 'password is required' });
      return;
    }
    // Run inside the request-scoped trx so SET LOCAL applies and the
    // query isn't subject to the pool-race window. /mfa/disable is
    // authenticated so we always have a tenant context.
    const user = await reqDb(req)('users').where({ id: req.user!.sub }).first();
    if (!user) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }
    const passwordOk = await verifyPasswordFn(password, user.password_hash);
    if (!passwordOk) {
      res.status(401).json({ ok: false, error: 'Invalid password' });
      return;
    }
    if (user.mfa_enabled_at) {
      if (!code) {
        res.status(400).json({ ok: false, error: 'code is required while MFA is active' });
        return;
      }
      const codeOk = await verifyMfaCode(user.id, code);
      if (!codeOk) {
        res.status(401).json({ ok: false, error: 'Invalid MFA code' });
        return;
      }
    }
    await disableMfa(user.id);
    await recordAuditSafe(req, 'mfa.disable');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/auth/mfa/regenerate-backup-codes
 * Body: { code }
 * Auth: bearer token + MFA enabled
 *
 * Replaces backup codes. User must prove identity with a current TOTP
 * code (or one of the EXISTING backup codes — verifyMfaCode accepts
 * either). Returns the new 10 codes.
 */
router.post('/mfa/regenerate-backup-codes', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ ok: false, error: 'code is required' });
      return;
    }
    const ok = await verifyMfaCode(req.user!.sub, code);
    if (!ok) {
      res.status(401).json({ ok: false, error: 'Invalid MFA code' });
      return;
    }
    const codes = await regenerateBackupCodes(req.user!.sub);
    await recordAuditSafe(req, 'mfa.regenerate_backup_codes');
    res.json({ ok: true, data: { backupCodes: codes } });
  } catch (err) { next(err); }
});

/**
 * GET /api/auth/mfa/status
 * Auth: bearer token
 *
 * Returns whether MFA is enabled for the caller. Frontend reads this
 * to decide whether to surface "Set up 2FA" vs "Disable 2FA" UI.
 */
router.get('/mfa/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const enabled = await isMfaEnabled(req.user!.sub);
    res.json({ ok: true, data: { enabled } });
  } catch (err) { next(err); }
});

// Lightweight audit wrapper — keeps this file from depending on the
// auditService import path (which lives in services/). Best-effort.
async function recordAuditSafe(req: Request, action: string, context?: Record<string, unknown>): Promise<void> {
  try {
    const { recordAudit } = await import('../services/auditService');
    await recordAudit(req, { action, entityType: 'user', entityId: req.user?.sub ?? null, context });
  } catch {
    // ignore — audit failures must not break the user action
  }
}

// ===========================================================================
// WebAuthn / passkey endpoints
// ===========================================================================

/**
 * POST /api/auth/webauthn/register-options
 * Auth: bearer token
 *
 * Returns PublicKeyCredentialCreationOptionsJSON for the browser's
 * navigator.credentials.create() call. The challenge is bound to a
 * short-lived signed token the frontend echoes back on register-verify.
 */
router.post('/webauthn/register-options', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { options, challengeToken } = await buildRegistrationOptions(
      req.user!.sub,
      req.user!.email,
      req.user!.displayName ?? req.user!.email,
    );
    res.json({ ok: true, data: { options, challengeToken } });
  } catch (err) { next(err); }
});

/**
 * POST /api/auth/webauthn/register-verify
 * Body: { response, challengeToken, nickname }
 * Auth: bearer token
 *
 * Verifies the attestation response against the challenge token, then
 * stores the credential. The nickname is required so the user can
 * identify which credential to delete later ("My YubiKey").
 */
router.post('/webauthn/register-verify', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { response, challengeToken, nickname } = req.body as {
      response?: unknown;
      challengeToken?: string;
      nickname?: string;
    };
    if (!response || !challengeToken || !nickname?.trim()) {
      res.status(400).json({ ok: false, error: 'response, challengeToken, and nickname are required' });
      return;
    }
    const db = reqDb(req);
    const { credentialId } = await verifyAndStoreRegistration(
      req.user!.sub,
      req.user!.tenantId,
      response as Parameters<typeof verifyAndStoreRegistration>[2],
      challengeToken,
      nickname,
      db,
    );
    await recordAuditSafe(req, 'mfa.webauthn_register', { nickname: nickname.trim() });
    res.json({ ok: true, data: { credentialId } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Registration failed';
    res.status(400).json({ ok: false, error: msg });
  }
});

/**
 * POST /api/auth/webauthn/login-verify
 * Body: { response, challengeToken }
 *
 * Public (no requireAuth) — the whole point is that the user isn't
 * logged in yet. Verifies the assertion against the challenge token
 * (issued by /auth/login when the user has WebAuthn registered) and
 * issues real access + refresh tokens on success.
 */
router.post('/webauthn/login-verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { response, challengeToken } = req.body as {
      response?: unknown;
      challengeToken?: string;
    };
    if (!response || !challengeToken) {
      res.status(400).json({ ok: false, error: 'response and challengeToken are required' });
      return;
    }
    let userId: number;
    try {
      ({ userId } = await verifyAuthentication(
        response as Parameters<typeof verifyAuthentication>[0],
        challengeToken,
      ));
    } catch {
      // Single generic 401 — never leak which step failed (unknown
      // credential vs invalid signature vs replayed challenge).
      res.status(401).json({ ok: false, error: 'Invalid security key response' });
      return;
    }

    // Lookup runs under unauthQuery — webauthn login-verify is unauthenticated
    // and suffers the same pool-race risk as the password login route.
    const user = await unauthQuery((trx) =>
      trx('users').where({ id: userId, is_active: true }).first(),
    );
    if (!user) {
      res.status(401).json({ ok: false, error: 'User not found' });
      return;
    }

    const token = signToken({
      sub:         user.id,
      tenantId:    user.tenant_id,
      email:       user.email,
      displayName: user.display_name,
      role:        user.role,
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
  } catch (err) { next(err); }
});

/**
 * GET /api/auth/webauthn/credentials
 * Auth: bearer token
 *
 * Returns the caller's registered WebAuthn credentials so /profile
 * can render "My security keys" with last-used timestamps + a delete
 * button per key.
 */
router.get('/webauthn/credentials', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const credentials = await listUserCredentials(req.user!.sub, db);
    res.json({ ok: true, data: credentials });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/auth/webauthn/credentials/:id
 * Auth: bearer token
 *
 * Removes one of the caller's registered credentials. Doesn't disable
 * any other 2FA factors — TOTP stays active even if all WebAuthn
 * credentials are removed.
 */
router.delete('/webauthn/credentials/:id', requireAuth, refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const credentialRowId = Number(req.params.id);
    if (!Number.isFinite(credentialRowId)) {
      res.status(400).json({ ok: false, error: 'Invalid credential id' });
      return;
    }
    const removed = await deleteCredential(req.user!.sub, credentialRowId, db);
    if (!removed) {
      res.status(404).json({ ok: false, error: 'Credential not found' });
      return;
    }
    await recordAuditSafe(req, 'mfa.webauthn_remove', { credential_row_id: credentialRowId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
