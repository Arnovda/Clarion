/**
 * Unified date formatting for the whole app.
 *
 * Before: random mix of `nl-BE`, `en-GB`, and raw `toLocaleString()` across 40+ files.
 * After: import from here so one change updates the whole product.
 */

const LOCALE = 'en-GB';

/** "5 Apr 2026" */
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "5 Apr 2026, 14:32" */
export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(LOCALE, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** "just now", "5m ago", "3h ago", "2d ago", then falls back to formatDate */
export function formatRelative(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const t = d.getTime();
  if (isNaN(t)) return '—';

  const delta = Date.now() - t;
  const m = Math.floor(delta / 60_000);
  const h = Math.floor(delta / 3_600_000);
  const dy = Math.floor(delta / 86_400_000);

  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (dy < 7) return `${dy}d ago`;
  return formatDate(d);
}

/** Short relative for tight UI spots: "now", "5m", "3h", "2d", "5 Apr" */
export function formatRelativeShort(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const t = d.getTime();
  if (isNaN(t)) return '—';

  const delta = Date.now() - t;
  const m = Math.floor(delta / 60_000);
  const h = Math.floor(delta / 3_600_000);
  const dy = Math.floor(delta / 86_400_000);

  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (h < 24) return `${h}h`;
  if (dy < 7) return `${dy}d`;
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}
