/**
 * P0-3 of the 2026-09-05 market-readiness assessment (v2): "Send invite"
 * created the user, minted a 7-day reset link, and then logged the link only
 * under NODE_ENV=development and returned it only outside production. There
 * was no sendEmail call anywhere in the handler — in production the admin
 * saw "Sending…" and the colleague received nothing, ever. The first
 * customer's second user could not arrive.
 *
 * The email service is mocked here so the test asserts the CALL (recipient,
 * subject, the reset link inside the body) without a provider; the
 * signup-hardening suite covers the real provider selection.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const sendEmail = vi.fn(async () => undefined);
vi.mock('../services/emailService', () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));

import { request, registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';

let adminToken: string;

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'inviter@invite.test', companyName: 'InviteCo' });
  adminToken = admin.token;
});

afterAll(async () => { await closeTestDb(); });
beforeEach(() => { sendEmail.mockReset(); sendEmail.mockResolvedValue(undefined); });

async function invite(email: string) {
  return (await request())
    .post('/api/users/invite')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, displayName: 'New Colleague', role: 'analyst' });
}

describe('POST /api/users/invite delivers the invitation', () => {
  it('emails the invitee a reset link and reports that it did', async () => {
    const res = await invite('colleague@invite.test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.emailed).toBe(true);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const opts = sendEmail.mock.calls[0][0] as { to: string; subject: string; html: string; text?: string };
    expect(opts.to).toBe('colleague@invite.test');
    expect(opts.subject.toLowerCase()).toContain('invited');
    expect(opts.html).toMatch(/\/reset-password\?token=[0-9a-f]{64}&email=colleague%40invite\.test/);
    expect(opts.text ?? '').toMatch(/\/reset-password\?token=/);
    // The inviter's workspace is named so the recipient knows who this is from.
    expect(opts.html).toContain('InviteCo');

    // The link the email carries is the one the row can redeem.
    const row = await getTestDb()('users').where({ email: 'colleague@invite.test' }).first();
    expect(row.password_reset_token).toBeTruthy();
    expect(new Date(row.password_reset_expires).getTime()).toBeGreaterThan(Date.now());
  });

  it('still creates the user and says the email did NOT go out when sending fails', async () => {
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const res = await invite('unlucky@invite.test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.emailed).toBe(false);
    const row = await getTestDb()('users').where({ email: 'unlucky@invite.test' }).first();
    expect(row).toBeTruthy();
  });

  it('never returns the raw invite link in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await invite('prod@invite.test');
      expect(res.status).toBe(200);
      expect(res.body.invite_url).toBeUndefined();
      expect(sendEmail).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
