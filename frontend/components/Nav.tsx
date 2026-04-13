'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearToken, getTokenPayload, TokenPayload } from '@/lib/auth';
import NotificationBell from './NotificationBell';

/**
 * Nav — slim utility bar for legacy pages that use layout.tsx + IconRail.
 * Shows only: notification bell + user info + sign out.
 * Navigation links are handled by the IconRail sidebar.
 */
export default function Nav() {
  const router = useRouter();
  const [payload, setPayload] = useState<TokenPayload | null>(null);

  useEffect(() => {
    setPayload(getTokenPayload());
  }, []);

  function logout() {
    clearToken();
    router.push('/');
  }

  return (
    <div className="flex items-center justify-end gap-3 px-5 py-2.5 bg-surface ghost-border-b flex-shrink-0">
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
