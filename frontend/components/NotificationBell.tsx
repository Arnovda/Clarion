'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

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

const TYPE_ICONS: Record<string, string> = {
  job_complete: '⚙',
  quality_alert: '⚠',
  new_gap: '?',
  invite_accepted: '👤',
  approval: '✓',
};

const TYPE_COLORS: Record<string, string> = {
  job_complete: 'text-blue-500',
  quality_alert: 'text-amber-500',
  new_gap: 'text-purple-500',
  invite_accepted: 'text-green-500',
  approval: 'text-emerald-500',
};

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

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
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
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
        title="Notifications"
      >
        {/* Bell icon */}
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-lg border border-slate-200 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <span className="text-sm font-semibold text-slate-800">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-slate-50 ${
                    !n.read ? 'bg-blue-50/40' : ''
                  }`}
                >
                  <span className={`text-base flex-shrink-0 mt-0.5 ${TYPE_COLORS[n.type] ?? 'text-slate-400'}`}>
                    {TYPE_ICONS[n.type] ?? '•'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-tight ${!n.read ? 'font-medium text-slate-800' : 'text-slate-600'}`}>
                      {n.title}
                    </p>
                    {n.message && (
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{n.message}</p>
                    )}
                    <p className="text-xs text-slate-300 mt-1">{timeAgo(n.created_at)}</p>
                  </div>
                  {!n.read && (
                    <span className="flex-shrink-0 w-2 h-2 rounded-full bg-blue-500 mt-1.5" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
