'use client';

import { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface OutlineItem {
  id: string;
  label: ReactNode;
  href?: string;
}

export interface OutlineGroup {
  eyebrow: ReactNode;
  items: OutlineItem[];
}

export interface OutlineRailProps {
  groups: OutlineGroup[];
  activeId?: string;
  onItemClick?: (id: string) => void;
  title?: ReactNode;
  className?: string;
  loading?: boolean;
  empty?: boolean;
  error?: ReactNode;
}

export function OutlineRail({
  groups,
  activeId,
  onItemClick,
  title = 'Outline',
  className,
  loading,
  empty,
  error,
}: OutlineRailProps) {
  return (
    <nav
      aria-label={typeof title === 'string' ? title : 'Outline'}
      className={cn('bg-raised border border-line rounded-md p-4 sticky top-20', className)}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted mb-3">
        {title}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-4 bg-softer rounded-sm animate-pulse"
              style={{ width: `${[80, 60, 70, 50][i % 4]}%` }}
            />
          ))}
        </div>
      ) : error ? (
        <div className="border-l-2 border-l-err pl-3">
          <div className="font-display text-[14px] text-ink">Outline unavailable.</div>
          <div className="font-mono text-[10px] text-err uppercase tracking-[0.08em] mt-1">
            {error}
          </div>
        </div>
      ) : empty || groups.length === 0 ? (
        <div className="font-display text-[14px] text-muted-2 italic">Nothing to outline yet.</div>
      ) : (
        <div className="space-y-4">
          {groups.map((g, gi) => (
            <div key={gi}>
              <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-muted-2 mb-0.5">
                {g.eyebrow}
              </div>
              <ul>
                {g.items.map((it) => {
                  const active = it.id === activeId;
                  const Tag: any = it.href ? 'a' : 'button';
                  return (
                    <li key={it.id}>
                      <Tag
                        {...(it.href
                          ? { href: it.href }
                          : { type: 'button', onClick: () => onItemClick?.(it.id) })}
                        className={cn(
                          'block w-full text-left py-1.5 px-2.5 text-[12px] border-l-2 -ml-0.5',
                          'transition-colors duration-1 ease-observatory',
                          active
                            ? 'border-ocean text-ocean font-medium'
                            : 'border-softer text-ink-2 hover:border-line-strong hover:text-ocean'
                        )}
                      >
                        {it.label}
                      </Tag>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
