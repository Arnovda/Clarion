/**
 * Signup policy — the decisions `POST /auth/register` used to leave open.
 *
 * Three of the market-readiness assessment's P0-5 hazards live behind an
 * unauthenticated registration form: an unlimited default AI budget, a
 * unique slug derived with no collision handling, and no email
 * verification. This module holds the policy; routes/auth.ts applies it.
 *
 * Everything env-driven here is read PER CALL, never frozen at import —
 * the same trade `platformOperatorEmails()` documents in config.ts: these
 * are the controls tests must be able to flip, and a value captured at
 * import time cannot be varied by a test.
 */

import crypto from 'crypto';
import { config } from '../config';
import { sendEmail } from './emailService';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'signup' });

// ---------------------------------------------------------------------------
// Email verification policy
// ---------------------------------------------------------------------------

/** Is any email provider configured? Mirrors emailService's provider
 *  precedence — ACS first, SMTP fallback. */
export function emailProviderConfigured(): boolean {
  return Boolean(
    process.env.ACS_ENDPOINT || process.env.ACS_CONNECTION_STRING || process.env.SMTP_HOST,
  );
}

/**
 * Must a new registration prove its email address before it can log in?
 *
 * REQUIRE_EMAIL_VERIFICATION=1/true forces it on, =0/false forces it off;
 * unset, it follows whether an email provider is configured. That default
 * is the deliberate part: enforcement without a way to SEND the
 * verification email locks every new user out permanently (emailService
 * no-ops without a provider), which is a worse failure than an unverified
 * signup — and it is what keeps local dev and CI working unchanged. In
 * production ACS is configured, so enforcement is on there without any
 * extra setting. When enforcement is off, users are created PRE-VERIFIED
 * so a later flip to enforced cannot retroactively lock them out.
 */
export function emailVerificationRequired(): boolean {
  const flag = (process.env.REQUIRE_EMAIL_VERIFICATION ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return emailProviderConfigured();
}

/** Verification links are valid this long. Generous on purpose — a signup
 *  finished the next morning should not need a resend. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface VerificationToken {
  /** Goes into the emailed link, exists nowhere else. */
  raw: string;
  /** Goes into users.email_verification_token. */
  hash: string;
  /** Goes into users.email_verification_expires. */
  expiresAt: Date;
}

export function issueVerificationToken(): VerificationToken {
  const raw = crypto.randomBytes(32).toString('hex');
  return {
    raw,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
  };
}

export function hashVerificationToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Send the verification email. Best-effort like every auth email — a
 * delivery failure must not 500 the registration (the user can hit
 * resend); it is logged, and in development the URL is logged too so the
 * flow works without SMTP. NODE_ENV === 'development' exactly, not
 * "not production": a verification URL is a credential and staging logs
 * get searched (same rule as forgot-password's dev log).
 */
export async function sendVerificationEmail(
  email: string,
  displayName: string | null,
  rawToken: string,
): Promise<void> {
  const verifyUrl = `${config.appUrl}/verify-email?token=${rawToken}&email=${encodeURIComponent(email)}`;
  try {
    await sendEmail({
      to: email,
      subject: 'Confirm your email for Clarion',
      text:
        `Hi ${displayName ?? 'there'},\n\n` +
        `Confirm this email address to activate your Clarion workspace.\n\n` +
        `Click the link below (valid for 24 hours):\n${verifyUrl}\n\n` +
        `If you didn't create a Clarion workspace, you can safely ignore this email.\n\n` +
        `— Clarion`,
      html:
        `<p>Hi ${displayName ?? 'there'},</p>` +
        `<p>Confirm this email address to activate your Clarion workspace.</p>` +
        `<p><a href="${verifyUrl}" style="background:#0d4a6f;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;display:inline-block">Confirm email</a></p>` +
        `<p style="color:#666;font-size:12px">Or paste this link in your browser (valid for 24 hours):<br>${verifyUrl}</p>` +
        `<p style="color:#999;font-size:12px">If you didn't create a Clarion workspace, you can safely ignore this email.</p>`,
    });
  } catch (err) {
    log.error({ err, email }, 'verification email send failed');
  }
  if (process.env.NODE_ENV === 'development') {
    log.info(`[auth-dev] Email verification URL for ${email}: ${verifyUrl}`);
  }
}

// ---------------------------------------------------------------------------
// Default AI budget
// ---------------------------------------------------------------------------

/** Built-in default: 2M tokens/month ≈ single-digit euros of worst-case
 *  spend — enough to evaluate the product seriously, not enough to matter
 *  if a stranger registers. Operators raise real customers' budgets on
 *  the tenant row. */
const BUILTIN_DEFAULT_TOKEN_BUDGET = 2_000_000;

/**
 * Monthly token budget stamped onto a self-registered tenant.
 *
 * DEFAULT_MONTHLY_TOKEN_BUDGET: a non-negative integer, or the literal
 * `unlimited` to restore the old NULL behaviour (documented, deliberate,
 * and visible in the env — never again the silent default). An
 * unparseable value falls back to the built-in default with a warning:
 * failing open to unlimited on a typo would resurrect the exact hazard
 * this exists to close.
 */
export function defaultMonthlyTokenBudget(): number | null {
  const rawValue = (process.env.DEFAULT_MONTHLY_TOKEN_BUDGET ?? '').trim().toLowerCase();
  if (rawValue === '') return BUILTIN_DEFAULT_TOKEN_BUDGET;
  if (rawValue === 'unlimited') return null;
  const n = Number(rawValue);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) return n;
  log.warn(
    { value: process.env.DEFAULT_MONTHLY_TOKEN_BUDGET },
    'DEFAULT_MONTHLY_TOKEN_BUDGET is not a non-negative integer or "unlimited" — using the built-in default',
  );
  return BUILTIN_DEFAULT_TOKEN_BUDGET;
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

/** The slug rule register has always used, plus a floor for names with no
 *  slug-safe characters at all ("!!!" must not become the empty string —
 *  two such companies would collide on '' and the URL identifier would be
 *  blank everywhere it renders). */
export function deriveSlugBase(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'workspace';
}

/**
 * Candidate slugs in the order register should try them: the bare name,
 * then numbered variants, then random suffixes as the last resort (two
 * requests racing on "acme-2" both fall through to a random that cannot
 * realistically collide). The caller inserts and retries on the UNIQUE
 * violation rather than checking first — check-then-insert is the TOCTOU
 * shape the sync-run dedupe already had to abandon.
 */
export function slugCandidates(companyName: string, attempts = 8): string[] {
  const base = deriveSlugBase(companyName);
  const list = [base];
  for (let i = 2; i < attempts; i += 1) list.push(`${base}-${i}`);
  list.push(`${base}-${crypto.randomBytes(3).toString('hex')}`);
  return list;
}
