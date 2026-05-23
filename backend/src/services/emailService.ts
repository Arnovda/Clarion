/**
 * Email sender with two provider paths.
 *
 * Provider precedence (first match wins):
 *
 *   1. **Resend** (preferred) — single HTTPS POST to api.resend.com.
 *      Triggered when `RESEND_API_KEY` is set. Works in Container Apps
 *      without SMTP-port gymnastics and has the best deliverability for
 *      transactional mail at our scale. Free tier covers 3000 emails/mo,
 *      100/day — more than any single Clarion tenant should ever need
 *      for password resets, scheduled reports, etc.
 *
 *   2. **SMTP** (fallback) — nodemailer-driven. Used when RESEND_API_KEY
 *      is absent but `SMTP_HOST` is set. Kept for operators who want to
 *      route through a corporate Exchange / Postfix / Mailgun-SMTP-relay.
 *      Note that Azure Container Apps blocks port 25 outbound and 587/465
 *      routing is environment-specific, so this path is more brittle than
 *      Resend in our default deployment.
 *
 *   3. **No-op** — neither is set. Logs a warning and returns success.
 *      Used by local dev so the forgot-password flow doesn't 500 just
 *      because there's no email infra. Also a safety net for misconfigured
 *      deploys — the rest of the request keeps working; ops can spot the
 *      missing config in the warn logs.
 *
 * The `from` address picks the first defined of: RESEND_FROM, SMTP_FROM,
 * a safe default. Resend requires a verified sender domain for production
 * traffic; for getting unblocked today use `onboarding@resend.dev` (their
 * shared test sender — works without any DNS setup).
 */

import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Resend (HTTPS API)
// ---------------------------------------------------------------------------

const RESEND_API_URL = 'https://api.resend.com/emails';

interface ResendError { name?: string; message?: string; statusCode?: number }
interface ResendResponse { id?: string }

async function sendViaResend(opts: EmailOptions, from: string, apiKey: string): Promise<void> {
  const body = {
    from,
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  };

  const resp = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    // Read the error envelope Resend returns to surface a useful message.
    // Don't include the API key in any log path — only the response body.
    let detail: ResendError = {};
    try { detail = (await resp.json()) as ResendError; } catch { /* non-JSON */ }
    const msg = `Resend ${resp.status}: ${detail.message ?? resp.statusText}`;
    logger.error({ to: opts.to, subject: opts.subject, status: resp.status, detail }, '[email] Resend send failed');
    throw new Error(msg);
  }

  let parsed: ResendResponse = {};
  try { parsed = (await resp.json()) as ResendResponse; } catch { /* non-JSON */ }
  logger.info({ to: opts.to, subject: opts.subject, id: parsed.id, provider: 'resend' }, '[email] sent');
}

// ---------------------------------------------------------------------------
// SMTP (nodemailer fallback)
// ---------------------------------------------------------------------------

let smtpTransporter: nodemailer.Transporter | null = null;

function getSmtpTransporter(): nodemailer.Transporter | null {
  if (smtpTransporter) return smtpTransporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  smtpTransporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return smtpTransporter;
}

async function sendViaSmtp(opts: EmailOptions, from: string): Promise<void> {
  const t = getSmtpTransporter();
  if (!t) throw new Error('SMTP transporter not configured');
  await t.sendMail({ from, ...opts });
  logger.info({ to: opts.to, subject: opts.subject, provider: 'smtp' }, '[email] sent');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  const smtpHost = process.env.SMTP_HOST;
  // Sender selection: Resend-specific override first (different domains
  // are often used for transactional API vs SMTP relay), then SMTP_FROM
  // (kept for backward compat), then a non-routable default that makes
  // it obvious in inboxes that the deploy is misconfigured.
  const from = process.env.RESEND_FROM
    ?? process.env.SMTP_FROM
    ?? 'Clarion <onboarding@resend.dev>';

  if (resendKey) {
    return sendViaResend(opts, from, resendKey);
  }
  if (smtpHost) {
    return sendViaSmtp(opts, from);
  }

  logger.warn(
    { to: opts.to, subject: opts.subject },
    '[email] No provider configured (RESEND_API_KEY / SMTP_HOST both unset) — skipping send. ' +
    'Password reset emails and scheduled reports will NOT be delivered until one is configured.',
  );
}
