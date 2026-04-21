/**
 * Thin nodemailer wrapper.
 *
 * Reads SMTP config from environment. If SMTP_HOST is not configured,
 * all send calls are no-ops (logs to console) so local dev works without
 * an SMTP server.
 */

import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  if (!host) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<void> {
  const t = getTransporter();
  const from = process.env.SMTP_FROM ?? 'DataBridge <noreply@databridge.local>';

  if (!t) {
    logger.warn({ to: opts.to, subject: opts.subject }, '[email] SMTP not configured — skipping send');
    return;
  }

  await t.sendMail({ from, ...opts });
  logger.info({ to: opts.to, subject: opts.subject }, '[email] sent');
}
