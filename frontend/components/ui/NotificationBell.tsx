'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface NotificationItem {
  id: string | number;
  title: ReactNode;
  body?: ReactNode;
  time?: ReactNode;
  read?: boolean;
}

export interface NotificationBellProps {
  items?: NotificationItem[];
  loading?: boolean;
  error?: ReactNode;
  onItemClick?: (item: NotificationItem) => void;
  onMarkAllRead?: () => void;
  className?: string;
}

export function NotificationBell({
  items = [],
  loading,
  error,
  onItemClick,
  onMarkAllRead,
  className,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const unread = items.filter((i) => !i.read).length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative inline-block', className)}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative inline-flex items-center justify-center w-8 h-8 rounded-sm',
          'text-ink-2 hover:bg-softer hover:text-ink transition-colors duration-1 ease-observatory',
          'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]'
        )}
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Zm4 10a2 2 0 0 0 4 0"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-err" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-[360px] max-w-[90vw] bg-raised border border-line rounded-md shadow-3 overflow-hidden z-50"
        >
          <div className="px-4 py-3 border-b border-softer flex items-center justify-between">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
              Notifications
            </div>
            {onMarkAllRead && unread > 0 && (
              <button
                type="button"
                onClick={onMarkAllRead}
                className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-6 text-center font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2">
                Loading…
              </div>
            ) : error ? (
              <div className="px-4 py-4 border-l-2 border-l-err bg-err-soft/30">
                <div className="font-display text-[15px] text-ink">Couldn’t load notifications.</div>
                <div className="font-mono text-[10.5px] text-err mt-1 uppercase tracking-[0.08em]">
                  {error}
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="font-display text-[18px] text-ink tracking-[-0.01em]">
                  Nothing new.
                </div>
                <div className="text-[12px] text-muted mt-1">You’re all caught up.</div>
              </div>
            ) : (
              <ul className="divide-y divide-softer">
                {items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      onClick={() => onItemClick?.(it)}
                      className={cn(
                        'w-full text-left px-4 py-3 flex gap-3 hover:bg-softer transition-colors duration-1',
                        !it.read && 'bg-ocean-softer/40'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-1.5 w-1.5 h-1.5 rounded-full shrink-0',
                          it.read ? 'bg-transparent border border-line' : 'bg-ocean'
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block font-sans font-medium text-[13.5px] text-ink truncate">
                          {it.title}
                        </span>
                        {it.body && (
                          <span className="block text-[12.5px] text-ink-3 mt-0.5 line-clamp-2">
                            {it.body}
                          </span>
                        )}
                        {it.time && (
                          <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2 mt-1">
                            {it.time}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
