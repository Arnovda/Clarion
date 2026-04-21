'use client';

import { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  'aria-label'?: string;
}

export function Tabs({ items, value, onChange, className, ...rest }: TabsProps) {
  return (
    <div
      role="tablist"
      aria-label={rest['aria-label']}
      className={cn('flex gap-1 border-b border-line', className)}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={it.disabled}
            onClick={() => onChange(it.value)}
            className={cn(
              'px-4 py-2.5 text-[13px] border-b-2 -mb-px transition-colors duration-1 ease-observatory',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]',
              active
                ? 'text-ocean border-ocean font-medium'
                : 'text-muted border-transparent hover:text-ink',
              it.disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
