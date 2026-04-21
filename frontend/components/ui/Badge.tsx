'use client';

import { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type BadgeVariant = 'ai' | 'ocean' | 'ok' | 'warn' | 'err' | 'neu';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  ai:    'bg-ai-soft text-ai',
  ocean: 'bg-ocean-soft text-ocean',
  ok:    'bg-ok-soft text-ok',
  warn:  'bg-warn-soft text-warn',
  err:   'bg-err-soft text-err',
  neu:   'bg-soft text-ink-3',
};

export function Badge({ variant = 'neu', dot, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-[9px] py-[3px] rounded-full',
        'font-mono text-[10.5px] tracking-[0.04em] font-medium uppercase',
        variantClasses[variant],
        className
      )}
      {...rest}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
