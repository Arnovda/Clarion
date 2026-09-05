'use client';

/**
 * The incident banner (assessment 6-4): what the operator tells every
 * customer, on every screen, from /admin/ops. Mounted by TopBar so BOTH
 * copies of the chrome carry it (the FeaturesProvider lesson).
 *
 * Polls every 60 s — a 40-minute outage announced a minute late is fine;
 * a fetch on every navigation is not. A failed fetch shows nothing (the
 * shell must never depend on this). Dismissal is per announcement id, per
 * tab, in sessionStorage: closing the tab brings it back, which is what an
 * incident notice should do.
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';

interface Announcement {
  id: number;
  message: string;
  level: 'info' | 'warning' | 'critical';
}

const DISMISS_KEY = 'clarion:announcements:dismissed';

function readDismissed(): Set<number> {
  try {
    const raw = window.sessionStorage.getItem(DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as number[]) : []);
  } catch {
    return new Set();
  }
}

export default function AnnouncementBanner() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    setDismissed(readDismissed());
    const load = async () => {
      try {
        const res = await api.get('/announcements');
        if (alive) setItems(res.data?.data?.announcements ?? []);
      } catch {
        /* the shell never depends on this */
      }
    };
    void load();
    const t = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const visible = items.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  function dismiss(id: number) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try { window.sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
  }

  return (
    <div className="shrink-0">
      {visible.map((a) => (
        <div
          key={a.id}
          role={a.level === 'critical' ? 'alert' : 'status'}
          className={cn(
            'min-h-8 border-b text-[12px] font-medium flex items-center gap-3 px-4 py-1.5',
            a.level === 'critical' && 'bg-red-100 border-red-300 text-red-900',
            a.level === 'warning' && 'bg-amber-100 border-amber-300 text-amber-900',
            a.level === 'info' && 'bg-ocean-softer border-line text-ink',
          )}
        >
          <span className="font-mono text-[10px] tracking-[0.1em] uppercase shrink-0">
            {a.level === 'critical' ? 'Incident' : a.level === 'warning' ? 'Notice' : 'Info'}
          </span>
          <span className="flex-1">{a.message}</span>
          <button
            type="button"
            onClick={() => dismiss(a.id)}
            aria-label="Dismiss for this tab"
            className="shrink-0 rounded-sm p-0.5 hover:bg-black/5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
