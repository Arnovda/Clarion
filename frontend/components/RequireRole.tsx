'use client';

/**
 * Consistent role gate for pages.
 *
 * Usage:
 *   <RequireRole roles={['admin']}>
 *     <PageContent />
 *   </RequireRole>
 *
 * Replaces ad-hoc `if (!isAdmin()) router.push('/query')` patterns scattered
 * across admin pages. Shows a proper "not authorized" card instead of a
 * disruptive push when the user lands on a page they can't access.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getTokenPayload } from '@/lib/auth';

type Role = 'admin' | 'analyst' | 'viewer';

interface RequireRoleProps {
  roles: Role[];
  children: React.ReactNode;
  /** Optional render override for the unauthorized state. */
  fallback?: React.ReactNode;
}

export default function RequireRole({ roles, children, fallback }: RequireRoleProps) {
  const [state, setState] = useState<'checking' | 'allowed' | 'denied'>('checking');

  useEffect(() => {
    const payload = getTokenPayload();
    if (!payload) {
      setState('denied');
      return;
    }
    setState(roles.includes(payload.role) ? 'allowed' : 'denied');
  }, [roles]);

  if (state === 'checking') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state === 'denied') {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="bg-raised border border-line rounded-lg p-10 max-w-md text-center">
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Restricted</p>
          <h1 className="font-display text-[26px] text-ink leading-tight tracking-[-0.02em] mb-3">
            You don&rsquo;t have access to this page.
          </h1>
          <p className="text-[13px] text-ink-3 leading-relaxed mb-6">
            This area is available to{' '}
            {roles.length === 1 ? roles[0] : roles.slice(0, -1).join(', ') + ' and ' + roles[roles.length - 1]}
            {' '}roles only. If you think this is a mistake, ask your workspace admin.
          </p>
          <Link
            href="/query"
            className="inline-flex px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover transition-colors"
          >
            Back to Ask
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
