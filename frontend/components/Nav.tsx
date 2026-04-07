'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { clearToken, getTokenPayload, TokenPayload } from '@/lib/auth';
import NotificationBell from './NotificationBell';

export default function Nav() {
  const router   = useRouter();
  const pathname = usePathname();
  const [payload, setPayload] = useState<TokenPayload | null>(null);

  // Read localStorage only after mount — avoids SSR/client hydration mismatch
  useEffect(() => {
    setPayload(getTokenPayload());
  }, []);

  const isAdmin = payload?.role === 'admin';

  function logout() {
    clearToken();
    router.push('/');
  }

  const link = (href: string, label: string) => (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
        pathname.startsWith(href)
          ? 'bg-blue-100 text-blue-700'
          : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <nav className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <Image src="/logo.svg" alt="DataBridge" width={110} height={25} priority />
        <div className="flex gap-1">
          {isAdmin && link('/setup',       'Sources')}
          {isAdmin && link('/semantic',    'Source Semantics')}
          {isAdmin && link('/products',    'Product Semantics')}
          {link('/query',      'Ask')}
          {link('/dashboards', 'Dashboards')}
          {isAdmin && link('/gaps', 'Gaps')}
          {isAdmin && link('/users', 'Team')}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <NotificationBell />
        <Link href="/profile" className="text-xs text-slate-400 hover:text-slate-600">
          {payload?.displayName} · {payload?.role}
        </Link>
        <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-800">Sign out</button>
      </div>
    </nav>
  );
}
