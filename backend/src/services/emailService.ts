/**
 * Email sender with two provider paths, Azure-native first.
 *
 * Provider precedence (first match wins):
 *
 *   1. **Azure Communication Services (ACS) Email** — preferred. Single
 *      HTTPS POST to the Communication Service's data plane, no SMTP-port
 *      gymnastics. Authentication uses `DefaultAzureCredential`, which:
 *        - In Container Apps with system-assigned Managed Identity (our
 *          prod deploy): picks up the MSI automatically. Zero secrets in
 *          env/Key Vault for email. Best practice.
 *        - Locally with `az login`: uses the developer's Azure CLI
 *          credentials so dev forgot-password works end-to-end without
 *          shipping secrets.
 *        - Falls back to connection string if `ACS_CONNECTION_STRING` is
 *          set (escape hatch when MSI isn't reachable, e.g. running the
 *          backend on bare metal). Same scope as a Key Vault-stored secret.
 *
 *      Triggered when `ACS_ENDPOINT` (recommended) or
 *      `ACS_CONNECTION_STRING` is set.
 *
 *   2. **SMTP via nodemailer** — legacy fallback. Used when no ACS vars are
 *      set but `SMTP_HOST` is. Kept for operators routing through a
 *      corporate Exchange / Postfix / Mailgun-SMTP-relay. Note that Azure
 *      Container Apps blocks port 25 outbound and 587/465 routing is
 *      environment-specific, so ACS is the more reliable path on our
 *      default deployment.
 *
 *   3. **No-op** — neither is set. Logs a warning and returns success.
 *      Used by local dev when neither MSI nor SMTP is wired up. Also a
 *      safety net for misconfigured deploys — the rest of the request
 *      keeps working; ops can spot the missing config in WARN logs.
 *
 * The `from` address is `ACS_SENDER_ADDRESS` (set by Terraform from the
 * Azure-managed email domain), or falls back to `SMTP_FROM`, or a
 * non-routable default that makes misconfiguration obvious in inboxes.
 *
 * Domain verification: Terraform provisions an Azure-managed sender
 * domain (`*.azurecomm.net`) that works immediately, no DNS setup
 * needed. For production polish (better deliverability + branded
 * sender), add a custom domain via terraform later and update
 * ACS_SENDER_ADDRESS.
 */

import { EmailClient } from '@azure/communication-email';
import type { EmailMessage } from '@azure/communication-email';
import { DefaultAzureCredential } from '@azure/identity';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Azure Communication Services Email (preferred)
// ---------------------------------------------------------------------------

let acsClient: EmailClient | null = null;

function getAcsClient(): EmailClient | null {
  if (acsClient) return acsClient;

  const endpoint = process.env.ACS_ENDPOINT;
  const connString = process.env.ACS_CONNECTION_STRING;

  if (endpoint) {
    // Best practice: DefaultAzureCredential picks up MSI in Azure,
    // developer credentials locally. No API key in any config.
    acsClient = new EmailClient(endpoint, new DefaultAzureCredential());
    return acsClient;
  }
  if (connString) {
    // Fallback: connection string (same security shape as DATABASE_URL —
    // stored in Key Vault, referenced as a Container App secret).
    acsClient = new EmailClient(connString);
    return acsClient;
  }
  return null;
}

async function sendViaAcs(opts: EmailOptions, from: string, client: EmailClient): Promise<void> {
  const message: EmailMessage = {
    senderAddress: from,
    content: {
      subject: opts.subject,
      html: opts.html,
      // ACS SDK uses `plainText`; nodemailer uses `text`. Map across.
      ...(opts.text ? { plainText: opts.text } : {}),
    },
    recipients: {
      to: (Array.isArray(opts.to) ? opts.to : [opts.to]).map((address) => ({ address })),
    },
  };

  // beginSend kicks off a long-running operation on the Azure side. The
  // initial response confirms ACS accepted the message; we deliberately
  // do NOT pollUntilDone — that can take 30s+ depending on the
  // recipient's MX server, and transactional flows like password reset
  // don't need synchronous delivery confirmation. ACS will retry
  // delivery internally with its own backoff. If we ever need delivery
  // receipts, surface them via Event Grid subscription, not via this
  // request path.
  try {
    const poller = await client.beginSend(message);
    const state = poller.getOperationState();
    // SDK's OperationState exposes `status` but not the operation id —
    // the id only lands on the EmailSendResult after pollUntilDone, which
    // we deliberately don't await. If we ever need traceable ids, switch
    // to Event Grid receipts instead of polling.
    logger.info(
      { to: opts.to, subject: opts.subject, status: state.status, provider: 'acs' },
      '[email] queued via ACS',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface auth errors specifically — that's the most common
    // misconfiguration class (MSI not granted role, role not propagated
    // yet, wrong endpoint URL).
    logger.error(
      { to: opts.to, subject: opts.subject, err: msg },
      '[email] ACS send failed',
    );
    throw new Error(`ACS email send failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// SMTP (nodemailer — legacy fallback for corporate Exchange routes)
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
  logger.info({ to: opts.to, subject: opts.subject, provider: 'smtp' }, '[email] sent via SMTP');
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
  const acs = getAcsClient();
  const smtpHost = process.env.SMTP_HOST;
  // Sender selection: ACS_SENDER_ADDRESS first (set by Terraform from
  // the Azure-managed email domain), then SMTP_FROM (backward compat
  // for SMTP-only deployments), then a non-routable default that makes
  // misconfiguration visible in inboxes.
  const from = process.env.ACS_SENDER_ADDRESS
    ?? process.env.SMTP_FROM
    ?? 'Clarion <donotreply@invalid-deploy.local>';

  if (acs) {
    return sendViaAcs(opts, from, acs);
  }
  if (smtpHost) {
    return sendViaSmtp(opts, from);
  }

  logger.warn(
    { to: opts.to, subject: opts.subject },
    '[email] No provider configured (ACS_ENDPOINT / ACS_CONNECTION_STRING / SMTP_HOST all unset) — ' +
    'skipping send. Password reset emails and scheduled reports will NOT be delivered until one is configured.',
  );
}
