'use client';

/**
 * Observatory empty state — consistent card used when a page or section has no data.
 *
 * Usage:
 *   <EmptyState
 *     title="No dashboards yet"
 *     description="Describe what you want to see and AI will build it."
 *     action={{ label: 'Create one', onClick: openCreate }}
 *   />
 *
 *   // or with an href:
 *   <EmptyState action={{ label: 'Connect a source', href: '/setup' }} ... />
 *
 *   // or with custom body (e.g. a full input + chips):
 *   <EmptyState title="..." description="...">
 *     <MyCustomInputRow />
 *   </EmptyState>
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

interface EmptyStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
}

interface EmptyStateProps {
  /** Optional mono eyebrow above the title (e.g. "DASHBOARDS"). */
  eyebrow?: string;
  /** Serif display title. */
  title: string;
  /** Optional supporting paragraph. */
  description?: string;
  /** Primary call-to-action. */
  action?: EmptyStateAction;
  /** Optional secondary action (rendered side-by-side). */
  secondaryAction?: EmptyStateAction;
  /** Optional icon/glyph element rendered above the title. */
  icon?: ReactNode;
  /** Optional custom body rendered below the description (replaces action buttons). */
  children?: ReactNode;
  /** Tighter padding for inline/nested empty states. */
  compact?: boolean;
  className?: string;
}

function ActionButton({ a }: { a: EmptyStateAction }) {
  const variant = a.variant ?? 'primary';
  const cls =
    variant === 'primary'
      ? 'bg-ocean text-white hover:bg-ocean-hover border border-ocean'
      : 'bg-raised text-ink-2 border border-line hover:bg-softer hover:border-line-strong';

  const common =
    `inline-flex items-center gap-2 px-4 py-2 rounded-md text-[13px] font-medium transition-colors ${cls}`;

  if (a.href) return <Link href={a.href} className={common}>{a.label}</Link>;
  return <button type="button" onClick={a.onClick} className={common}>{a.label}</button>;
}

export default function EmptyState({
  eyebrow,
  title,
  description,
  action,
  secondaryAction,
  icon,
  children,
  compact,
  className,
}: EmptyStateProps) {
  const padding = compact ? 'py-10 px-6' : 'py-16 px-8';

  return (
    <div
      className={`bg-raised border border-line rounded-lg flex flex-col items-center justify-center text-center ${padding} ${className ?? ''}`}
    >
      {icon && (
        <div className="w-12 h-12 mb-4 rounded-md bg-softer border border-line flex items-center justify-center text-muted">
          {icon}
        </div>
      )}
      {eyebrow && (
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">{eyebrow}</p>
      )}
      <h3 className={`font-display text-ink leading-tight tracking-[-0.02em] ${compact ? 'text-[20px]' : 'text-[24px]'} mb-2`}>
        {title}
      </h3>
      {description && (
        <p className={`text-[13px] text-ink-3 leading-relaxed ${children ? 'mb-6' : action ? 'mb-5' : ''} max-w-md`}>
          {description}
        </p>
      )}

      {children}

      {!children && (action || secondaryAction) && (
        <div className="flex items-center gap-2 flex-wrap justify-center">
          {action && <ActionButton a={action} />}
          {secondaryAction && <ActionButton a={{ ...secondaryAction, variant: secondaryAction.variant ?? 'secondary' }} />}
        </div>
      )}
    </div>
  );
}
