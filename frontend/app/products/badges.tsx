'use client';

/**
 * Tiny leaf components: status dots, role badges, spinner.
 * No state, no hooks.
 */

import { Loader2 } from 'lucide-react';
import { productIconEmoji } from './helpers';

/**
 * AI-generated line-icon for a data product, with emoji fallback.
 * The SVG arrives from the backend as plain markup; it has been validated
 * server-side (see sanitizeProductIconSvg in AIService.ts) so it's safe to
 * inject. Strokes inherit `currentColor` — wrap with text-ocean / text-on-surface
 * to theme the icon.
 */
export function ProductIcon({
  product,
  name,
  className = 'w-6 h-6 text-on-surface',
}: {
  product?: { name: string; icon_svg?: string | null } | null;
  name?: string;
  className?: string;
}) {
  const svg = product?.icon_svg;
  if (svg) {
    return (
      <span
        className={`inline-flex items-center justify-center ${className}`}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  const fallbackName = product?.name ?? name ?? '';
  return <span className={`inline-flex items-center justify-center ${className}`} aria-hidden="true">{productIconEmoji(fallbackName)}</span>;
}

export function StatusDot({ status, title }: { status: string; title?: string }) {
  const color: Record<string, string> = {
    draft:     'bg-line-strong',
    designing: 'bg-ocean animate-pulse',
    approved:  'bg-ok',
    running:   'bg-warn animate-pulse',
    success:   'bg-ok',
    error:     'bg-err',
    pending:   'bg-line-strong',
  };
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${color[status] ?? 'bg-line-strong'}`}
      title={title ?? status}
    />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft:     'bg-softer text-muted',
    designing: 'bg-ocean-softer text-ocean',
    approved:  'bg-ok-soft text-ok',
    running:   'bg-warn-soft text-warn',
    success:   'bg-ok-soft text-ok',
    error:     'bg-err-soft text-err',
  };
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${colors[status] ?? 'bg-softer text-muted'}`}>
      {status}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const config: Record<string, { bg: string; label: string; hint: string }> = {
    fact:      { bg: 'bg-ai-soft text-ai',           label: 'Measures', hint: 'Measures — the numbers you analyse (sales, quantities, amounts), one row per event or transaction.' },
    dimension: { bg: 'bg-ocean-softer text-ocean',   label: 'Lookup',   hint: 'Lookup — the context you slice by (customers, products, dates). One row per thing.' },
    bridge:    { bg: 'bg-warn-soft text-warn',       label: 'Bridge',   hint: 'Bridge — links a measure to many lookups (e.g. an order with several tags).' },
    junk:      { bg: 'bg-softer text-muted',         label: 'Flags',    hint: 'Flags — a tidy bundle of yes/no and status fields kept out of the main tables.' },
  };
  const c = config[role] ?? { bg: 'bg-softer text-muted', label: role, hint: role };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${c.bg}`} title={c.hint}>{c.label}</span>;
}

export function ColumnRoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  const config: Record<string, { color: string; hint: string }> = {
    surrogate_key:        { color: 'bg-warn-soft text-warn',     hint: 'Surrogate key — the table’s own internal ID, generated here.' },
    natural_key:          { color: 'bg-warn-soft text-warn',     hint: 'Natural key — the real-world ID from the source (e.g. invoice number).' },
    foreign_key:          { color: 'bg-ai-soft text-ai',         hint: 'Foreign key — points at a row in a lookup table.' },
    measure:              { color: 'bg-ok-soft text-ok',         hint: 'Measure — a number you can sum or average.' },
    attribute:            { color: 'bg-ocean-softer text-ocean', hint: 'Attribute — descriptive text you filter or group by.' },
    degenerate_dimension: { color: 'bg-softer text-muted',       hint: 'Degenerate dimension — an ID kept on the measure table with no lookup of its own.' },
  };
  const c = config[role] ?? { color: 'bg-softer text-muted', hint: role.replace(/_/g, ' ') };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${c.color}`} title={c.hint}>
      {role.replace(/_/g, ' ')}
    </span>
  );
}

export function Spinner({ className = 'w-4 h-4 text-ocean' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} strokeWidth={2} />;
}
