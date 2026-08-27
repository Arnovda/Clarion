'use client';

/**
 * <ReferenceCard> — right-column card on the two-column /catalog layout.
 *
 * Reference data = "something you analyse BY" (a customer, an item, a journal).
 * These are the *lenses*, not the subjects — so the whole right column wears a
 * faint source-tinted wash (palette.tintBg) that visually groups them and sets
 * them apart from the white AnalyticsCards on the left. That contrast is the
 * point: white = what you measure, tinted = how you slice it.
 *
 *   [glyph] Account
 *           Conformed customer and supplier account…
 *           ● 27 records
 *
 * Each gets its own glyph (Date→Calendar, Item→Package) so the column doesn't
 * read as eight identical tags, and the record count is promoted so the big
 * dimension is obvious next to the tiny lookup.
 */

import { cn } from '@/lib/cn';
import { iconForReference } from './entityIcons';
import type { SourcePalette } from './sourcePalette';

export interface ReferenceCardData {
  productId: number;
  tableId: number;
  name: string;
  /** Technical table name (e.g. dim_item) — used by /catalog?table= deep links. */
  tableName?: string;
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
  const Glyph = iconForReference(data.name);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative w-full text-left border rounded-xl overflow-hidden flex flex-col gap-2 p-3.5 min-h-[104px]',
        'transition-all duration-150 hover:shadow-md hover:-translate-y-0.5',
        selected
          // Selected pops to white + ocean ring so it reads as "active".
          ? 'bg-raised border-ocean ring-2 ring-ocean/15'
          // At rest: faint source wash so the column groups as one family.
          : cn(palette.tintBg, palette.ring, 'hover:bg-raised hover:border-ocean/40'),
      )}
    >
      {/* Header: glyph tile + name */}
      <div className="flex items-center gap-2.5">
        <span className={cn(
          'flex items-center justify-center w-7 h-7 rounded-lg shrink-0 border bg-raised/70',
          palette.ring, palette.eyebrow,
        )}>
          <Glyph className="w-[15px] h-[15px]" strokeWidth={1.9} />
        </span>
        <h4 className={cn(
          'font-medium text-[14px] tracking-[-0.005em] leading-tight truncate transition-colors',
          selected ? 'text-ocean' : 'text-ink group-hover:text-ocean',
        )}>
          {data.name}
        </h4>
      </div>

      {data.description ? (
        <p className="text-[12px] text-ink-2/85 leading-snug line-clamp-2 flex-1">
          {data.description}
        </p>
      ) : (
        <p className="text-[12px] text-muted-2 italic flex-1">
          No description yet.
        </p>
      )}

      {data.rowCount != null && (
        <div className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-muted-2 tabular-nums">
          <span className={cn('w-1.5 h-1.5 rounded-full', palette.dot)} aria-hidden />
          <span className={cn('font-semibold', palette.eyebrow)}>{formatRecords(data.rowCount)}</span>
          records
        </div>
      )}
    </button>
  );
}
