'use client';

/**
 * <ReferenceCard> — right-column card on the two-column /catalog layout.
 *
 * Reference data = "something you analyse BY" (a customer, an item, a journal).
 * Quieter than an AnalyticsCard but still a real card with a short explanation
 * so the user understands what it is before clicking.
 *
 * Visual identity (kept cohesive with AnalyticsCard, intentionally lighter):
 *   - a small source-tinted icon badge + name
 *   - a 2-line plain-English description
 *   - a quiet mono footer with the record count (so you can tell the big
 *     dimension from the tiny lookup)
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

function formatRecords(n: number): string {
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
        'group relative w-full text-left bg-raised border rounded-xl overflow-hidden flex flex-col gap-2 p-4 min-h-[124px]',
        'transition-all duration-150 hover:shadow-md hover:-translate-y-0.5',
        selected
          ? 'border-ocean ring-2 ring-ocean/15'
          : 'border-line hover:border-ocean/40',
      )}
    >
      {/* Header: tinted icon badge + name */}
      <div className="flex items-center gap-2.5">
        <span className={cn(
          'flex items-center justify-center w-7 h-7 rounded-lg shrink-0',
          palette.tintBg, palette.eyebrow,
        )}>
          <Tag className="w-3.5 h-3.5" strokeWidth={2} />
        </span>
        <h4 className={cn(
          'font-medium text-[14px] tracking-[-0.005em] leading-tight truncate transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          {data.name}
        </h4>
      </div>

      {data.description ? (
        <p className="text-[12px] text-muted leading-snug line-clamp-2 flex-1">
          {data.description}
        </p>
      ) : (
        <p className="text-[12px] text-muted-2 italic flex-1">
          No description yet.
        </p>
      )}

      {data.rowCount != null && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2 tabular-nums">
          <span className={cn('w-1 h-1 rounded-full', palette.dot)} aria-hidden />
          {formatRecords(data.rowCount)} records
        </div>
      )}
    </button>
  );
}
