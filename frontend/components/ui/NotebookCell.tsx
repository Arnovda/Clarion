'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type NotebookCellType =
  | 'ask'
  | 'sql'
  | 'chart'
  | 'kpi'
  | 'md'
  | 'table'
  | 'filter'
  | 'python';

const TYPE_PILL: Record<NotebookCellType, string> = {
  ask:    'bg-ai-soft text-ai',
  sql:    'bg-softer text-ink-2',
  chart:  'bg-ocean-softer text-ocean',
  kpi:    'bg-ocean-softer text-ocean',
  md:     'bg-softer text-ink-3',
  table:  'bg-softer text-ink-2',
  filter: 'bg-softer text-ink-2',
  python: 'bg-softer text-ink-2',
};

export interface NotebookCellProps extends HTMLAttributes<HTMLDivElement> {
  index: number;
  cellType: NotebookCellType;
  runtime?: ReactNode;
  active?: boolean;
  onRerun?: () => void;
  onMenu?: () => void;
}

export function NotebookCell({
  index,
  cellType,
  runtime,
  active,
  onRerun,
  onMenu,
  className,
  children,
  ...rest
}: NotebookCellProps) {
  return (
    <div
      data-active={active ? '' : undefined}
      className={cn('group relative py-3.5 rounded-sm', className)}
      {...rest}
    >
      <div
        className={cn(
          'absolute -left-4 top-3.5 bottom-3.5 w-0.5 rounded-sm transition-colors duration-1 ease-observatory',
          active ? 'bg-ocean' : 'bg-transparent group-hover:bg-line'
        )}
        aria-hidden="true"
      />
      <div className="flex items-center gap-2.5 mb-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
        <span className="text-muted-2 tabular-nums">{String(index + 1).padStart(2, '0')}</span>
        <span className={cn('px-1.5 py-0.5 rounded', TYPE_PILL[cellType])}>{cellType}</span>
        {runtime && (
          <span className="px-1.5 py-0.5 rounded-full bg-ok-soft text-ok">{runtime}</span>
        )}
        <span className="flex-1" aria-hidden="true" />
        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            className="px-1.5 text-muted-2 hover:text-ink transition-colors duration-1"
          >
            Re-run
          </button>
        )}
        {onMenu && (
          <button
            type="button"
            onClick={onMenu}
            aria-label="Cell menu"
            className="px-1.5 text-muted-2 hover:text-ink transition-colors duration-1"
          >
            ⋯
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export interface AddCellMenuProps {
  onAdd?: (type: NotebookCellType) => void;
  types?: NotebookCellType[];
  className?: string;
}

export function AddCellMenu({
  onAdd,
  types = ['ask', 'sql', 'chart', 'kpi', 'md', 'table', 'filter', 'python'],
  className,
}: AddCellMenuProps) {
  return (
    <div className={cn('flex justify-center flex-wrap gap-1.5 py-3', className)}>
      {types.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onAdd?.(t)}
          className={cn(
            'px-2 py-0.5 rounded font-mono text-[10px] uppercase tracking-[0.08em]',
            'text-muted-2 bg-transparent hover:text-ink hover:bg-softer',
            'transition-colors duration-1 ease-observatory'
          )}
        >
          + {t}
        </button>
      ))}
    </div>
  );
}
