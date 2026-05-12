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

import { Database } from 'lucide-react';
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
      {/* Left colored accent bar. */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-1', palette.edge)} aria-hidden />

      <div className="pl-5 pr-5 py-5">
        {showStatus && (
          <div className="absolute top-3 right-3">
            <StatusPill status={data.status} />
          </div>
        )}

        {/* Tiny "ANALYTICS" eyebrow above the name. */}
        <div className={cn('flex items-center gap-1.5 mb-1', palette.eyebrow)}>
          <Database className="w-3 h-3" strokeWidth={2} />
          <span className="text-[10px] font-mono uppercase tracking-[0.14em]">
            Analytics
          </span>
        </div>

        <h3 className={cn(
          'font-display text-[22px] tracking-[-0.01em] leading-tight mb-2 transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          {data.name}
        </h3>

        {data.description ? (
          <p className="text-[13.5px] text-ink-2 leading-relaxed line-clamp-2 mb-5">
            {data.description}
          </p>
        ) : (
          <p className="text-[13.5px] text-muted italic mb-5">
            No description yet.
          </p>
        )}

        {/* Three stat boxes. The first one uses the source palette tint so the
            primary stat (metrics) gets visual emphasis; facts/tables stay neutral. */}
        <div className="flex items-stretch gap-2">
          <StatBox
            value={data.metricCount}
            label="metrics"
            highlighted
            palette={palette}
          />
          <StatBox
            value={data.factCount}
            label={data.factCount === 1 ? 'fact' : 'facts'}
          />
          <StatBox
            value={data.tableCount}
            label={data.tableCount === 1 ? 'table' : 'tables'}
          />
        </div>
      </div>
    </button>
  );
}

function StatBox({
  value, label, highlighted, palette,
}: {
  value: number;
  label: string;
  highlighted?: boolean;
  palette?: SourcePalette;
}) {
  return (
    <div className={cn(
      'flex-1 min-w-0 px-3 py-2.5 rounded-md border text-center',
      highlighted && palette
        ? cn(palette.tintBg, 'border-line')
        : 'bg-softer/60 border-line',
    )}>
      <div className={cn(
        'font-display text-[22px] tracking-[-0.01em] leading-none mb-1 tabular-nums',
        highlighted && palette ? palette.eyebrow : 'text-ink',
      )}>
        {value}
      </div>
      <div className="text-[9.5px] font-mono uppercase tracking-[0.12em] text-muted-2">
        {label}
      </div>
    </div>
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
