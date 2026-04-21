'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearToken, getTokenPayload, TokenPayload } from '@/lib/auth';
import NotificationBell from './NotificationBell';
import api from '@/lib/api';
import { getOverallFreshnessStatus, getFreshnessColor, formatRelativeTime } from '@/lib/freshness';
import type { FreshnessStatus } from '@/lib/freshness';

interface FreshnessData {
  connections: Array<{ id: number; name: string; last_synced_at: string | null; last_profiled_at: string | null }>;
  products: Array<{ id: number; name: string; last_run_at: string | null }>;
}

function FreshnessDot({ status, tooltip }: { status: FreshnessStatus; tooltip: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${getFreshnessColor(status)}`}
      title={tooltip}
    />
  );
}

/**
 * Nav — slim utility bar for legacy pages that use layout.tsx + IconRail.
 * Shows only: freshness dot + notification bell + user info + sign out.
 * Navigation links are handled by the IconRail sidebar.
 */
export default function Nav() {
  const router = useRouter();
  const [payload, setPayload] = useState<TokenPayload | null>(null);
  const [freshness, setFreshness] = useState<FreshnessData | null>(null);

  useEffect(() => {
    setPayload(getTokenPayload());
    api.get('/connections/freshness').then(r => setFreshness(r.data.data)).catch(() => {});
  }, []);

  function logout() {
    clearToken();
    router.push('/');
  }

  // Compute overall freshness from all connection syncs and product runs
  const allDates = [
    ...(freshness?.connections.map(c => c.last_synced_at) ?? []),
    ...(freshness?.products.map(p => p.last_run_at) ?? []),
  ];
  const overallStatus = freshness ? getOverallFreshnessStatus(allDates) : 'unknown';

  // Find the most recent date across all sources for the tooltip
  const validDates = allDates.filter(Boolean).map(d => new Date(d!).getTime()).filter(t => !isNaN(t));
  const mostRecent = validDates.length > 0 ? new Date(Math.max(...validDates)) : null;
  const tooltip = mostRecent
    ? `Data last refreshed ${formatRelativeTime(mostRecent)}`
    : 'No data synced yet';

  return (
    <div className="flex items-center justify-end gap-3 px-5 py-2.5 bg-surface border-b border-line flex-shrink-0">
      {freshness && (
        <div className="flex items-center gap-1.5 mr-1" title={tooltip}>
          <FreshnessDot status={overallStatus} tooltip={tooltip} />
          <span className="text-[10px] text-on-surface-variant/40">
            {mostRecent ? formatRelativeTime(mostRecent) : 'never synced'}
          </span>
        </div>
      )}
      <NotificationBell />
      <Link href="/profile" className="text-label-md text-on-surface-variant hover:text-on-surface transition-colors">
        {payload?.displayName} <span className="text-on-surface-variant/40">·</span> {payload?.role}
      </Link>
      <button onClick={logout} className="text-label-md text-on-surface-variant/60 hover:text-error transition-colors">
        Sign out
      </button>
    </div>
  );
}
