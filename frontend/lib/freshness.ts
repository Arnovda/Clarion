/**
 * Freshness utilities — relative time formatting and status classification.
 */

export type FreshnessStatus = 'fresh' | 'stale' | 'old' | 'unknown';

/**
 * Returns a human-friendly relative time string, e.g. "just now", "2h ago", "3d ago".
 */
export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return 'never';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return 'never';

  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/**
 * Classifies a date into a freshness status:
 * - fresh: within the last 24 hours
 * - stale: 1–7 days old
 * - old: older than 7 days
 * - unknown: null or invalid
 */
export function getFreshnessStatus(date: string | Date | null | undefined): FreshnessStatus {
  if (!date) return 'unknown';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return 'unknown';

  const hoursAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60);
  if (hoursAgo <= 24) return 'fresh';
  if (hoursAgo <= 24 * 7) return 'stale';
  return 'old';
}

/**
 * Returns a Tailwind color class for a freshness status dot or text.
 */
export function getFreshnessColor(status: FreshnessStatus): string {
  switch (status) {
    case 'fresh':   return 'bg-emerald-400';
    case 'stale':   return 'bg-amber-400';
    case 'old':     return 'bg-red-400';
    case 'unknown': return 'bg-white/20';
  }
}

/**
 * Returns a Tailwind text color class for freshness status.
 */
export function getFreshnessTextColor(status: FreshnessStatus): string {
  switch (status) {
    case 'fresh':   return 'text-emerald-400/70';
    case 'stale':   return 'text-amber-400/70';
    case 'old':     return 'text-red-400/70';
    case 'unknown': return 'text-white/30';
  }
}

/**
 * Compute overall freshness status from an array of dates.
 * Returns the worst status among all dates.
 */
export function getOverallFreshnessStatus(dates: (string | Date | null | undefined)[]): FreshnessStatus {
  if (dates.length === 0) return 'unknown';
  const statuses = dates.map(getFreshnessStatus);
  if (statuses.every(s => s === 'unknown')) return 'unknown';
  if (statuses.some(s => s === 'old')) return 'old';
  if (statuses.some(s => s === 'stale')) return 'stale';
  if (statuses.some(s => s === 'unknown')) return 'stale'; // unknown items count as stale
  return 'fresh';
}
