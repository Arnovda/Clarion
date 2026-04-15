'use client';

import NotificationBell from '../NotificationBell';
import CommandPalette from './CommandPalette';

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
  function openPalette() {
    // Dispatch Cmd+K to trigger CommandPalette
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  }

  return (
    <>
      <CommandPalette />
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

        {/* Right — search trigger + notifications */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {showSearch && (
            <button
              onClick={openPalette}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm bg-surface-container-low text-on-surface-variant/50 hover:bg-surface-container hover:text-on-surface-variant transition-all duration-200 w-56"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <span className="flex-1 text-left truncate">Search or ask...</span>
              <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant/40 font-mono flex-shrink-0">
                ⌘K
              </kbd>
            </button>
          )}
          <NotificationBell />
        </div>
      </div>
    </>
  );
}
