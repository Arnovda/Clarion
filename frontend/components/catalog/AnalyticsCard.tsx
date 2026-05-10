'use client';

/**
 * <AnalyticsCard> — left-column card on the new two-column /catalog.
 *
 * Visual identity: bigger than a reference card, ocean-tinted accent,
 * metric count emphasised. Reads "this is something you analyse."
 * Mirrors the existing ProductCard styling for visual continuity but
 * trims the source-name eyebrow (the per-source band header already
 * says it).
 */

import { Database } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
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
  const refreshed = data.lastRefreshedAt
    ? formatRelative(data.lastRefreshedAt)
    : 'Not refreshed yet';

  // Off-normal status only — steady-state ("approved" / "success") is the
  // default and doesn't need chrome.
  const showStatus = showCuratorSignals
    && data.status
    && !['approved', 'success'].includes(data.status);

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
      <div className={cn('absolute left-0 top-0 bottom-0 w-1', palette.edge)} aria-hidden />

      <div className="pl-5 pr-5 py-5">
        {showStatus && (
          <div className="absolute top-3 right-3">
            <StatusPill status={data.status} />
          </div>
        )}

        <h3 className={cn(
          'font-display text-[19px] tracking-[-0.01em] leading-tight mb-1.5 transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          {data.name}
        </h3>

        {data.description ? (
          <p className="text-[13px] text-ink-2 leading-relaxed line-clamp-2 mb-4 min-h-[2.5em]">
            {data.description}
          </p>
        ) : (
          <p className="text-[13px] text-muted italic mb-4 min-h-[2.5em]">
            No description yet.
          </p>
        )}

        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-2 tabular-nums pt-3 border-t border-line">
          <span className={cn('font-medium', data.metricCount > 0 && palette.eyebrow)}>
            {data.metricCount} {data.metricCount === 1 ? 'metric' : 'metrics'}
          </span>
          <span className="text-muted-2/40">·</span>
          <span className="inline-flex items-center gap-1">
            <Database className="w-3 h-3" strokeWidth={2} />
            {data.factCount} {data.factCount === 1 ? 'fact' : 'facts'}
          </span>
          <span className="text-muted-2/40">·</span>
          <span>
            {data.tableCount} {data.tableCount === 1 ? 'table' : 'tables'}
          </span>
          <span className="ml-auto">{refreshed}</span>
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
