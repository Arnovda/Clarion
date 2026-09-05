/**
 * invites.ts — create a user and send them their invitation (P0-3), as ONE
 * function two doors share: the tenant admin's `POST /users/invite` and the
 * operator's `POST /admin/tenants/:id/users/invite` (6-5). Before this the
 * handler lived inline in routes/users.ts and the operator had no way to
 * invite a customer's first colleague without a support session.
 *
 * `db` is a handle already scoped to `tenantId` (the request transaction,
 * or a tenantQuery transaction) — the insert must run under that tenant's
 * RLS context. tenant_id is still written explicitly.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import { config } from '../config';
import { hashPassword } from '../middleware/auth';
import { sendEmail } from '../services/emailService';
import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'invites' });

export type InviteRole = 'admin' | 'analyst' | 'viewer';

export interface InviteResult {
  kind: 'invited';
  user: { id: number; email: string; display_name: string; role: string; is_active: boolean; created_at: string };
  inviteUrl: string;
  emailed: boolean;
}

export interface InviteRefusal {
  kind: 'refused';
  status: 400 | 409;
  error: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function inviteUser(
  db: Knex | Knex.Transaction,
  input: { tenantId: number; email: string; displayName: string; role: InviteRole; inviter: string },
): Promise<InviteResult | InviteRefusal> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!email || !email.includes('@')) return { kind: 'refused', status: 400, error: 'Valid email is required' };
  if (!displayName) return { kind: 'refused', status: 400, error: 'Display name is required' };
  if (!['admin', 'analyst', 'viewer'].includes(input.role)) {
    return { kind: 'refused', status: 400, error: 'Role must be admin, analyst, or viewer' };
  }

  const existing = await db('users').where({ email, tenant_id: input.tenantId }).first();
  if (existing) return { kind: 'refused', status: 409, error: 'A user with this email already exists' };

  // A temporary password nobody knows, and a 7-day reset token that IS the
  // invitation. Redeeming it also marks the address verified (routes/auth.ts),
  // so an invitee never meets the email-verification gate.
  const tempPassword = crypto.randomBytes(16).toString('hex');
  const passwordHash = await hashPassword(tempPassword);
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
  const resetExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [user] = await db('users')
    .insert({
      tenant_id: input.tenantId,
      email,
      display_name: displayName,
      password_hash: passwordHash,
      role: input.role,
      is_active: true,
      password_reset_token: resetTokenHash,
      password_reset_expires: resetExpires.toISOString(),
    })
    .returning(['id', 'email', 'display_name', 'role', 'is_active', 'created_at']);

  const inviteUrl = `${config.appUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
  if (process.env.NODE_ENV === 'development') {
    log.info(`[invite-dev] Invite URL for ${email}: ${inviteUrl}`);
  }

  // `tenants` has no RLS; the name is what tells the recipient who this is from.
  const tenant = await semanticDb('tenants').where({ id: input.tenantId }).first('name');
  const workspace = String(tenant?.name ?? 'Clarion');
  let emailed = false;
  try {
    await sendEmail({
      to: email,
      subject: `You're invited to ${workspace} on Clarion`,
      text:
        `Hi ${displayName},\n\n` +
        `${input.inviter} invited you to the ${workspace} workspace on Clarion as ${input.role}.\n\n` +
        `Set your password with the link below (valid for 7 days):\n${inviteUrl}\n\n` +
        `If you weren't expecting this, you can ignore this email.\n\n— Clarion`,
      html:
        `<p>Hi ${escapeHtml(displayName)},</p>` +
        `<p><b>${escapeHtml(input.inviter)}</b> invited you to the <b>${escapeHtml(workspace)}</b> workspace on Clarion as <b>${input.role}</b>.</p>` +
        `<p><a href="${inviteUrl}" style="background:#0d4a6f;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;display:inline-block">Set your password</a></p>` +
        `<p style="color:#666;font-size:12px">Or paste this link in your browser (valid for 7 days):<br>${inviteUrl}</p>` +
        `<p style="color:#999;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`,
    });
    emailed = true;
  } catch (err) {
    // The account exists either way; the caller tells the admin the email
    // did not go out instead of a silent "Sending…" that ends.
    log.error({ err, tenantId: input.tenantId }, 'invite email send failed');
  }

  return { kind: 'invited', user: user as InviteResult['user'], inviteUrl, emailed };
}
