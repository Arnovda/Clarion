'use client';

import { forwardRef, SelectHTMLAttributes, ReactNode, useId } from 'react';
import { cn } from '@/lib/cn';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, wrapperClassName, disabled, children, ...rest },
  ref
) {
  const autoId = useId();
  const selId = id ?? (label ? autoId : undefined);
  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label
          htmlFor={selId}
          className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          id={selId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className={cn(
            'w-full appearance-none font-sans text-[14px] pl-[13px] pr-9 py-[10px] rounded-sm border bg-raised text-ink',
            'outline-none transition-all duration-1 ease-observatory cursor-pointer',
            error
              ? 'border-err focus:border-err focus:shadow-[0_0_0_3px_var(--err-soft)]'
              : 'border-line focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)]',
            disabled && 'opacity-50 cursor-not-allowed bg-softer',
            className
          )}
          {...rest}
        >
          {children}
        </select>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
          width={14} height={14} viewBox="0 0 20 20" fill="none"
        >
          <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {hint && !error && (
        <span className="font-mono text-[10.5px] text-muted-2">{hint}</span>
      )}
      {error && (
        <span className="font-mono text-[10.5px] text-err">{error}</span>
      )}
    </div>
  );
});
