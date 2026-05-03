'use client';

/**
 * <SourceBadge> — single visual primitive for "this product comes from <source>".
 *
 * Used everywhere a data product appears in a list: /catalog tree, /products
 * cards, /dashboards picker, /query selector, /notebooks schema explorer.
 * Consistency across pages comes from sharing this component, not from
 * copy-pasting styles into each surface.
 *
 * Three visual states:
 *   1. Single source             → [Database icon] Exact Online
 *   2. Multi-source              → [Database icon] Exact Online +1
 *   3. Source deleted / unknown  → faded "Source deleted" pill
 *
 * The +N chip is hover-tooltipped with the other source names so a user can
 * always recover the full list without an extra click.
 */

import { Database, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface ProductSource {
  id: number | null;
  name: string | null;
  connectorType: string | null;
  multiSource: boolean;
  sourceDeleted?: boolean;
  otherSources?: Array<{
    id: number;
    name: string;
    connectorType: string | null;
  }>;
}

interface Props {
  source: ProductSource | null | undefined;
  /** Compact = inline badge for cards. Default = small block badge for headers. */
  size?: 'compact' | 'default';
  className?: string;
}

export default function SourceBadge({ source, size = 'default', className }: Props) {
  // ── Source deleted (rare but explicit) ─────────────────────────────────
  if (source?.sourceDeleted) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded border border-line bg-softer text-muted-2',
          size === 'compact' ? 'px-1.5 py-0.5 text-[10.5px]' : 'px-2 py-0.5 text-[11px]',
          'font-mono uppercase tracking-[0.06em]',
          className,
        )}
        title="The source connection for this product has been deleted."
      >
        <AlertTriangle className="w-3 h-3" strokeWidth={1.75} />
        Source deleted
      </span>
    );
  }

  // ── Unassigned (no primary source resolvable) ──────────────────────────
  if (!source || !source.name) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded border border-line bg-softer text-muted-2',
          size === 'compact' ? 'px-1.5 py-0.5 text-[10.5px]' : 'px-2 py-0.5 text-[11px]',
          'font-mono uppercase tracking-[0.06em]',
          className,
        )}
      >
        Unassigned
      </span>
    );
  }

  // ── Normal case: source name + (optional +N) ───────────────────────────
  const otherNames = source.otherSources?.map((s) => s.name).filter(Boolean) ?? [];
  const tooltip = otherNames.length
    ? `Also draws from: ${otherNames.join(', ')}`
    : source.connectorType
      ? `Source: ${source.connectorType}`
      : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border border-line bg-ocean-softer text-ocean',
        size === 'compact' ? 'px-1.5 py-0.5 text-[10.5px]' : 'px-2 py-0.5 text-[11.5px]',
        'font-medium',
        className,
      )}
      title={tooltip}
    >
      <Database className={cn(size === 'compact' ? 'w-2.5 h-2.5' : 'w-3 h-3')} strokeWidth={1.75} />
      <span className="truncate max-w-[180px]">{source.name}</span>
      {source.multiSource && otherNames.length > 0 && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-ocean text-white tabular-nums font-mono',
            size === 'compact' ? 'min-w-[14px] h-[14px] text-[9px] px-1' : 'min-w-[16px] h-[16px] text-[10px] px-1',
          )}
        >
          +{otherNames.length}
        </span>
      )}
    </span>
  );
}

// ─── Helpers shared by callsites ────────────────────────────────────────────

/**
 * The grouping key for a product. Stable string so it round-trips through
 * URL params, localStorage, etc. Multi-source products get their own
 * synthetic group rather than appearing under multiple headers — that's
 * less noisy and matches the badge's "+N" framing.
 */
export function productSourceGroupKey(source: ProductSource | null | undefined): string {
  if (!source) return 'unassigned';
  if (source.sourceDeleted) return 'deleted';
  if (source.multiSource) return 'multi';
  if (source.id != null) return `conn:${source.id}`;
  return 'unassigned';
}

/** Display label for a grouping key. */
export function productSourceGroupLabel(
  key: string,
  source: ProductSource | null | undefined,
): string {
  if (key === 'multi') return 'Multi-source';
  if (key === 'deleted') return 'Source deleted';
  if (key === 'unassigned') return 'Unassigned';
  return source?.name ?? 'Unknown';
}
