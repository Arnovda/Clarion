'use client';

/**
 * <AnalyticsCard> — left-column card on the two-column /catalog layout.
 *
 * Visual identity:
 *   - Tinted top-left accent (palette.edge, vertical 4px bar)
 *   - Small uppercase mono `ANALYTICS` eyebrow with database icon
 *   - Large product name (display font)
 *   - 2-line description
 *   - Three large stat boxes side-by-side: metrics / facts / tables
 *
 * The big stat boxes are the punchline. They tell the user at a glance
 * how rich this data product is — "12 metrics" is meaningfully different
 * from "1 metric" and the visual weight should reflect that.
 */

import { Database, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRelativeShort } from '@/lib/dates';
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

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full text-left bg-raised border rounded-lg overflow-hidden',
        'transition-all duration-150',
        'hover:shadow-md hover:-translate-y-0.5',
        selected
          ? 'border-ocean ring-2 ring-ocean/20'
          : 'border-line hover:border-ocean/40',
      )}
    >
      {/* Left colored accent bar. */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-1', palette.edge)} aria-hidden />

      <div className="pl-4 pr-4 py-3.5">
        {showStatus && (
          <div className="absolute top-3 right-3">
            <StatusPill status={data.status} />
          </div>
        )}

        {/* No per-card eyebrow — the column is already titled "Analytics".
            A small product icon sits inline with the name instead. */}
        <h3 className={cn(
          'font-display text-[18px] tracking-[-0.01em] leading-tight mb-1.5 flex items-center gap-2 transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          <Database className={cn('w-3.5 h-3.5 shrink-0', palette.eyebrow)} strokeWidth={1.75} />
          {data.name}
        </h3>

        {data.description ? (
          <p className="text-[13px] text-ink-2 leading-relaxed line-clamp-2 mb-3">
            {data.description}
          </p>
        ) : (
          <p className="text-[13px] text-muted italic mb-3">
            No description yet.
          </p>
        )}

        {/* Calm meta line — what you can measure here + when it last refreshed.
            Business-friendly: no "facts / tables" warehouse jargon on the
            consumer card (that detail lives in the panel for curators). */}
        <div className="flex items-center gap-2.5 text-[11.5px]">
          <span className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-medium',
            palette.tintBg, 'border-line', palette.eyebrow,
          )}>
            <BarChart3 className="w-3.5 h-3.5" strokeWidth={2} />
            {data.metricCount} {data.metricCount === 1 ? 'metric' : 'metrics'}
          </span>
          {refreshedLabel && (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className={cn('w-1.5 h-1.5 rounded-full', palette.dot)} aria-hidden />
              Updated {refreshedLabel}
            </span>
          )}
        </div>
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
