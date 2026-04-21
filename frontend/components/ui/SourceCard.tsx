'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Badge, BadgeVariant } from './Badge';
import { Skeleton } from './Skeleton';

export type SourceStatus = 'live' | 'stale' | 'error' | 'idle';

export interface SourceCardProps extends HTMLAttributes<HTMLDivElement> {
  name: ReactNode;
  abbr: ReactNode;
  rows?: number | string;
  syncedAt?: ReactNode;
  status?: SourceStatus;
  loading?: boolean;
  error?: ReactNode;
}

const STATUS_META: Record<SourceStatus, { variant: BadgeVariant; label: string }> = {
  live:  { variant: 'ok',   label: 'Live'   },
  stale: { variant: 'warn', label: 'Stale'  },
  error: { variant: 'err',  label: 'Error'  },
  idle:  { variant: 'neu',  label: 'Idle'   },
};

function fmtRows(v: number | string | undefined) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v.toLocaleString('en-US');
}

export function SourceCard({
  name,
  abbr,
  rows,
  syncedAt,
  status = 'idle',
  loading,
  error,
  className,
  ...rest
}: SourceCardProps) {
  if (loading) {
    return (
      <div className={cn('bg-raised border border-line rounded-md p-4 flex items-center gap-3', className)}>
        <Skeleton width={40} height={40} rounded="sm" />
        <div className="flex-1">
          <Skeleton width="55%" height={14} />
          <Skeleton className="mt-1.5" width="40%" height={10} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          'bg-raised border border-line border-l-2 border-l-err rounded-md p-4',
          className
        )}
        {...rest}
      >
        <div className="font-sans font-medium text-[13.5px] text-ink mb-1">{name}</div>
        <div className="font-display text-[14.5px] text-ink-2">Couldn’t connect.</div>
        <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.08em] mt-1">
          {error}
        </div>
      </div>
    );
  }

  const meta = STATUS_META[status];
  return (
    <div
      className={cn(
        'bg-raised border border-line rounded-md p-4 flex items-center gap-3',
        'hover:border-line-strong transition-colors duration-1 ease-observatory',
        className
      )}
      {...rest}
    >
      <div className="w-10 h-10 rounded-sm bg-softer flex items-center justify-center font-mono text-[13px] font-semibold text-ink uppercase tracking-[0.04em] shrink-0">
        {abbr}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[12.5px] font-medium text-ink truncate">{name}</div>
        <div className="text-[11.5px] text-muted truncate">
          {fmtRows(rows) != null && <>{fmtRows(rows)} rows</>}
          {fmtRows(rows) != null && syncedAt && <> · </>}
          {syncedAt && <>synced {syncedAt}</>}
          {fmtRows(rows) == null && !syncedAt && <>&nbsp;</>}
        </div>
      </div>
      <Badge variant={meta.variant} dot>{meta.label}</Badge>
    </div>
  );
}
