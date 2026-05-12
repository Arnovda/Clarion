'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { clearToken, getRefreshToken, getTokenPayload, TokenPayload } from '@/lib/auth';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import NotificationBell from '../NotificationBell';
import CommandPalette from './CommandPalette';

interface TopBarProps {
  /** Legacy prop — ignored under Observatory chrome (page title lives in the page body header). */
  title?: string;
  /** Legacy prop — ignored. */
  subtitle?: string;
  /** Legacy prop — the children slot used to host PillNav. Observatory chrome renders nothing here. */
  children?: React.ReactNode;
  /** Whether to show the command-palette search trigger (default: true). */
  showSearch?: boolean;
}

function initialsOf(name?: string, email?: string): string {
  const source = (name || email || '').trim();
  if (!source) return 'U';
  const parts = source.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return (first + second).toUpperCase().slice(0, 2) || 'U';
}

export default function TopBar({ showSearch = true }: TopBarProps) {
  const router = useRouter();
  const [payload, setPayload] = useState<TokenPayload | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPayload(getTokenPayload());
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function openPalette() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  }

  async function signOut() {
    sessionStorage.removeItem('clarion_tenant_name');
    // Revoke the refresh token server-side so logout actually invalidates
    // the session everywhere (not just clearing it from this browser).
    // Best-effort — if the API call fails, we still clear locally.
    try {
      const refreshToken = getRefreshToken();
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken });
      }
    } catch {
      // Network blip / already-revoked / etc — ignore.
    }
    clearToken();
    router.push('/');
  }


  const initials = initialsOf(payload?.displayName, payload?.email);

  return (
    <>
      <CommandPalette />
      <header className="h-12 bg-raised border-b border-line flex items-center gap-3 px-4 shrink-0">
        {/* Wordmark */}
        <Link href="/query" className="flex items-center gap-[9px] font-display font-medium text-[17px] tracking-[-0.02em] text-ink leading-none">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ocean">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="12" cy="12" r="0.6" fill="currentColor" />
          </svg>
          <span>Clarion</span>
        </Link>

        <div className="flex-1" />

        {/* Search trigger */}
        {showSearch && (
          <button
            type="button"
            onClick={openPalette}
            aria-label="Search (Cmd+K)"
            className={cn(
              'hidden md:flex items-center gap-2 px-3 h-8 rounded-sm border border-line bg-surface',
              'text-[12.5px] text-muted',
              'hover:border-line-strong hover:bg-softer transition-colors duration-1 ease-observatory',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]'
            )}
          >
            <Search className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
            <span className="w-40 text-left truncate">Search or ask…</span>
            <kbd className="font-mono text-[10px] tracking-[0.04em] text-muted-2">⌘K</kbd>
          </button>
        )}

        <NotificationBell />

        {/* Avatar */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={`Account menu for ${payload?.displayName ?? 'you'}`}
            aria-expanded={menuOpen}
            className={cn(
              'w-[26px] h-[26px] rounded-full bg-ocean-softer text-ocean font-sans font-semibold text-[11px]',
              'flex items-center justify-center uppercase tracking-[0.02em]',
              'hover:bg-ocean-soft transition-colors duration-1 ease-observatory',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]'
            )}
          >
            {initials}
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-56 bg-raised border border-line rounded-md shadow-3 py-1.5 z-50"
            >
              {payload && (
                <div className="px-3 pt-2 pb-2.5 border-b border-softer">
                  <div className="font-sans font-medium text-[13.5px] text-ink truncate">
                    {payload.displayName || 'Account'}
                  </div>
                  <div className="font-mono text-[10.5px] text-muted tracking-[0.04em] mt-0.5 truncate">
                    {payload.email}
                  </div>
                </div>
              )}
              <Link
                href="/profile"
                onClick={() => setMenuOpen(false)}
                className="block px-3 py-2 text-[13px] text-ink-2 hover:bg-softer hover:text-ink transition-colors duration-1"
                role="menuitem"
              >
                Profile
              </Link>
              <button
                type="button"
                onClick={signOut}
                className="w-full text-left px-3 py-2 text-[13px] text-err hover:bg-err-soft/50 transition-colors duration-1"
                role="menuitem"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
    </>
  );
}
