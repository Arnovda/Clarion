/**
 * Signup hardening — the market-readiness assessment's P0-5.
 *
 * Three defects in and around `POST /auth/register`, each pinned here and
 * each reproduced red against the pre-fix handler before the fix shipped:
 *
 *  1. The slug was derived from the company name into a UNIQUE column with
 *     no collision handling — the second customer called "Acme" got a 500
 *     on signup. (Reproduced: the second register below returned 500 with
 *     a raw unique-violation before the retry loop existed.)
 *  2. New tenants got `monthly_token_budget = NULL`, which the budget
 *     enforcement in services/aiBudget.ts reads as UNLIMITED — an
 *     unauthenticated stranger could register and burn AI tokens without
 *     bound. New tenants now get a non-null default
 *     (DEFAULT_MONTHLY_TOKEN_BUDGET, 2,000,000 tokens unless overridden).
 *  3. No email verification existed anywhere. Verification is enforced when
 *     an email provider is configured or REQUIRE_EMAIL_VERIFICATION=1
 *     (the tests below force it); without enforcement — local dev, CI —
 *     registration behaves exactly as before, which the last block pins.
 *
 * NOTE ON THE ENV FLAG: the handlers read REQUIRE_EMAIL_VERIFICATION per
 * request (services/signup.ts), so these tests can flip it around without
 * re-importing the app. Restore it in afterAll — the rest of the suite
 * expects the unenforced default.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { request } from './helpers';
import { semanticDb } from '../db/knex';

const getDb = () => semanticDb;

const ts = Date.now();

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

describe('register: slug collision handling', () => {
  it('two tenants with the same company name both register, with distinct slugs', async () => {
    const agent = await request();
    const companyName = `Acme Collision BV ${ts}`;

    const first = await agent.post('/api/auth/register').send({
      companyName,
      email: `slug-a-${ts}@test.com`,
      password: 'SlugTestPass123!',
      displayName: 'First Acme',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Pre-fix this was a 500: the derived slug collided with the UNIQUE
    // constraint and the raw 23505 escaped as an internal error.
    const second = await agent.post('/api/auth/register').send({
      companyName,
      email: `slug-b-${ts}@test.com`,
      password: 'SlugTestPass123!',
      displayName: 'Second Acme',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const db = getDb();
    const rows = await db('tenants')
      .where('name', companyName)
      .select('slug')
      .orderBy('id', 'asc');
    expect(rows).toHaveLength(2);
    expect(rows[0].slug).not.toBe(rows[1].slug);
  });

  it('a company name with no slug-safe characters still registers', async () => {
    const agent = await request();
    const res = await agent.post('/api/auth/register').send({
      companyName: '!!! *** !!!',
      email: `slug-degenerate-${ts}@test.com`,
      password: 'SlugTestPass123!',
      displayName: 'Symbols Only',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const db = getDb();
    const user = await db('users').where({ email: `slug-degenerate-${ts}@test.com` }).first();
    const tenant = await db('tenants').where({ id: user.tenant_id }).first();
    expect(tenant.slug.length).toBeGreaterThan(0);
  });
});

describe('register: default AI budget', () => {
  it('a new tenant gets a non-null monthly token budget', async () => {
    const agent = await request();
    const email = `budget-default-${ts}@test.com`;
    const res = await agent.post('/api/auth/register').send({
      companyName: `Budget Default Co ${ts}`,
      email,
      password: 'BudgetTestPass123!',
      displayName: 'Budget Admin',
    });
    expect(res.status).toBe(201);

    const db = getDb();
    const user = await db('users').where({ email }).first();
    const tenant = await db('tenants').where({ id: user.tenant_id }).first();
    // Pre-fix this was NULL, which aiBudget reads as unlimited.
    expect(tenant.monthly_token_budget).not.toBeNull();
    expect(Number(tenant.monthly_token_budget)).toBe(2_000_000);
  });

  it('DEFAULT_MONTHLY_TOKEN_BUDGET overrides the built-in default', async () => {
    process.env.DEFAULT_MONTHLY_TOKEN_BUDGET = '500000';
    try {
      const agent = await request();
      const email = `budget-override-${ts}@test.com`;
      const res = await agent.post('/api/auth/register').send({
        companyName: `Budget Override Co ${ts}`,
        email,
        password: 'BudgetTestPass123!',
        displayName: 'Budget Admin',
      });
      expect(res.status).toBe(201);

      const db = getDb();
      const user = await db('users').where({ email }).first();
      const tenant = await db('tenants').where({ id: user.tenant_id }).first();
      expect(Number(tenant.monthly_token_budget)).toBe(500_000);
    } finally {
      delete process.env.DEFAULT_MONTHLY_TOKEN_BUDGET;
    }
  });
});

describe('email verification (enforced)', () => {
  const email = `verify-flow-${ts}@test.com`;
  const password = 'VerifyTestPass123!';

  beforeAll(() => {
    process.env.REQUIRE_EMAIL_VERIFICATION = '1';
  });
  afterAll(() => {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
  });

  it('register issues no tokens and creates the user unverified', async () => {
    const agent = await request();
    const res = await agent.post('/api/auth/register').send({
      companyName: `Verify Flow Co ${ts}`,
      email,
      password,
      displayName: 'Verify Admin',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data?.requiresVerification).toBe(true);
    // No usable credentials before the inbox is proven.
    expect(res.body.data?.token).toBeUndefined();
    expect(res.body.data?.refreshToken).toBeUndefined();

    const db = getDb();
    const user = await db('users').where({ email }).first();
    expect(user.email_verified_at).toBeNull();
    expect(user.email_verification_token).not.toBeNull();
  });

  it('login is refused with a distinct code while unverified', async () => {
    const agent = await request();
    const res = await agent.post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('email_unverified');
  });

  it('a wrong verification token is refused', async () => {
    const agent = await request();
    const res = await agent.post('/api/auth/verify-email').send({
      email,
      token: 'not-the-token-'.padEnd(64, 'x'),
    });
    expect(res.status).toBe(400);
  });

  it('the emailed token verifies the address, after which login works', async () => {
    // The raw token only ever exists inside the sent email; plant a known
    // one directly so the test does not have to intercept the message.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const db = getDb();
    await db('users').where({ email }).update({
      email_verification_token: sha256(rawToken),
      email_verification_expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const agent = await request();
    const verify = await agent.post('/api/auth/verify-email').send({ email, token: rawToken });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);

    const user = await db('users').where({ email }).first();
    expect(user.email_verified_at).not.toBeNull();
    expect(user.email_verification_token).toBeNull();

    const login = await agent.post('/api/auth/login').send({ email, password });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.data?.token).toBeTruthy();
  });

  it('an expired token is refused', async () => {
    const expEmail = `verify-expired-${ts}@test.com`;
    const agent = await request();
    const reg = await agent.post('/api/auth/register').send({
      companyName: `Verify Expired Co ${ts}`,
      email: expEmail,
      password,
      displayName: 'Expired Admin',
    });
    expect(reg.status).toBe(201);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const db = getDb();
    await db('users').where({ email: expEmail }).update({
      email_verification_token: sha256(rawToken),
      email_verification_expires: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await agent.post('/api/auth/verify-email').send({ email: expEmail, token: rawToken });
    expect(res.status).toBe(400);
  });

  it('resend-verification answers generically for unknown addresses (no enumeration)', async () => {
    const agent = await request();
    const res = await agent.post('/api/auth/resend-verification').send({
      email: `nobody-${ts}@test.com`,
    });
    expect(res.status).toBe(200);
  });

  it('resend-verification rotates the stored token for an unverified user', async () => {
    const rvEmail = `verify-resend-${ts}@test.com`;
    const agent = await request();
    const reg = await agent.post('/api/auth/register').send({
      companyName: `Verify Resend Co ${ts}`,
      email: rvEmail,
      password,
      displayName: 'Resend Admin',
    });
    expect(reg.status).toBe(201);

    const db = getDb();
    const before = await db('users').where({ email: rvEmail }).first();
    const res = await agent.post('/api/auth/resend-verification').send({ email: rvEmail });
    expect(res.status).toBe(200);
    const after = await db('users').where({ email: rvEmail }).first();
    expect(after.email_verification_token).not.toBe(before.email_verification_token);
  });

  it('redeeming a password-reset token also proves the inbox (invite flow safety)', async () => {
    // Invited users are created unverified with an emailed reset link;
    // completing it must count as verification or every invitee would be
    // locked out of login under enforcement.
    const inviteEmail = `verify-invite-${ts}@test.com`;
    const agent = await request();
    const reg = await agent.post('/api/auth/register').send({
      companyName: `Verify Invite Co ${ts}`,
      email: inviteEmail,
      password,
      displayName: 'Invite Admin',
    });
    expect(reg.status).toBe(201);

    const rawReset = crypto.randomBytes(32).toString('hex');
    const db = getDb();
    await db('users').where({ email: inviteEmail }).update({
      password_reset_token: sha256(rawReset),
      password_reset_expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const reset = await agent.post('/api/auth/reset-password').send({
      email: inviteEmail,
      token: rawReset,
      password: 'AfterResetPass123!',
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);

    const user = await db('users').where({ email: inviteEmail }).first();
    expect(user.email_verified_at).not.toBeNull();

    const login = await agent.post('/api/auth/login').send({
      email: inviteEmail,
      password: 'AfterResetPass123!',
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
  });
});

describe('email verification (not enforced — the CI/dev default)', () => {
  it('register still returns tokens, and the user is created pre-verified', async () => {
    // No provider is configured in this environment and
    // REQUIRE_EMAIL_VERIFICATION is unset, so enforcement is off — locking
    // every login behind an email nobody can send would be a worse failure
    // than no verification. The user is marked verified at creation so a
    // later enforcement flip cannot retroactively lock them out.
    const email = `no-enforce-${ts}@test.com`;
    const agent = await request();
    const res = await agent.post('/api/auth/register').send({
      companyName: `No Enforce Co ${ts}`,
      email,
      password: 'NoEnforcePass123!',
      displayName: 'Unenforced Admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.data?.token).toBeTruthy();

    const db = getDb();
    const user = await db('users').where({ email }).first();
    expect(user.email_verified_at).not.toBeNull();
  });
});
