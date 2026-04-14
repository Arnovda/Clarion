'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearToken, getTokenPayload, TokenPayload } from '@/lib/auth';

/* ── Icon SVGs (inline for zero-dependency, 20x20) ──────────────────── */

function IconChat({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconDashboard({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function IconBook({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function IconHeart({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function IconStar({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
function IconPlug({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
      <path d="M8 12h8" /><path d="M12 8v8" />
    </svg>
  );
}
function IconInbox({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function IconUsers({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconSettings({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/* ── Nav items ───────────────────────────────────────────────────────── */

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Array<'admin' | 'analyst' | 'viewer'>;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'ask',        href: '/query',      label: 'Ask',            icon: IconChat,      roles: ['admin', 'analyst', 'viewer'] },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards',     icon: IconDashboard, roles: ['admin', 'analyst', 'viewer'] },
  { key: 'dictionary', href: '/semantic',   label: 'Data Dictionary', icon: IconBook,      roles: ['admin', 'analyst'] },
  { key: 'health',     href: '/health',     label: 'Data Health',    icon: IconHeart,     roles: ['admin', 'analyst'] },
  { key: 'products',   href: '/products',   label: 'Data Products',  icon: IconStar,      roles: ['admin'] },
  { key: 'connect',    href: '/setup',      label: 'Connect',        icon: IconPlug,      roles: ['admin'] },
  { key: 'review',     href: '/gaps',       label: 'Review Queue',   icon: IconInbox,     roles: ['admin'] },
  { key: 'team',       href: '/users',      label: 'Team',           icon: IconUsers,      roles: ['admin'] },
];

/* ── Component ───────────────────────────────────────────────────────── */

export default function IconRail() {
  const pathname = usePathname();
  const router = useRouter();
  const [payload, setPayload] = useState<TokenPayload | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);

  useEffect(() => {
    setPayload(getTokenPayload());
  }, []);

  const role = payload?.role ?? 'viewer';

  const visibleItems = NAV_ITEMS.filter((item) => item.roles.includes(role as 'admin' | 'analyst' | 'viewer'));

  // Match both old and new URLs during migration
  const ROUTE_ALIASES: Record<string, string[]> = {
    '/query':    ['/query', '/ask'],
    '/semantic': ['/semantic', '/dictionary'],
    '/setup':    ['/setup', '/connect'],
    '/gaps':     ['/gaps', '/review'],
    '/users':    ['/users', '/team'],
    '/health':   ['/health'],
  };

  function isActive(href: string) {
    const aliases = ROUTE_ALIASES[href] ?? [href];
    return aliases.some((a) => pathname === a || pathname.startsWith(a + '/'));
  }

  function logout() {
    clearToken();
    router.push('/');
  }

  return (
    <div className="w-[200px] min-w-[200px] h-screen flex flex-col bg-primary py-4 px-3 flex-shrink-0 relative">
      {/* Logo */}
      <Link href="/ask" className="mb-6 flex items-center gap-2.5 px-2">
        <span className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center text-white font-headline font-bold text-lg flex-shrink-0">D</span>
        <span className="text-white font-headline font-semibold text-sm tracking-tight">DataBridge</span>
      </Link>

      {/* Main nav */}
      <nav className="flex-1 flex flex-col gap-0.5 w-full">
        {visibleItems.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`
                relative w-full flex items-center gap-3 h-10 px-2.5 rounded-lg
                transition-all duration-200
                ${active
                  ? 'text-white bg-white/12'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                }
              `}
            >
              {/* Active indicator — teal left border */}
              {active && (
                <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-cyan-400" />
              )}
              <item.icon className="w-5 h-5 flex-shrink-0" />
              <span className="text-[13px] font-medium truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div className="flex flex-col gap-0.5 w-full pt-4 border-t border-white/10">
        <Link
          href="/profile"
          className="w-full flex items-center gap-3 h-10 px-2.5 rounded-lg text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors"
        >
          <IconSettings className="w-5 h-5 flex-shrink-0" />
          <span className="text-[13px] font-medium">Settings</span>
        </Link>

        {/* User avatar + name */}
        <button
          onClick={() => setShowUserMenu(!showUserMenu)}
          className="w-full flex items-center gap-3 h-10 px-2.5 rounded-lg text-white/60 hover:text-white/90 hover:bg-white/5 transition-colors"
        >
          <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-white text-[11px] font-semibold flex-shrink-0">
            {(payload?.displayName ?? 'U').charAt(0).toUpperCase()}
          </div>
          <span className="text-[13px] font-medium truncate">{payload?.displayName ?? 'Profile'}</span>
        </button>
      </div>

      {/* User dropdown menu */}
      {showUserMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
          <div className="absolute bottom-4 left-full ml-2 z-50 bg-surface-container-lowest rounded-xl shadow-ambient py-2 min-w-[180px] animate-fadeIn">
            <div className="px-4 py-2 border-b border-outline-variant/15">
              <div className="text-body-sm font-semibold text-on-surface">{payload?.displayName}</div>
              <div className="text-label-sm text-on-surface-variant">{payload?.email}</div>
            </div>
            <Link
              href="/profile"
              onClick={() => setShowUserMenu(false)}
              className="block px-4 py-2 text-body-sm text-on-surface hover:bg-surface-container-low transition-colors"
            >
              Profile
            </Link>
            <button
              onClick={logout}
              className="w-full text-left px-4 py-2 text-body-sm text-error hover:bg-error-container/30 transition-colors"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
