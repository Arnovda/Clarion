'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';

interface Notification {
  id: number;
  type: string;
  title: string;
  message: string | null;
  entity_type: string | null;
  entity_id: number | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await api.get('/notifications?limit=20');
      setNotifications(res.data.data ?? []);
      setUnreadCount(res.data.unreadCount ?? 0);
    } catch { /* ignore */ }
  }, []);

  // Fetch on mount + poll every 30s
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Close dropdown on outside click + ESC
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false);
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

  async function markRead(id: number) {
    await api.put(`/notifications/${id}/read`);
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
    setUnreadCount((c) => Math.max(0, c - 1));
  }

  async function markAllRead() {
    await api.put('/notifications/read-all');
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  }

  function handleClick(n: Notification) {
    if (!n.read) markRead(n.id);
    if (n.link) {
      router.push(n.link);
      setOpen(false);
    }
  }

  return (
    <div ref={dropdownRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        aria-expanded={open}
        className={cn(
          'relative inline-flex items-center justify-center w-8 h-8 rounded-sm',
          'text-muted hover:bg-soft hover:text-ink transition-colors duration-1 ease-observatory',
          'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]'
        )}
      >
        <Bell className="w-4 h-4" strokeWidth={1.5} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-ai" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-[360px] max-w-[92vw] bg-raised border border-line rounded-md shadow-3 overflow-hidden z-50"
        >
          <div className="px-4 py-3 border-b border-softer flex items-center justify-between">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium">
              Notifications
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors duration-1"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="font-display text-[18px] text-ink tracking-[-0.01em]">
                  Nothing new.
                </div>
                <div className="text-[12px] text-muted mt-1">You&rsquo;re all caught up.</div>
              </div>
            ) : (
              <ul className="divide-y divide-softer">
                {notifications.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => handleClick(n)}
                      className={cn(
                        'w-full text-left px-4 py-3 flex gap-3 transition-colors duration-1 ease-observatory',
                        'hover:bg-softer',
                        !n.read && 'bg-ocean-softer/40'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-1.5 w-1.5 h-1.5 rounded-full shrink-0',
                          n.read ? 'border border-line bg-transparent' : 'bg-ocean'
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex-1 min-w-0">
                        <span className={cn(
                          'block font-sans text-[13.5px] truncate',
                          !n.read ? 'font-medium text-ink' : 'text-ink-2'
                        )}>
                          {n.title}
                        </span>
                        {n.message && (
                          <span className="block text-[12.5px] text-ink-3 mt-0.5 line-clamp-2">
                            {n.message}
                          </span>
                        )}
                        <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2 mt-1">
                          {timeAgo(n.created_at)}
                        </span>
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
