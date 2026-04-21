'use client';

import { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
}

export interface PageHeaderProps {
  /** Mono eyebrow above the title (e.g. "Q3 BRIEFING"). */
  eyebrow?: ReactNode;
  /** Serif H1. Pass JSX with `<em>` for italic accents. */
  title: ReactNode;
  /** Short supporting copy under the title. Max ~540px readable width. */
  lede?: ReactNode;
  /** Right-aligned action slot. */
  actions?: ReactNode;
  /** Optional crumb trail above the eyebrow. */
  crumbs?: BreadcrumbItem[];
  /** Heading level to use (1–3). Default 1. */
  level?: 1 | 2 | 3;
  className?: string;
}

const titleSizeByLevel: Record<NonNullable<PageHeaderProps['level']>, string> = {
  1: 'text-[38px] leading-[1.05] tracking-[-0.025em]',
  2: 'text-[28px] leading-[1.15] tracking-[-0.02em]',
  3: 'text-[20px] leading-[1.25] tracking-[-0.01em]',
};

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
  crumbs,
  level = 1,
  className,
}: PageHeaderProps) {
  const Heading: 'h1' | 'h2' | 'h3' = (`h${level}` as const);

  return (
    <header className={cn('mb-7', className)}>
      {crumbs && crumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="mb-3.5 flex items-center gap-2 font-mono text-[12.5px] tracking-[0.04em] text-muted"
        >
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={i} className="flex items-center gap-2">
                {c.href && !isLast ? (
                  <a href={c.href} className="hover:text-ink transition-colors duration-1">
                    {c.label}
                  </a>
                ) : (
                  <span className={isLast ? 'text-ink-2' : ''}>{c.label}</span>
                )}
                {!isLast && <span className="text-line-strong" aria-hidden="true">/</span>}
              </span>
            );
          })}
        </nav>
      )}

      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {eyebrow && (
            <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium mb-2">
              {eyebrow}
            </div>
          )}
          <Heading
            className={cn(
              'font-display font-medium text-ink m-0',
              titleSizeByLevel[level],
              '[&_em]:italic [&_em]:font-normal [&_em]:text-ink-2'
            )}
          >
            {title}
          </Heading>
          {lede && (
            <p className="mt-2 text-[14px] leading-[1.55] text-muted max-w-[540px]">{lede}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2.5 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
