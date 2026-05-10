'use client';

/**
 * <ReferenceCard> — right-column card on the new two-column /catalog.
 *
 * Visual identity: smaller and quieter than an AnalyticsCard. Reads
 * "this is something to analyse BY" (a customer, an item, a journal).
 *
 * The card surfaces the answers an end-user actually needs to decide
 * "is this what I'm looking for?" without opening the detail panel:
 *
 *   - name + a short description
 *   - row count (am I picking the right table — the one with the data)
 *   - "Used in N products" / "Unused" — is this hooked up to anything?
 *     surfaces orphaned dims so curators can investigate
 *   - last refreshed (is this stale data?)
 *
 * Deliberately omitted (lives in the detail panel instead):
 *   - column count — irrelevant at the discovery stage
 *   - quality scores — too noisy without context
 *   - status pills — reference data tends to "just exist"
 */

import { Tag, AlertCircle } from 'lucide-react';
import { formatRelative } from '@/lib/dates';
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

export default function ReferenceCard({
  data, selected, onSelect, palette,
}: Props) {
  const refreshed = data.lastRefreshedAt
    ? formatRelative(data.lastRefreshedAt)
    : null;
  const usedCount = data.usedIn.length;
  const isOrphan = usedCount === 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full text-left bg-raised border rounded-md overflow-hidden',
        'transition-all duration-150',
        'hover:shadow-sm hover:border-ocean/40',
        selected
          ? 'border-ocean ring-2 ring-ocean/20'
          : 'border-line',
      )}
      title={isOrphan ? 'Not currently used by any analytics product' : undefined}
    >
      {/* Thinner accent than analytics — visual hierarchy: analytics gets
          the louder voice, reference is supporting cast. */}
      <div className={cn('absolute left-0 top-0 bottom-0 w-[2px]', palette.edge, 'opacity-70')} aria-hidden />

      <div className="pl-3 pr-3 py-3">
        {/* Title row with optional orphan flag. */}
        <div className="flex items-baseline gap-2 mb-0.5">
          <Tag className={cn('w-3 h-3 mt-0.5 shrink-0', palette.eyebrow)} strokeWidth={2} />
          <h4 className={cn(
            'font-medium text-[14px] tracking-[-0.005em] leading-tight transition-colors flex-1 min-w-0 truncate',
            selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
          )}>
            {data.name}
          </h4>
          {isOrphan && (
            <AlertCircle
              className="w-3 h-3 shrink-0 text-warn/70"
              aria-label="Not used by any analytics product"
              strokeWidth={2}
            />
          )}
        </div>

        {data.description && (
          <p className="text-[12px] text-ink-2 leading-snug line-clamp-1 mb-2 pl-5">
            {data.description}
          </p>
        )}

        <div className="flex items-center gap-2 text-[10.5px] font-mono text-muted-2 tabular-nums pl-5">
          {data.rowCount != null && (
            <>
              <span>{data.rowCount.toLocaleString('en-GB')} rows</span>
              <span className="text-muted-2/40">·</span>
            </>
          )}
          {usedCount > 0 ? (
            <span title={data.usedIn.map((u) => u.name).join(', ')}>
              Used in {usedCount} {usedCount === 1 ? 'product' : 'products'}
            </span>
          ) : (
            <span className="text-warn/80">Unused</span>
          )}
          {refreshed && (
            <span className="ml-auto text-muted-2/80">{refreshed}</span>
          )}
        </div>
      </div>
    </button>
  );
}
