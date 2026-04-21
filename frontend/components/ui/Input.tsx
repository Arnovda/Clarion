'use client';

import { forwardRef, InputHTMLAttributes, ReactNode, useId } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className, wrapperClassName, disabled, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id ?? (label ? autoId : undefined);
  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label
          htmlFor={inputId}
          className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium"
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={cn(
          'font-sans text-[14px] px-[13px] py-[10px] rounded-sm border bg-raised text-ink',
          'outline-none transition-all duration-1 ease-observatory',
          'placeholder:text-muted-2',
          error
            ? 'border-err focus:border-err focus:shadow-[0_0_0_3px_var(--err-soft)]'
            : 'border-line focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)]',
          disabled && 'opacity-50 cursor-not-allowed bg-softer',
          className
        )}
        {...rest}
      />
      {hint && !error && (
        <span className="font-mono text-[10.5px] text-muted-2">{hint}</span>
      )}
      {error && (
        <span className="font-mono text-[10.5px] text-err">{error}</span>
      )}
    </div>
  );
});
