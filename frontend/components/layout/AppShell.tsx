'use client';

import IconRail from './IconRail';
import ContextPanel from './ContextPanel';
import TopBar from './TopBar';
import PillNav, { Pill } from './PillNav';
import { FeaturesProvider } from '@/lib/features';

interface AppShellProps {
  /** Legacy prop — ignored under Observatory chrome. Page titles live in the page body now. */
  title?: string;
  /** Legacy prop — ignored. */
  subtitle?: string;
  /** Content for the context panel (left secondary sidebar). */
  contextPanel?: React.ReactNode;
  /** Pill navigation items (rendered below the chrome when provided). */
  pills?: Pill[];
  /** Currently active pill key. */
  activePill?: string;
  /** Callback when pill changes. */
  onPillChange?: (key: string) => void;
  /** Whether to show the command-palette search trigger in the top bar. */
  showSearch?: boolean;
  /** Main content. */
  children: React.ReactNode;
}

export default function AppShell({
  contextPanel,
  pills = [],
  activePill,
  onPillChange,
  showSearch = true,
  children,
}: AppShellProps) {
  return (
    <FeaturesProvider>
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <TopBar showSearch={showSearch} />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <IconRail />
        {contextPanel && <ContextPanel>{contextPanel}</ContextPanel>}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {pills.length > 0 && activePill && onPillChange && (
            <div className="border-b border-line bg-raised px-6 py-2 shrink-0">
              <PillNav pills={pills} activePill={activePill} onChange={onPillChange} />
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col overflow-y-auto overflow-x-hidden">{children}</div>
        </div>
      </div>
    </div>
    </FeaturesProvider>
  );
}
