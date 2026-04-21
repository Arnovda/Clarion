'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface JobStep {
  label: ReactNode;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface JobProgressBannerProps extends HTMLAttributes<HTMLDivElement> {
  title?: ReactNode;
  steps: JobStep[];
  progress?: number;
  onCancel?: () => void;
  error?: ReactNode;
}

function StepDot({ status }: { status: JobStep['status'] }) {
  const cls =
    status === 'done'    ? 'bg-ocean'
    : status === 'running' ? 'bg-ocean animate-pulse'
    : status === 'error' ? 'bg-err'
    : 'bg-ocean-soft';
  return <span className={cn('w-1.5 h-1.5 rounded-full', cls)} aria-hidden="true" />;
}

export function JobProgressBanner({
  title,
  steps,
  progress,
  onCancel,
  error,
  className,
  ...rest
}: JobProgressBannerProps) {
  const clamped = typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : undefined;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'bg-ocean-softer border-b border-ocean-soft',
        error && 'bg-err-soft border-b-err',
        className
      )}
      {...rest}
    >
      <div className="px-6 py-3 flex items-center gap-4 flex-wrap">
        {title && (
          <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ocean font-medium">
            {title}
          </div>
        )}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5 min-w-0">
              <StepDot status={s.status} />
              <span
                className={cn(
                  'font-mono text-[10.5px] uppercase tracking-[0.08em] truncate',
                  s.status === 'done' || s.status === 'running' ? 'text-ocean' : 'text-muted-2',
                  s.status === 'error' && 'text-err'
                )}
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-2 hover:text-ink transition-colors duration-1"
          >
            Cancel
          </button>
        )}
      </div>
      {typeof clamped === 'number' && (
        <div className="h-0.5 bg-ocean-soft">
          <div
            className={cn('h-full transition-all duration-3 ease-observatory', error ? 'bg-err' : 'bg-ocean')}
            style={{ width: `${clamped}%` }}
          />
        </div>
      )}
      {error && (
        <div className="px-6 pb-3 font-mono text-[10.5px] text-err uppercase tracking-[0.08em]">
          {error}
        </div>
      )}
    </div>
  );
}
