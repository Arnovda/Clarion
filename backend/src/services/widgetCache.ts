/**
 * Widget result cache — short-lived in-memory cache for dashboard widget SQL results.
 *
 * Each entry is keyed on (tenantId, sha256(resolvedSql)) with a 5-minute TTL.
 * Explicitly invalidated when new data lands (transformation success, ingestion).
 * This is the server-side complement to the client-side filter cache (Sprint 1.3).
 */

import { createHash } from 'crypto';

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  rows: Record<string, unknown>[];
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

function buildKey(tenantId: number, resolvedSql: string): string {
  const hash = createHash('sha256').update(resolvedSql).digest('hex');
  return `${tenantId}:${hash}`;
}

export function getWidgetCache(tenantId: number, resolvedSql: string): Record<string, unknown>[] | null {
  const k = buildKey(tenantId, resolvedSql);
  const entry = store.get(k);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { store.delete(k); return null; }
  return entry.rows;
}

export function putWidgetCache(tenantId: number, resolvedSql: string, rows: Record<string, unknown>[]): void {
  store.set(buildKey(tenantId, resolvedSql), { rows, expiresAt: Date.now() + TTL_MS });
}

export function invalidateWidgetCache(tenantId: number): void {
  const prefix = `${tenantId}:`;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

export function _widgetCacheSize(): number {
  return store.size;
}
