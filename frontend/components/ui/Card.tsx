'use client';

import { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type CardVariant = 'default' | 'raised' | 'outlined';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padded?: boolean;
}

const variantClasses: Record<CardVariant, string> = {
  default:  'bg-raised border border-line rounded-md shadow-1',
  raised:   'bg-raised rounded-lg shadow-2',
  outlined: 'bg-transparent border border-line rounded-md',
};

export function Card({ variant = 'default', padded = true, className, children, ...rest }: CardProps) {
  return (
    <div className={cn(variantClasses[variant], padded && 'p-5', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-5 py-4 border-b border-softer', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('p-5', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-5 py-4 border-t border-softer', className)} {...rest}>
      {children}
    </div>
  );
}
