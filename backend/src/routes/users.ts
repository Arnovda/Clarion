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
import { semanticDb } from '../db/knex';
import { requireAuth, requireRole, hashPassword, verifyPassword } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { inviteUserSchema } from '../middleware/schemas';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/users — list all users in current tenant
// ---------------------------------------------------------------------------
router.get('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await semanticDb('users')
      .where({ tenant_id: req.user!.tenantId })
      .select('id', 'email', 'display_name', 'role', 'is_active', 'created_at', 'updated_at')
      .orderBy('created_at', 'asc');

    res.json({ ok: true, data: users });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/invite — invite a new user (creates with temp password)
// ---------------------------------------------------------------------------
router.post('/invite', requireRole('admin'), validate(inviteUserSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
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
    const existing = await semanticDb('users').where({ email: email.toLowerCase() }).first();
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

    const [user] = await semanticDb('users')
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

    // In production, send an email with the invite link
    // For now, log the invite URL (includes reset token for setting password)
    const inviteUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:3000'}/reset-password?token=${resetToken}&email=${encodeURIComponent(email.toLowerCase())}`;
    console.log(`[invite] Invite link for ${email}: ${inviteUrl}`);

    res.json({
      ok: true,
      data: user,
      invite_url: process.env.NODE_ENV !== 'production' ? inviteUrl : undefined,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id — update role or display name (admin only)
// ---------------------------------------------------------------------------
router.patch('/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    const count = await semanticDb('users').where({ id: userId }).update(update);
    if (count === 0) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    const user = await semanticDb('users')
      .where({ id: userId })
      .select('id', 'email', 'display_name', 'role', 'is_active', 'created_at', 'updated_at')
      .first();

    res.json({ ok: true, data: user });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/deactivate — soft-delete
// ---------------------------------------------------------------------------
router.patch('/:id/deactivate', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.params.id);

    if (userId === req.user!.sub) {
      res.status(400).json({ ok: false, error: 'You cannot deactivate yourself' });
      return;
    }

    const count = await semanticDb('users')
      .where({ id: userId })
      .update({ is_active: false, updated_at: new Date().toISOString() });

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/reactivate — restore a deactivated user
// ---------------------------------------------------------------------------
router.patch('/:id/reactivate', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = Number(req.params.id);
    const count = await semanticDb('users')
      .where({ id: userId })
      .update({ is_active: true, updated_at: new Date().toISOString() });

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/users/profile — get own profile (any authenticated user)
// ---------------------------------------------------------------------------
router.get('/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await semanticDb('users')
      .where({ id: req.user!.sub })
      .select('id', 'email', 'display_name', 'role', 'is_active', 'avatar_url', 'created_at')
      .first();

    if (!user) {
      res.status(404).json({ ok: false, error: 'User not found' });
      return;
    }

    // Get tenant info
    const tenant = await semanticDb('tenants')
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
    const { displayName } = req.body as { displayName: string };

    if (!displayName?.trim()) {
      res.status(400).json({ ok: false, error: 'Display name is required' });
      return;
    }

    await semanticDb('users')
      .where({ id: req.user!.sub })
      .update({ display_name: displayName.trim(), updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/profile/password — change own password
// ---------------------------------------------------------------------------
router.post('/profile/password', async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    const user = await semanticDb('users').where({ id: req.user!.sub }).first();
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
    await semanticDb('users')
      .where({ id: req.user!.sub })
      .update({ password_hash: newHash, updated_at: new Date().toISOString() });

    res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/users/profile/avatar — upload avatar (base64 data URL)
// ---------------------------------------------------------------------------
router.post('/profile/avatar', async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    await semanticDb('users')
      .where({ id: req.user!.sub })
      .update({ avatar_url: avatar ?? null, updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
