'use client';

/**
 * <AnalyticsCard> — left-column card on the two-column /catalog layout.
 *
 * An analytics product is a "subject you can analyse" (Finance, Sales…). It's
 * the hero object of the catalog, so it carries real visual weight:
 *
 *   ▌[glyph]  Finance                          ← accent rail + domain glyph
 *             General ledger transactions, bank statement lines…
 *   ─────────────────────────────────────────
 *   ▦ 6 metrics                  ● Updated 4 Jun   ← hairline-divided footer
 *
 * The colour comes from the source palette (every ExactOnline product is
 * emerald), the GLYPH comes from the product name (Finance→Landmark,
 * Sales→Receipt) — so products from one source are cohesive in colour yet
 * individually recognisable. The metric count is a confident coloured stat,
 * not a buried pill: "6 metrics" vs "1 metric" should read at a glance.
 */

import { BarChart3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRelativeShort } from '@/lib/dates';
import { iconForAnalytics } from './entityIcons';
import type { SourcePalette } from './sourcePalette';

export interface AnalyticsCardData {
  productId: number;
  name: string;
  description: string | null;
  status: string;
  metricCount: number;
  factCount: number;
  tableCount: number;
  lastRefreshedAt: string | null;
}

interface Props {
  data: AnalyticsCardData;
  selected: boolean;
  onSelect: () => void;
  palette: SourcePalette;
  showCuratorSignals?: boolean;
}

export default function AnalyticsCard({
  data, selected, onSelect, palette, showCuratorSignals,
}: Props) {
  // Off-normal status only — steady-state ("approved" / "success") is the
  // default and doesn't need chrome.
  const showStatus = showCuratorSignals
    && data.status
    && !['approved', 'success'].includes(data.status);

  const refreshedLabel = data.lastRefreshedAt ? formatRelativeShort(data.lastRefreshedAt) : null;
  const Glyph = iconForAnalytics(data.name);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full text-left bg-raised border rounded-xl overflow-hidden',
        'pl-5 pr-4 py-4 transition-all duration-150',
        'hover:shadow-md hover:-translate-y-0.5',
        selected
          ? 'border-ocean ring-2 ring-ocean/15'
          : 'border-line hover:border-ocean/40',
      )}
    >
      {/* Full-height colour accent rail — carries the source identity with
          conviction instead of a 1px hairline. */}
      <span className={cn('absolute left-0 inset-y-0 w-1.5', palette.edge)} aria-hidden />

      {showStatus && (
        <div className="absolute top-3 right-3">
          <StatusPill status={data.status} />
        </div>
      )}

      {/* Header: filled glyph tile + serif name. */}
      <div className="flex items-center gap-3 mb-2">
        <span className={cn(
          'flex items-center justify-center w-9 h-9 rounded-lg shrink-0 border',
          palette.tintStrong, palette.ring, palette.eyebrow,
        )}>
          <Glyph className="w-[18px] h-[18px]" strokeWidth={1.75} />
        </span>
        <h3 className={cn(
          'font-display text-[20px] tracking-[-0.01em] leading-tight truncate transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          {data.name}
        </h3>
      </div>

      {data.description ? (
        <p className="text-[13px] text-ink-2 leading-relaxed line-clamp-2 mb-3.5">
          {data.description}
        </p>
      ) : (
        <p className="text-[13px] text-muted italic mb-3.5">
          No description yet.
        </p>
      )}

      {/* Hairline-divided footer: the metric count is the punchline (coloured,
          confident), freshness sits quietly on the right. */}
      <div className="flex items-center justify-between pt-3 border-t border-line/70 text-[11.5px]">
        <span className={cn('inline-flex items-center gap-1.5 font-medium', palette.eyebrow)}>
          <BarChart3 className="w-3.5 h-3.5" strokeWidth={2} />
          <span className="tabular-nums">{data.metricCount}</span>
          {data.metricCount === 1 ? 'metric' : 'metrics'}
        </span>
        {refreshedLabel && (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <span className={cn('w-1.5 h-1.5 rounded-full', palette.dot)} aria-hidden />
            Updated {refreshedLabel}
          </span>
        )}
      </div>
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  const colour = status === 'draft'   ? 'bg-warn-soft text-warn border-warn/30'
              : status === 'error'    ? 'bg-err-soft text-err border-err/30'
              : status === 'pending'  ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-soft text-muted-2 border-line';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn('inline-block px-2 py-0.5 text-[10px] uppercase tracking-wide font-mono rounded border', colour)}>
      {label}
    </span>
  );
}
