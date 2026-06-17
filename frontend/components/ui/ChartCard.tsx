'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './Skeleton';

export const CHART_COLORS = [
  'var(--c1)',
  'var(--c2)',
  'var(--c3)',
  'var(--c4)',
  'var(--c5)',
  'var(--c6)',
] as const;

export const CHART_AXIS_PROPS = {
  tick: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    fill: 'var(--muted)',
  },
  stroke: 'var(--line)',
  tickLine: false,
} as const;

export const CHART_GRID_PROPS = {
  stroke: 'var(--line)',
  strokeDasharray: '2 3',
  strokeOpacity: 0.6,
} as const;

export const CHART_TOOLTIP_STYLE = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  color: 'var(--ink)',
  boxShadow: 'var(--shadow-2)',
} as const;

export interface ChartCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  height?: number;
  loading?: boolean;
  error?: ReactNode;
  empty?: boolean;
  emptyLabel?: ReactNode;
}

export function ChartCard({
  title,
  subtitle,
  actions,
  height = 260,
  loading,
  error,
  empty,
  emptyLabel = 'No data in this range.',
  className,
  children,
  ...rest
}: ChartCardProps) {
  return (
    <div
      className={cn('bg-raised border border-line rounded-md p-5 shadow-1', className)}
      {...rest}
    >
      <div className="flex justify-between items-baseline mb-4 gap-4">
        <div className="min-w-0">
          <div className="font-sans font-semibold text-[14px] text-ink truncate">{title}</div>
          {subtitle && (
            <div className="font-mono text-[10.5px] text-muted tracking-[0.04em] mt-0.5 uppercase">
              {subtitle}
            </div>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      <div style={{ height }}>
        {loading ? (
          <Skeleton className="w-full h-full" rounded="sm" />
        ) : error ? (
          <div className="h-full border-l-2 border-l-err bg-err-soft/30 pl-4 pr-3 py-3 rounded-sm">
            <div className="font-display text-[16px] text-ink leading-[1.4]">
              This chart couldn’t render.
            </div>
            <div className="font-mono text-[10.5px] text-err mt-1">{error}</div>
          </div>
        ) : empty ? (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="font-display text-[18px] text-muted-2 tracking-[-0.01em]">
              {emptyLabel}
            </div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
