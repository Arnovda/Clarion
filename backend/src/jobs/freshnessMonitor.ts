/**
 * freshnessMonitor.ts — "this source has not synced in N hours" (7-1).
 *
 * The failure notifications in SyncOrchestrator cover a sync that RAN and
 * failed. This covers the sync that never ran: a schedule that was not
 * registered (the P0-2 class — every loader read zero rows for a month), a
 * worker that died, a queue nobody drains. Nothing in the run history says
 * anything in that case; only the CALENDAR does.
 *
 * Every FRESHNESS_CHECK_MS (default 1 h) the scheduler-owning process reads
 * every enabled sync schedule and asks whether data has landed within the
 * window that schedule itself implies: TWICE its LONGEST gap plus half an
 * hour, never less than FRESHNESS_MIN_STALE_MINUTES (default 120). The
 * longest gap, not the shortest: `0 9 * * 1-5` legitimately goes 72 h over a
 * weekend. A stale source is logged with the LOAD-BEARING string
 * 'source stale' (the .ops/alerts `clarion-stale-source` rule) and every
 * tenant admin is notified — once per 24 h per source while it stays stale,
 * not once per sweep.
 */

import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { tenantQuery } from '../services/tenantQuery';
import { notifyAdmins } from '../services/notificationService';
import { cronGapStats } from '../services/tenantLimits';
import { listEnabledConnectionSyncSchedules } from './connectionSyncScheduler';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'freshnessMonitor' });

const RENOTIFY_MS = 24 * 60 * 60 * 1000;

function checkIntervalMs(): number {
  const n = Number(process.env.FRESHNESS_CHECK_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : 60 * 60 * 1000;
}

export function minStaleMinutes(): number {
  const n = Number(process.env.FRESHNESS_MIN_STALE_MINUTES);
  return Number.isFinite(n) && n >= 1 ? n : 120;
}

/**
 * The window a schedule allows before its source counts as stale, in
 * minutes: 2 × the schedule's longest gap + 30, floored at
 * FRESHNESS_MIN_STALE_MINUTES. An unparseable cron gets the floor × 12 (a
 * day) — better a late warning than a false one.
 */
export function allowedStaleMinutes(cron: string, timezone: string): number {
  const stats = cronGapStats(cron, timezone);
  const floor = minStaleMinutes();
  if (!stats) return floor * 12;
  return Math.max(floor, Math.round(2 * stats.max + 30));
}

/**
 * Pure: is a source stale at `now`? `lastLandedAt` is the last time data
 * landed (connections.last_synced_at — set on success AND partial);
 * `sinceAt` is when the schedule was created, the clock for a source that
 * has never synced at all.
 */
export function isStale(args: {
  lastLandedAt: Date | string | null; sinceAt: Date | string; cron: string; timezone: string; now?: Date;
}): { stale: boolean; allowedMinutes: number; ageMinutes: number } {
  const now = args.now ?? new Date();
  const allowedMinutes = allowedStaleMinutes(args.cron, args.timezone);
  const ref = args.lastLandedAt ? new Date(args.lastLandedAt) : new Date(args.sinceAt);
  const ageMinutes = Math.round((now.getTime() - ref.getTime()) / 60_000);
  return { stale: ageMinutes > allowedMinutes, allowedMinutes, ageMinutes };
}

export interface StaleSource {
  tenantId: number;
  connectionId: number;
  connectionName: string;
  ageMinutes: number;
  allowedMinutes: number;
  lastSyncStatus: string | null;
}

const lastNotified = new Map<number, number>(); // connectionId → epoch ms

/** One sweep. Returns what it found; notifies unless `notify` is false. */
export async function sweepFreshness(
  db: Knex = semanticDb,
  opts: { now?: Date; notify?: boolean } = {},
): Promise<StaleSource[]> {
  const now = opts.now ?? new Date();
  const schedules = await listEnabledConnectionSyncSchedules(db);
  const stale: StaleSource[] = [];
  for (const s of schedules) {
    try {
      const conn = await tenantQuery(Number(s.tenant_id), (trx) => trx('connections')
        .select('id', 'name', 'last_synced_at', 'last_sync_status')
        .where({ id: s.connection_id, tenant_id: s.tenant_id })
        .first());
      if (!conn) continue;
      const verdict = isStale({
        lastLandedAt: conn.last_synced_at ?? null,
        sinceAt: (s as { created_at?: string }).created_at ?? now,
        cron: s.cron_expression, timezone: s.timezone ?? 'UTC', now,
      });
      if (!verdict.stale) {
        lastNotified.delete(Number(conn.id));
        continue;
      }
      const item: StaleSource = {
        tenantId: Number(s.tenant_id), connectionId: Number(conn.id), connectionName: String(conn.name ?? conn.id),
        ageMinutes: verdict.ageMinutes, allowedMinutes: verdict.allowedMinutes, lastSyncStatus: conn.last_sync_status ?? null,
      };
      stale.push(item);
      // LOAD-BEARING STRING: the .ops/alerts `clarion-stale-source` rule
      // matches 'source stale' — reword it and the alert goes silently blind.
      log.warn({ tenantId: item.tenantId, connectionId: item.connectionId, ageMinutes: item.ageMinutes, allowedMinutes: item.allowedMinutes }, 'source stale');
      if (opts.notify !== false) {
        const last = lastNotified.get(item.connectionId) ?? 0;
        if (now.getTime() - last >= RENOTIFY_MS) {
          lastNotified.set(item.connectionId, now.getTime());
          const hours = Math.round(item.ageMinutes / 60);
          await notifyAdmins(item.tenantId, 'source_stale', `${item.connectionName}: no new data for ${hours} hours`, {
            message: `Its schedule should have delivered data within ${Math.round(item.allowedMinutes / 60)} hours. Check the source and its schedule.`,
            entityType: 'connection', entityId: item.connectionId, link: '/sources',
          }).catch((err) => log.warn({ err, connectionId: item.connectionId }, 'stale-source notification failed'));
        }
      }
    } catch (err) {
      // One unreadable tenant must not stop the sweep for the rest.
      log.warn({ err, tenantId: s.tenant_id, connectionId: s.connection_id }, 'freshness check failed for one schedule');
    }
  }
  return stale;
}

let timer: NodeJS.Timeout | null = null;

/** Start the hourly sweep. Scheduler-owning process only (same ownership as the reapers). */
export function startFreshnessMonitor(): void {
  if (timer) return;
  const interval = checkIntervalMs();
  timer = setInterval(() => {
    sweepFreshness().catch((err) => log.debug({ err }, 'freshness sweep failed'));
  }, interval);
  timer.unref?.();
  log.info({ intervalMs: interval, minStaleMinutes: minStaleMinutes() }, 'freshness monitor started');
}

export function stopFreshnessMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests: forget who was notified. */
export function _resetFreshnessState(): void {
  lastNotified.clear();
}
