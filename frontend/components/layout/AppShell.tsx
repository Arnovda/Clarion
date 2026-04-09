'use client';

import IconRail from './IconRail';
import ContextPanel from './ContextPanel';
import TopBar from './TopBar';
import PillNav, { Pill } from './PillNav';

interface AppShellProps {
  /** Page title for the top bar */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Content for the context panel (left sidebar) */
  contextPanel?: React.ReactNode;
  /** Pill navigation items */
  pills?: Pill[];
  /** Currently active pill key */
  activePill?: string;
  /** Callback when pill changes */
  onPillChange?: (key: string) => void;
  /** Whether to show the global search bar (default: true) */
  showSearch?: boolean;
  /** Main content */
  children: React.ReactNode;
}

export default function AppShell({
  title,
  subtitle,
  contextPanel,
  pills = [],
  activePill,
  onPillChange,
  showSearch = true,
  children,
}: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      {/* Panel 1: Icon Rail (48px, always visible) */}
      <IconRail />

      {/* Panel 2: Context Panel (240px, resizable, collapsible) */}
      {contextPanel && (
        <ContextPanel>
          {contextPanel}
        </ContextPanel>
      )}

      {/* Panel 3: Main Content (remaining width) */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar with title, pills, search, notifications */}
        <TopBar title={title} subtitle={subtitle} showSearch={showSearch}>
          {pills.length > 0 && activePill && onPillChange && (
            <PillNav pills={pills} activePill={activePill} onChange={onPillChange} />
          )}
        </TopBar>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
