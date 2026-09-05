/**
 * announcements.ts — what every customer is told about an incident (6-4).
 *
 * Redis is down for forty minutes and there was no way to tell five tenants.
 * An announcement is an OPERATOR record about all tenants — the same shape
 * as a feature flag: no tenant_id, no RLS, the route gate is the only access
 * control, read on the root pool.
 *
 * Reads are cached in module memory for 20 s (the feature-flag TTL, for the
 * same reason: a banner appearing 20 s late is fine, a fresh query on every
 * shell mount across every replica is not). A write clears the local cache
 * so the operator sees their own change at once; other replicas catch up
 * within the TTL.
 */

import { semanticDb } from '../db/knex';
import { logger } from '../utils/logger';

const log = logger.child({ component: 'announcements' });

export type AnnouncementLevel = 'info' | 'warning' | 'critical';

export interface Announcement {
  id: number;
  message: string;
  level: AnnouncementLevel;
  startsAt: string;
  endsAt: string | null;
  createdBy: string;
  createdAt: string;
}

const CACHE_TTL_MS = 20_000;
let cache: { at: number; active: Announcement[] } | null = null;

function shape(r: Record<string, unknown>): Announcement {
  return {
    id: Number(r.id),
    message: String(r.message),
    level: String(r.level) as AnnouncementLevel,
    startsAt: new Date(r.starts_at as string).toISOString(),
    endsAt: r.ends_at == null ? null : new Date(r.ends_at as string).toISOString(),
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** The announcements every signed-in user should see right now. */
export async function activeAnnouncements(now = new Date()): Promise<Announcement[]> {
  if (cache && now.getTime() - cache.at < CACHE_TTL_MS) return cache.active;
  try {
    const rows = await semanticDb('announcements')
      .where('starts_at', '<=', now)
      .andWhere((q) => q.whereNull('ends_at').orWhere('ends_at', '>', now))
      .orderBy('created_at', 'desc')
      .limit(5);
    const active = rows.map(shape);
    cache = { at: now.getTime(), active };
    return active;
  } catch (err) {
    // An unreadable table (migration not yet run, DB blip) is "no banner",
    // not a broken shell — and it is NOT cached, so the next read retries.
    log.warn({ err }, 'could not read announcements');
    return [];
  }
}

/** Every announcement, newest first (the operator's list — ended ones too). */
export async function listAnnouncements(limit = 50): Promise<Announcement[]> {
  const rows = await semanticDb('announcements').orderBy('created_at', 'desc').limit(limit);
  return rows.map(shape);
}

export async function createAnnouncement(input: {
  message: string; level: AnnouncementLevel; startsAt?: Date | null; endsAt?: Date | null; createdBy: string;
}): Promise<Announcement> {
  const [row] = await semanticDb('announcements')
    .insert({
      message: input.message,
      level: input.level,
      starts_at: input.startsAt ?? semanticDb.fn.now(),
      ends_at: input.endsAt ?? null,
      created_by: input.createdBy,
    })
    .returning('*');
  cache = null;
  return shape(row as Record<string, unknown>);
}

export async function updateAnnouncement(
  id: number,
  patch: { message?: string; level?: AnnouncementLevel; endsAt?: Date | null },
): Promise<Announcement | null> {
  const updates: Record<string, unknown> = { updated_at: semanticDb.fn.now() };
  if (patch.message !== undefined) updates.message = patch.message;
  if (patch.level !== undefined) updates.level = patch.level;
  if (patch.endsAt !== undefined) updates.ends_at = patch.endsAt;
  const [row] = await semanticDb('announcements').where({ id }).update(updates).returning('*');
  cache = null;
  return row ? shape(row as Record<string, unknown>) : null;
}

/** End an announcement now (it stays in the list as history). */
export async function endAnnouncement(id: number): Promise<Announcement | null> {
  return updateAnnouncement(id, { endsAt: new Date() });
}

export async function deleteAnnouncement(id: number): Promise<boolean> {
  const n = await semanticDb('announcements').where({ id }).delete();
  cache = null;
  return n > 0;
}

/** Tests: drop the module cache. */
export function _resetAnnouncementCache(): void {
  cache = null;
}
