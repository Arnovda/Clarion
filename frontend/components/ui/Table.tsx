'use client';

import { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Table({ className, children, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn('w-full border-collapse text-[13px]', className)} {...rest}>
      {children}
    </table>
  );
}

export function THead({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...rest}>{children}</thead>;
}

export function TBody({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...rest}>{children}</tbody>;
}

export function Tr({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('hover:bg-softer transition-colors duration-1 ease-observatory', className)} {...rest}>
      {children}
    </tr>
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function Th({ className, numeric, children, ...rest }: ThProps) {
  return (
    <th
      className={cn(
        'font-mono text-[10px] uppercase tracking-[0.08em] text-muted font-medium',
        'px-3 py-2 border-b border-line bg-softer',
        numeric ? 'text-right' : 'text-left',
        className
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export function Td({ className, numeric, children, ...rest }: TdProps) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 border-b border-softer',
        numeric
          ? 'text-right font-mono tabular-nums text-ink'
          : 'text-ink-2',
        className
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
