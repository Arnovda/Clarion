/**
 * Unified date formatting for the whole app.
 *
 * Before: random mix of `nl-BE`, `en-GB`, and raw `toLocaleString()` across 40+ files.
 * After: import from here so one change updates the whole product.
 *
 * LOCALE-AWARE since P2-1: the i18n provider calls `setDatesLocale` when the
 * interface language resolves or changes, and every formatter below follows.
 * A module-level variable rather than React context ON PURPOSE — these
 * functions are called from plain modules (chart themes, download names),
 * not just components, and the provider is the single writer. The relative
 * words live here, not in the dictionaries: this module predates them, is
 * the one place dates are formatted, and its strings are a closed set.
 */

let LOCALE = 'en-GB';
let RELATIVE: 'en' | 'nl' = 'en';

export function setDatesLocale(locale: 'en' | 'nl'): void {
  RELATIVE = locale;
  LOCALE = locale === 'nl' ? 'nl-BE' : 'en-GB';
}

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

  if (RELATIVE === 'nl') {
    if (m < 1) return 'zonet';
    if (m < 60) return `${m} min geleden`;
    if (h < 24) return `${h} u geleden`;
    if (dy < 7) return `${dy} d geleden`;
    return formatDate(d);
  }
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (dy < 7) return `${dy}d ago`;
  return formatDate(d);
}

/**
 * Long-form relative for prose: "just now", "6 minutes ago", "3 hours ago",
 * "2 days ago", then falls back to a date. The trust line on a topic page is
 * a sentence a business user reads — "6m ago" is a log line, not a sentence.
 */
export function formatRelativeLong(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const t = d.getTime();
  if (isNaN(t)) return '—';

  const delta = Date.now() - t;
  const m = Math.floor(delta / 60_000);
  const h = Math.floor(delta / 3_600_000);
  const dy = Math.floor(delta / 86_400_000);

  if (RELATIVE === 'nl') {
    const nlPlural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many} geleden`;
    if (m < 1) return 'zonet';
    if (m < 60) return nlPlural(m, 'minuut', 'minuten');
    if (h < 24) return nlPlural(h, 'uur', 'uur');
    if (dy < 7) return nlPlural(dy, 'dag', 'dagen');
    return `op ${formatDate(d)}`;
  }
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (m < 1) return 'just now';
  if (m < 60) return plural(m, 'minute');
  if (h < 24) return plural(h, 'hour');
  if (dy < 7) return plural(dy, 'day');
  return `on ${formatDate(d)}`;
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

  // "nu", "5m", "3u", "2d" — the compact units differ only on hours (h→u).
  if (m < 1) return RELATIVE === 'nl' ? 'nu' : 'now';
  if (m < 60) return `${m}m`;
  if (h < 24) return RELATIVE === 'nl' ? `${h}u` : `${h}h`;
  if (dy < 7) return `${dy}d`;
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}
