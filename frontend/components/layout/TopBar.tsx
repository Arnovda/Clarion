'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import NotificationBell from '../NotificationBell';

interface TopBarProps {
  /** Page title displayed on the left */
  title: string;
  /** Optional subtitle below the title */
  subtitle?: string;
  /** Center content (typically PillNav) */
  children?: React.ReactNode;
  /** Whether to show the global search bar (default: true) */
  showSearch?: boolean;
}

export default function TopBar({ title, subtitle, children, showSearch = true }: TopBarProps) {
  const router = useRouter();
  const [searchValue, setSearchValue] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (searchValue.trim()) {
      router.push(`/ask?q=${encodeURIComponent(searchValue.trim())}`);
      setSearchValue('');
    }
  }

  return (
    <div className="flex items-center gap-4 px-6 py-3 bg-surface ghost-border-b flex-shrink-0">
      {/* Left — title */}
      <div className="flex-shrink-0 min-w-0">
        <h1 className="font-headline text-headline-sm font-bold text-on-surface truncate">{title}</h1>
        {subtitle && <p className="text-label-md text-on-surface-variant truncate">{subtitle}</p>}
      </div>

      {/* Center — pills or custom content */}
      <div className="flex-1 flex items-center justify-center">
        {children}
      </div>

      {/* Right — search + notifications */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {showSearch && (
          <form onSubmit={handleSearchSubmit} className="relative">
            <input
              type="text"
              placeholder="Ask your data anything..."
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              className={`
                w-56 px-3 py-1.5 rounded-lg text-body-sm
                bg-surface-container-low text-on-surface
                placeholder:text-on-surface-variant/50
                focus:outline-none transition-all duration-200
                ${searchFocused ? 'w-72 shadow-glow-teal ring-1 ring-cyan-400/30' : 'hover:bg-surface-container'}
              `}
            />
            <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
          </form>
        )}
        <NotificationBell />
      </div>
    </div>
  );
}
