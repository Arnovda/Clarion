'use client';

import { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SkeletonText } from './Skeleton';

export interface AIResponseBlockProps extends HTMLAttributes<HTMLDivElement> {
  body?: ReactNode;
  confidence?: number;
  sources?: string[];
  onShowSQL?: () => void;
  onPin?: () => void;
  loading?: boolean;
  error?: ReactNode;
  empty?: boolean;
}

export function AIResponseBlock({
  body,
  confidence,
  sources = [],
  onShowSQL,
  onPin,
  loading,
  error,
  empty,
  className,
  ...rest
}: AIResponseBlockProps) {
  return (
    <div
      className={cn(
        'bg-surface border border-softer border-l-2 border-l-ai rounded-sm px-5 py-4',
        className
      )}
      {...rest}
    >
      {loading ? (
        <SkeletonText lines={3} />
      ) : error ? (
        <div className="font-display text-[16px] leading-[1.55] text-ink">
          I couldn’t answer that. <span className="text-err">{error}</span>
        </div>
      ) : empty ? (
        <div className="font-display text-[16px] leading-[1.55] text-muted-2 italic">
          No answer yet.
        </div>
      ) : (
        <div className="font-display text-[16px] leading-[1.55] text-ink">{body}</div>
      )}

      {!loading && !empty && (
        <div className="mt-3 pt-2.5 border-t border-softer flex flex-wrap items-center gap-3 font-mono text-[10px] tracking-[0.06em] text-muted uppercase">
          {typeof confidence === 'number' && (
            <span>
              {Math.round(confidence * 100)}% · {sources.length} {sources.length === 1 ? 'source' : 'sources'}
            </span>
          )}
          {sources.length > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="flex flex-wrap gap-1.5">
                {sources.map((s) => (
                  <span
                    key={s}
                    className="px-1.5 py-0.5 rounded bg-softer text-ink-3 normal-case tracking-normal"
                  >
                    {s}
                  </span>
                ))}
              </span>
            </>
          )}
          {(onShowSQL || onPin) && <span className="flex-1" aria-hidden="true" />}
          {onShowSQL && (
            <button
              type="button"
              onClick={onShowSQL}
              className="text-ink-2 underline decoration-line-strong hover:text-ink transition-colors duration-1"
            >
              show SQL
            </button>
          )}
          {onPin && (
            <button
              type="button"
              onClick={onPin}
              className="text-ink-2 underline decoration-line-strong hover:text-ink transition-colors duration-1"
            >
              pin
            </button>
          )}
        </div>
      )}
    </div>
  );
}
