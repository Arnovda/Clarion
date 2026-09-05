/**
 * User Management API routes (admin only)
 *
 * GET    /api/users              — list all users in tenant
 * POST   /api/users/invite       — invite a new user by email
 * PATCH  /api/users/:id          — update user role or display name
 * PATCH  /api/users/:id/deactivate — soft-delete (set is_active = false)
 * PATCH  /api/users/:id/reactivate — restore a deactivated user
 * GET    /api/users/profile      — get own profile (any role)
 * PATCH  /api/users/profile      — update own display name
 * POST   /api/users/profile/password — change own password
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { reqDb } from '../db/reqDb';
import { requireAuth, requireRole, refuseDuringSupportSession, hashPassword, verifyPassword } from '../middleware/auth';
import { config } from '../config';
import { sendEmail } from '../services/emailService';
import { validate } from '../middleware/validate';
import { inviteUserSchema, eraseUserSchema } from '../middleware/schemas';
import { recordAudit } from '../services/auditService';
import { eraseUser } from '../services/accountDeletion';
import { revokeAllForUser } from '../services/refreshTokenService';
import { disableMfa } from '../services/mfaService';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'users' });

const router = Router();

/** Minimal HTML escape for the few user-supplied strings that reach an email body. */
function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/users — list all users in current tenant
// ---------------------------------------------------------------------------
router.get('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const users = await db('users')
      .where({ tenant_id: req.user!.tenantId })
      .select('id', 'email', 'display_name', 'role', 'is_active', 'mfa_enabled_at', 'created_at', 'updated_at')
      .orderBy('created_at', 'asc');

    res.json({ ok: true, data: users });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/invite — invite a new user (creates with temp password)
// ---------------------------------------------------------------------------
router.post('/invite', requireRole('admin'), validate(inviteUserSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Use the per-request tenant-scoped transaction via reqDb — every
    // query inside this handler is SET-LOCAL-scoped, immune to the
    // connection-pool race that affects session-level tenant context.
    const db = reqDb(req);

    const { email, displayName, role } = req.body as {
      email: string;
      displayName: string;
      role: 'admin' | 'analyst' | 'viewer';
    };

    if (!email?.trim() || !email.includes('@')) {
      res.status(400).json({ ok: false, error: 'Valid email is required' });
      return;
    }
    if (!displayName?.trim()) {
      res.status(400).json({ ok: false, error: 'Display name is required' });
      return;
    }
    if (!['admin', 'analyst', 'viewer'].includes(role)) {
      res.status(400).json({ ok: false, error: 'Role must be admin, analyst, or viewer' });
      return;
    }

    // Check if email already exists in this tenant
    const existing = await db('users').where({ email: email.toLowerCase() }).first();
    if (existing) {
      res.status(409).json({ ok: false, error: 'A user with this email already exists' });
      return;
    }

    // Generate a temporary password and password reset token
    const tempPassword = crypto.randomBytes(16).toString('hex');
    const passwordHash = await hashPassword(tempPassword);

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const [user] = await db('users')
      .insert({
        tenant_id: req.user!.tenantId,
        email: email.toLowerCase(),
        display_name: displayName.trim(),
        password_hash: passwordHash,
        role,
        is_active: true,
        password_reset_token: resetTokenHash,
        password_reset_expires: resetExpires.toISOString(),
      })
      .returning(['id', 'email', 'display_name', 'role', 'is_active', 'created_at']);

    // THE INVITATION IS AN EMAIL. Until 2026-09-05 this handler built the
    // link, logged it in development, returned it outside production — and
    // never sent it: in production the admin saw "Sending…" and the colleague
    // received nothing (assessment v2, P0-3). The link is a 7-day password
    // reset; redeeming it also marks the address verified (routes/auth.ts),
    // so an invitee is never caught by the email-verification gate.
    const inviteUrl = `${config.appUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(email.toLowerCase())}`;
    if (process.env.NODE_ENV === 'development') {
      log.info(`[invite-dev] Invite URL for ${email}: ${inviteUrl}`);
    }
    // `tenants` has no RLS; the name is what tells the recipient who this is from.
    const tenant = await db('tenants').where({ id: req.user!.tenantId }).first('name');
    const workspace = String(tenant?.name ?? 'Clarion');
    const inviter = req.user!.email;
    let emailed = false;
    try {
      await sendEmail({
        to: email.toLowerCase(),
        subject: `You're invited to ${workspace} on Clarion`,
        text:
          `Hi ${displayName.trim()},\n\n` +
          `${inviter} invited you to the ${workspace} workspace on Clarion as ${role}.\n\n` +
          `Set your password with the link below (valid for 7 days):\n${inviteUrl}\n\n` +
          `If you weren't expecting this, you can ignore this email.\n\n— Clarion`,
        html:
          `<p>Hi ${escapeHtml(displayName.trim())},</p>` +
          `<p><b>${escapeHtml(inviter)}</b> invited you to the <b>${escapeHtml(workspace)}</b> workspace on Clarion as <b>${role}</b>.</p>` +
          `<p><a href="${inviteUrl}" style="background:#0d4a6f;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;display:inline-block">Set your password</a></p>` +
          `<p style="color:#666;font-size:12px">Or paste this link in your browser (valid for 7 days):<br>${inviteUrl}</p>` +
          `<p style="color:#999;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`,
      });
      emailed = true;
    } catch (err) {
      // The account exists either way; the admin is told the email did not
      // go out (the UI says so) instead of a silent "Sending…" that ends.
      log.error({ err, tenantId: req.user!.tenantId }, 'invite email send failed');
    }

    await recordAudit(req, {
      action:     'user.invite',
      entityType: 'user',
      entityId:   (user as { id: number }).id,
      context:    { invited_email: email.toLowerCase(), role, display_name: displayName.trim() },
    });

    res.json({
      ok: true,
      data: user,
      emailed,
      invite_url: process.env.NODE_ENV !== 'production' ? inviteUrl : undefined,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// OWN-PROFILE ROUTES — registered BEFORE every `/:id` route on purpose.
// Express matches in registration order, so with `PATCH /:id` first,
// `PATCH /profile` resolved as `:id = 'profile'`: 403 for analysts and
// viewers, 500 for admins (`Number('profile')` is NaN). Nobody could change
// their display name (assessment 2-1; the fix first rode PR #114, which was
// closed unmerged). Pinned by tests/wave-a-small.test.ts.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/users/profile — get own profile (any authenticated user)
// ---------------------------------------------------------------------------
router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const user = await db('users')
      .where({ id: req.user!.sub })
      .select('id', 'email', 'display_name', 'role', 'is_active', 'avatar_url', 'created_at')
      .first();

    if (!user) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    // Get tenant info
    const tenant = await db('tenants')
      .where({ id: req.user!.tenantId })
      .select('name', 'slug')
      .first();

    res.json({ ok: true, data: { ...user, tenant } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/profile — update own display name
// ---------------------------------------------------------------------------
router.patch('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { displayName } = req.body as { displayName: string };

    if (!displayName?.trim()) {
      res.status(400).json({ ok: false, error: 'Display name is required' });
      return;
    }

    await db('users')
      .where({ id: req.user!.sub })
      .update({ display_name: displayName.trim(), updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/profile/password — change own password
// ---------------------------------------------------------------------------
router.post('/profile/password', refuseDuringSupportSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };

    if (!currentPassword || !newPassword) {
      res.status(400).json({ ok: false, error: 'Both current and new password are required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ ok: false, error: 'New password must be at least 8 characters' });
      return;
    }

    const user = await db('users').where({ id: req.user!.sub }).first();
    if (!user) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      res.status(401).json({ ok: false, error: 'Current password is incorrect' });
      return;
    }

    const newHash = await hashPassword(newPassword);
    await db('users')
      .where({ id: req.user!.sub })
      .update({ password_hash: newHash, updated_at: new Date().toISOString() });

    // A password change invalidates every existing session on every
    // device — if an attacker had access to ONE of the user's tokens,
    // the user resetting their password should kick them out
    // everywhere. The user's current session is also invalidated;
    // frontend should redirect to login after a successful change.
    try {
      await revokeAllForUser(req.user!.sub, req.user!.tenantId, 'password_change');
    } catch (err) {
      log.warn({ err }, '[users/profile/password] revokeAllForUser failed');
    }

    await recordAudit(req, {
      action:     'user.password_change',
      entityType: 'user',
      entityId:   req.user!.sub,
    });

    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/profile/avatar — upload avatar (base64 data URL)
// ---------------------------------------------------------------------------
router.post('/profile/avatar', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const { avatar } = req.body as { avatar: string | null };

    // avatar is a data URL like "data:image/png;base64,..." or null to remove
    if (avatar && !avatar.startsWith('data:image/')) {
      res.status(400).json({ ok: false, error: 'Avatar must be a data:image/* URL' });
      return;
    }

    // Limit size (~500KB base64 = ~375KB image)
    if (avatar && avatar.length > 500000) {
      res.status(400).json({ ok: false, error: 'Avatar image is too large (max ~375KB)' });
      return;
    }

    await db('users')
      .where({ id: req.user!.sub })
      .update({ avatar_url: avatar ?? null, updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id — update role or display name (admin only)
// ---------------------------------------------------------------------------
router.patch('/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = Number(req.params.id);
    const { role, displayName } = req.body as { role?: string; displayName?: string };

    // Prevent admin from demoting themselves
    if (userId === req.user!.sub && role && role !== 'admin') {
      res.status(400).json({ ok: false, error: 'You cannot change your own role' });
      return;
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (role && ['admin', 'analyst', 'viewer'].includes(role)) update.role = role;
    if (displayName?.trim()) update.display_name = displayName.trim();

    // Capture previous state for the audit row — surfacing 'role changed
    // from analyst → admin' is more useful than just 'role changed'.
    const before = await db('users')
      .where({ id: userId })
      .select('role', 'display_name')
      .first();

    const count = await db('users').where({ id: userId }).update(update);
    if (count === 0) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    const user = await db('users')
      .where({ id: userId })
      .select('id', 'email', 'display_name', 'role', 'is_active', 'created_at', 'updated_at')
      .first();

    // If the role actually changed, invalidate the affected user's
    // refresh tokens so the new role takes effect within at most one
    // access-token lifetime (~15 min). Without this, a demoted user
    // could keep their old elevated JWT until natural expiry. Best-
    // effort — non-fatal if it fails.
    if (before?.role && user?.role && before.role !== user.role) {
      try {
        await revokeAllForUser(userId, req.user!.tenantId, 'role_change');
      } catch (err) {
        log.warn({ err }, '[users.patch] revokeAllForUser failed');
      }
    }

    await recordAudit(req, {
      action:     'user.update',
      entityType: 'user',
      entityId:   userId,
      context: {
        before: { role: before?.role, display_name: before?.display_name },
        after:  { role: user?.role, display_name: user?.display_name },
      },
    });

    res.json({ ok: true, data: user });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/deactivate — soft-delete
// ---------------------------------------------------------------------------
router.patch('/:id/deactivate', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = Number(req.params.id);

    if (userId === req.user!.sub) {
      res.status(400).json({ ok: false, error: 'You cannot deactivate yourself' });
      return;
    }

    const count = await db('users')
      .where({ id: userId })
      .update({ is_active: false, updated_at: new Date().toISOString() });

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    // Deactivating a user must kick them out immediately. Without
    // revoking their tokens, a soft-deleted user could keep using
    // the platform until their access token naturally expired.
    try {
      await revokeAllForUser(userId, req.user!.tenantId, 'user_deactivated');
    } catch (err) {
      log.warn({ err }, '[users.deactivate] revokeAllForUser failed');
    }

    await recordAudit(req, {
      action:     'user.deactivate',
      entityType: 'user',
      entityId:   userId,
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/users/:id — GDPR erasure (anonymise PII + drop credentials)
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), validate(eraseUserSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = Number(req.params.id);
    const tenantId = req.user!.tenantId;

    if (userId === req.user!.sub) {
      res.status(400).json({ ok: false, error: 'You cannot erase your own account here — use account closure instead' });
      return;
    }

    const target = await db('users').where({ id: userId }).select('id', 'role', 'is_active').first();
    if (!target) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    // Never erase the last remaining active admin — it would lock the tenant out.
    if (target.role === 'admin') {
      const otherAdmins = await db('users')
        .where({ role: 'admin', is_active: true })
        .whereNot({ id: userId })
        .count<{ count: string }[]>('* as count');
      if (Number(otherAdmins[0].count) === 0) {
        res.status(400).json({ ok: false, error: 'Cannot erase the last active admin. Promote another admin first.' });
        return;
      }
    }

    // eraseUser nests its work in a sub-transaction of the request's
    // already-tenant-scoped transaction.
    await eraseUser(db, tenantId, userId);

    try {
      await revokeAllForUser(userId, tenantId, 'user_erased');
    } catch (err) {
      log.warn({ err }, '[users.erase] revokeAllForUser failed');
    }

    await recordAudit(req, { action: 'user.erase', entityType: 'user', entityId: userId });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/reactivate — restore a deactivated user
// ---------------------------------------------------------------------------
router.patch('/:id/reactivate', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = Number(req.params.id);
    const count = await db('users')
      .where({ id: userId })
      .update({ is_active: true, updated_at: new Date().toISOString() });

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    await recordAudit(req, {
      action:     'user.reactivate',
      entityType: 'user',
      entityId:   userId,
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/:id/reset-mfa — clear MFA for a user (admin only)
//
// Recovery path for "I lost both my authenticator AND my backup codes".
// Without this, the only fix is a direct DB UPDATE by a developer.
// Wipes the TOTP secret, mfa_enabled_at, and all backup codes. The user
// can log in with just their password until they re-enrol.
//
// Self-reset is blocked: an admin who wants to remove their own MFA
// must use POST /auth/mfa/disable, which requires password re-auth.
// Going through this endpoint would let a compromised admin session
// remove MFA without proving identity.
// ---------------------------------------------------------------------------
router.post('/:id/reset-mfa', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const userId = Number(req.params.id);

    if (!Number.isFinite(userId) || userId <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid user id' });
      return;
    }
    if (userId === req.user!.sub) {
      res.status(400).json({ ok: false, error: 'Use /auth/mfa/disable to remove your own 2FA' });
      return;
    }

    // RLS scopes this to the admin's tenant — admins cannot reset MFA
    // for users in other tenants.
    const target = await db('users')
      .where({ id: userId })
      .select('id', 'email', 'mfa_enabled_at')
      .first();
    if (!target) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }
    if (!target.mfa_enabled_at) {
      res.status(400).json({ ok: false, error: '2FA is not enabled for this user' });
      return;
    }

    // disableMfa() opens its own SET LOCAL transaction. It's not joined
    // to req.dbTrx — that's OK; the audit row commits inside req.dbTrx
    // and the MFA wipe in its own. If audit fails it'll get logged but
    // the user-facing action still succeeded.
    await disableMfa(userId);

    // Kick the target user out of every device. A user who's just had
    // their 2FA reset shouldn't be silently logged in elsewhere with
    // their old session.
    try {
      await revokeAllForUser(userId, req.user!.tenantId, 'mfa_reset_by_admin');
    } catch (err) {
      log.warn({ err }, '[users/reset-mfa] revokeAllForUser failed');
    }

    await recordAudit(req, {
      action:     'mfa.disable',
      entityType: 'user',
      entityId:   userId,
      context:    { reset_by_admin: true, target_email: target.email },
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/users/audit — admin-action audit log (admin only)
//
// Query params: ?limit=50&offset=0&action=<filter>&entity_type=<filter>
//
// Returns the most recent audit_events for the tenant, joined with the
// users table for actor display_name. Auto-RLS filters per tenant.
// ---------------------------------------------------------------------------

router.get('/audit', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const limitRaw = Number(req.query.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50, 1), 200);
    const offsetRaw = Number(req.query.offset);
    const offset = Math.max(Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0, 0);

    const actionFilter = typeof req.query.action === 'string' ? req.query.action : null;
    const entityTypeFilter = typeof req.query.entity_type === 'string' ? req.query.entity_type : null;

    let query = db('audit_events as ae')
      .leftJoin('users as u', 'u.id', 'ae.actor_user_id')
      .orderBy('ae.created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .select(
        'ae.id',
        'ae.created_at',
        'ae.action',
        'ae.entity_type',
        'ae.entity_id',
        'ae.context',
        'ae.ip',
        'ae.actor_user_id',
        'ae.actor_email',
        'ae.actor_role',
        'u.display_name as actor_display_name',
      );

    if (actionFilter) query = query.where('ae.action', 'like', `${actionFilter}%`);
    if (entityTypeFilter) query = query.where('ae.entity_type', entityTypeFilter);

    const rows = await query;

    const [{ count }] = await db('audit_events')
      .modify((qb) => {
        if (actionFilter) qb.where('action', 'like', `${actionFilter}%`);
        if (entityTypeFilter) qb.where('entity_type', entityTypeFilter);
      })
      .count<{ count: string }[]>('* as count');

    res.json({
      ok: true,
      data: rows,
      pagination: { limit, offset, total: Number(count) },
    });
  } catch (err) { next(err); }
});

export default router;
