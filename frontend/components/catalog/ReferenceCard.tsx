'use client';

/**
 * <ReferenceCard> — right-column card on the two-column /catalog layout.
 *
 * Quieter than an AnalyticsCard. Reads "this is something to analyse BY"
 * (a customer, an item, a journal). The user picks one of these to slice
 * the analytics product alongside.
 *
 * Surfaced:
 *   - tag icon + name (palette-tinted)
 *   - short description (2 lines)
 *   - row count (am I picking the dim with my data — the one with 27 vs 2.9k rows)
 *
 * Deliberately omitted:
 *   - "Used in N products" / "Unused" — too curator-y for a discovery surface
 *   - "last refreshed" timestamp — implied by the parent source's freshness
 *   - relative-row-count bar — user explicitly didn't want it
 *   - status pills, orphan warnings — reference data tends to "just exist"
 *
 * The data shape still carries `usedIn` + `lastRefreshedAt` for the detail
 * panel; we just don't render them on the card.
 */

import { Tag } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { SourcePalette } from './sourcePalette';

export interface ReferenceCardData {
  productId: number;
  tableId: number;
  name: string;
  description: string | null;
  rowCount: number | null;
  lastRefreshedAt: string | null;
  usedIn: Array<{ productId: number; name: string }>;
}

interface Props {
  data: ReferenceCardData;
  selected: boolean;
  onSelect: () => void;
  palette: SourcePalette;
}

function formatRowCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toLocaleString('en-GB');
}

export default function ReferenceCard({
  data, selected, onSelect, palette,
}: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full text-left bg-raised border rounded-md overflow-hidden flex flex-col',
        'transition-all duration-150 min-h-[120px]',
        'hover:shadow-sm hover:-translate-y-0.5',
        selected
          ? 'border-ocean ring-2 ring-ocean/20'
          : 'border-line hover:border-ocean/40',
      )}
    >
      <div className="px-4 py-3 flex-1 flex flex-col">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Tag className={cn('w-3.5 h-3.5 shrink-0', palette.eyebrow)} strokeWidth={2} />
          <h4 className={cn(
            'font-medium text-[14px] tracking-[-0.005em] leading-tight transition-colors flex-1 min-w-0 truncate',
            selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
          )}>
            {data.name}
          </h4>
        </div>

        {data.description ? (
          <p className="text-[12px] text-ink-2 leading-snug line-clamp-2 mb-3 min-h-[2.2em]">
            {data.description}
          </p>
        ) : (
          <p className="text-[12px] text-muted italic mb-3 min-h-[2.2em]">
            No description yet.
          </p>
        )}

        {data.rowCount != null && (
          <div className="mt-auto pt-2 border-t border-line/60">
            <span className="text-[11px] font-mono text-muted-2 tabular-nums">
              {formatRowCount(data.rowCount)} rows
            </span>
          </div>
        )}
      </div>
    </button>
  );
}
