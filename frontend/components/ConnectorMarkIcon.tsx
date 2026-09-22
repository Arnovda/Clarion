'use client';

/**
 * A source's own mark, on a wash of its own colour — the ONE renderer for
 * `lib/connectorIcons.tsx` outside the Sources page's connector grid.
 *
 * The catalog tree, the source panel header and the assistant's scope chip
 * all need "which system is this?" answered before the label is read, and a
 * `Database` glyph answers it for nobody. A connector without a mark (a
 * legacy direct-database connection, an unknown id) falls back to that
 * glyph so the row never renders empty.
 */
import { Database } from 'lucide-react';
import { connectorMark } from '@/lib/connectorIcons';
import { cn } from '@/lib/cn';

type Size = 'xs' | 'sm' | 'md' | 'lg';

const TILE: Record<Size, string> = {
  xs: 'w-4 h-4 rounded',
  sm: 'w-5 h-5 rounded',
  md: 'w-8 h-8 rounded-lg',
  lg: 'w-12 h-12 rounded-xl',
};
const GLYPH: Record<Size, string> = {
  xs: 'w-2.5 h-2.5',
  sm: 'w-3 h-3',
  md: 'w-4 h-4',
  lg: 'w-6 h-6',
};

export default function ConnectorMarkIcon({
  connectorType, size = 'sm', className, title,
}: {
  /** `connections.connector_type`, falling back to `connections.type`. */
  connectorType: string | null | undefined;
  size?: Size;
  className?: string;
  title?: string;
}) {
  const mark = connectorType ? connectorMark(connectorType) : null;
  if (!mark) {
    return (
      <span
        className={cn(TILE[size], 'inline-flex items-center justify-center shrink-0 border border-line bg-softer text-muted-2', className)}
        title={title}
        aria-hidden={title ? undefined : true}
      >
        <Database className={GLYPH[size]} strokeWidth={1.5} />
      </span>
    );
  }
  return (
    <span
      className={cn(TILE[size], 'inline-flex items-center justify-center shrink-0 border', className)}
      style={{ backgroundColor: `${mark.color}14`, borderColor: `${mark.color}2E` }}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      <svg viewBox={mark.viewBox} className={GLYPH[size]} fill={mark.color} aria-hidden="true">
        {mark.art}
      </svg>
    </span>
  );
}
