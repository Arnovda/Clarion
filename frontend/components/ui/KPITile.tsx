'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './Skeleton';

export interface KPITileProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value?: ReactNode;
  delta?: number;
  deltaUnit?: string;
  subtitle?: ReactNode;
  loading?: boolean;
  error?: ReactNode;
  empty?: boolean;
  emptyLabel?: ReactNode;
}

export function KPITile({
  label,
  value,
  delta,
  deltaUnit = '%',
  subtitle,
  loading,
  error,
  empty,
  emptyLabel = 'No data',
  className,
  ...rest
}: KPITileProps) {
  return (
    <div
      className={cn('bg-raised border border-line rounded-md p-5 shadow-1', className)}
      {...rest}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted mb-2">
        {label}
      </div>

      {loading ? (
        <Skeleton width="60%" height={40} />
      ) : error ? (
        <div className="font-display text-[20px] text-err leading-none">Error</div>
      ) : empty ? (
        <div className="font-display text-[28px] text-muted-2 tracking-[-0.01em] leading-none">
          {emptyLabel}
        </div>
      ) : (
        <div className="font-display font-medium text-[44px] leading-none tracking-[-0.02em] tabular-nums text-ink">
          {value}
        </div>
      )}

      {!loading && !error && !empty && typeof delta === 'number' && (
        <div
          className={cn(
            'font-mono text-[11.5px] mt-1.5',
            delta > 0 ? 'text-ok' : delta < 0 ? 'text-err' : 'text-muted'
          )}
        >
          {delta > 0 ? '↑' : delta < 0 ? '↓' : '·'} {Math.abs(delta)}
          {deltaUnit}
        </div>
      )}

      {!loading && subtitle && (
        <div className="text-[12px] text-muted mt-1">{subtitle}</div>
      )}

      {error && (
        <div className="font-mono text-[10.5px] text-err mt-1.5">{error}</div>
      )}
    </div>
  );
}
