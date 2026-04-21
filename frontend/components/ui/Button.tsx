'use client';

import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:   'bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover',
  secondary: 'bg-raised text-ink border-line hover:border-line-strong hover:bg-softer',
  ghost:     'bg-transparent text-ink-2 border-transparent hover:bg-soft',
  danger:    'bg-err text-white border-err hover:opacity-90',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-[6px] text-[12.5px]',
  md: 'px-4 py-[9px] text-[13.5px]',
  lg: 'px-[22px] py-[12px] text-[14.5px]',
};

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, disabled, className, children, ...rest },
  ref
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-sans font-medium leading-none',
        'rounded-sm border transition-all duration-1 ease-observatory',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]',
        isDisabled && 'opacity-50 cursor-not-allowed',
        sizeClasses[size],
        variantClasses[variant],
        className
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});
