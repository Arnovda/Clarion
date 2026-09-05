/**
 * tenantLimits.ts — the caps on what is NOT AI (P0-8).
 *
 * `monthly_token_budget` bounds AI spend and is enforced on every AI path
 * with no bypass. Nothing else was bounded: a "5 seats, 3 sources" customer
 * could add 40 users and 20 connections syncing every minute, and the
 * operator found out on the Azure bill. Three bounds now exist:
 *
 *  - SEATS      — `tenants.seats` caps ACTIVE users (a deactivated user
 *                 frees a seat, which is what "seats" means commercially).
 *  - SOURCES    — `tenants.max_connections` caps connections.
 *  - CADENCE    — no schedule of any kind (source sync, transformation,
 *                 report email, pipeline cron trigger) may fire more often
 *                 than MIN_SCHEDULE_INTERVAL_MINUTES (default 15). Measured
 *                 on the cron's actual firing pattern, not on its text: the
 *                 minimum gap between consecutive runs over a horizon.
 *
 * NULL on a cap means UNLIMITED — the meaning the token budget has carried
 * since it shipped — so operator-managed tenants are unchanged; only the
 * unauthenticated door (self-registration) stamps defaults.
 *
 * Every refusal is a sentence a customer can act on, and it happens BEFORE
 * the expensive step (a connection test, a row insert), so hitting a cap
 * costs nothing.
 */

import type { Knex } from 'knex';
import { CronExpressionParser } from 'cron-parser';
import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'tenantLimits' });

// ---------------------------------------------------------------------------
// Defaults for self-registered tenants (same shape as DEFAULT_MONTHLY_TOKEN_BUDGET)
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULT_SEATS = 5;
const BUILTIN_DEFAULT_MAX_CONNECTIONS = 3;

function envCap(name: string, builtin: number): number | null {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return builtin;
  if (raw === 'unlimited') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) return n;
  log.warn({ name, value: process.env[name] }, `${name} is not a non-negative integer or "unlimited" — using the built-in default`);
  return builtin;
}

/** Seats stamped on a self-registered tenant. Env DEFAULT_SEATS; `unlimited` = NULL. */
export function defaultSeats(): number | null {
  return envCap('DEFAULT_SEATS', BUILTIN_DEFAULT_SEATS);
}

/** Connection cap stamped on a self-registered tenant. Env DEFAULT_MAX_CONNECTIONS. */
export function defaultMaxConnections(): number | null {
  return envCap('DEFAULT_MAX_CONNECTIONS', BUILTIN_DEFAULT_MAX_CONNECTIONS);
}

// ---------------------------------------------------------------------------
// Seats + sources
// ---------------------------------------------------------------------------

export interface CapCheck {
  ok: boolean;
  /** Present when refused — a sentence for the customer. */
  message?: string;
  used: number;
  limit: number | null;
}

async function tenantCaps(tenantId: number): Promise<{ seats: number | null; max_connections: number | null }> {
  // `tenants` carries no RLS — readable on the root pool from any context.
  const row = await semanticDb('tenants').select('seats', 'max_connections').where({ id: tenantId }).first();
  return {
    seats: row?.seats == null ? null : Number(row.seats),
    max_connections: row?.max_connections == null ? null : Number(row.max_connections),
  };
}

/**
 * May this tenant add one more ACTIVE user? `db` is the caller's
 * tenant-scoped handle (reqDb) so the count runs under the same context as
 * the insert that follows; tenant_id is filtered explicitly regardless.
 */
export async function checkSeatCap(db: Knex | Knex.Transaction, tenantId: number): Promise<CapCheck> {
  const { seats } = await tenantCaps(tenantId);
  const row = await db('users').where({ tenant_id: tenantId, is_active: true }).count<{ n: string }>('* as n').first();
  const used = Number(row?.n ?? 0);
  if (seats == null || used < seats) return { ok: true, used, limit: seats };
  return {
    ok: false,
    used,
    limit: seats,
    message: `This workspace is using all ${seats} of its seats. Deactivate a user to free one, or ask us to add seats.`,
  };
}

/** May this tenant add one more connection (source)? Same contract as checkSeatCap. */
export async function checkConnectionCap(db: Knex | Knex.Transaction, tenantId: number): Promise<CapCheck> {
  const { max_connections } = await tenantCaps(tenantId);
  const row = await db('connections').where({ tenant_id: tenantId }).count<{ n: string }>('* as n').first();
  const used = Number(row?.n ?? 0);
  if (max_connections == null || used < max_connections) return { ok: true, used, limit: max_connections };
  return {
    ok: false,
    used,
    limit: max_connections,
    message: `This workspace already has its ${max_connections} source${max_connections === 1 ? '' : 's'}. Remove one, or ask us to raise the limit.`,
  };
}

// ---------------------------------------------------------------------------
// Schedule cadence
// ---------------------------------------------------------------------------

const BUILTIN_MIN_INTERVAL_MINUTES = 15;

/** The floor on how often any schedule may fire. Env MIN_SCHEDULE_INTERVAL_MINUTES (0 disables). */
export function minScheduleIntervalMinutes(): number {
  const raw = (process.env.MIN_SCHEDULE_INTERVAL_MINUTES ?? '').trim();
  if (raw === '') return BUILTIN_MIN_INTERVAL_MINUTES;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  log.warn({ value: raw }, 'MIN_SCHEDULE_INTERVAL_MINUTES is not a non-negative number — using the built-in default');
  return BUILTIN_MIN_INTERVAL_MINUTES;
}

/**
 * The smallest gap, in minutes, between two consecutive firings of a cron
 * expression over its next `horizon` runs. Measured, not parsed: `0 9 * * 1-5`
 * and `*​/10 * * * *` are judged by when they fire, so a clever spelling of
 * "every minute" cannot slip past a text rule. Returns null when the
 * expression does not parse (the caller's own cron validation reports that).
 */
export function minCronGapMinutes(expression: string, timezone = 'UTC', horizon = 60): number | null {
  let it;
  try {
    it = CronExpressionParser.parse(expression, { tz: timezone });
  } catch {
    return null;
  }
  let prev: number | null = null;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < horizon; i++) {
    let next: Date;
    try {
      next = it.next().toDate();
    } catch {
      break; // the expression has no further occurrence
    }
    const ts = next.getTime();
    if (prev != null) min = Math.min(min, (ts - prev) / 60_000);
    prev = ts;
    if (min < 1) break; // already as fast as cron goes
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * Refuse a schedule that fires more often than the floor. Returns the
 * refusal sentence, or null when the cadence is acceptable (or the floor is
 * off, or the expression does not parse — not this check's job).
 */
export function scheduleIntervalError(expression: string, timezone = 'UTC'): string | null {
  const floor = minScheduleIntervalMinutes();
  if (floor <= 0) return null;
  const gap = minCronGapMinutes(expression, timezone);
  if (gap == null || gap >= floor) return null;
  const gapText = gap < 1 ? 'less than a minute' : `${Math.round(gap)} minute${Math.round(gap) === 1 ? '' : 's'}`;
  return `This schedule would run every ${gapText}. Schedules can run at most every ${floor} minutes.`;
}
